# Backend — Servidor Hub, Banco de Dados e APIs

> Documento gerado a partir da leitura do código real em `server/` e `src/api.ts`.
> Base: MVP de visão computacional (frontend React/Vite + servidor Node "hub").
> Trechos referenciados no formato `arquivo:linha`.

---

## 1. Visão geral — o papel do servidor hub

O backend é um **hub de câmeras** em Node.js puro (sem framework HTTP; usa `node:http` cru + `socket.io`). Sua descrição própria resume bem a intenção (`server/index.js:1-2`):

> "Hub de câmeras — relé de frames câmera → dashboard via socket.io. Não processa nem armazena vídeo: apenas registra câmeras conectadas e repassa frames."

Responsabilidades concentradas no hub:

1. **Relé de vídeo em tempo real** — recebe frames JPEG das câmeras (navegador ou RTSP) via socket.io e os repassa aos dashboards conectados. Nunca grava vídeo/imagem (decisão de LGPD — só indicadores agregados).
2. **API HTTP** (`/api/...`) — login, perfil, gestão de usuários, destinatários de WhatsApp, configuração de notificações, status do WhatsApp e **histórico/indicadores** persistidos no Postgres.
3. **Persistência de indicadores** no Postgres (com fallback para arquivos JSON quando o Postgres não está configurado).
4. **Notificações** — webhook "andon" (`alerts.js`) e WhatsApp (`whatsapp.js` via Baileys), orquestrados pelo `dispatch.js`.
5. **Ingestão RTSP** — câmeras IP convertidas em frames JPEG por `ffmpeg` e tratadas como câmeras comuns (`rtsp.js`).

### Topologia (dev vs produção)

- **Porta/host**: `PORT` (default `4000`) e `HOST` (default `0.0.0.0`) — `server/index.js:15-18`.
  - Dev: `0.0.0.0` para o celular alcançar o IP do laptop.
  - Produção: recomenda-se `HOST=127.0.0.1` atrás do Caddy/nginx (reverse proxy que faz proxy de `/api/` e `/socket.io/` → hub) — `server/index.js:16-21`.
- **CORS** liberado (`Access-Control-Allow-Origin: *`) para o cenário cross-origin de desenvolvimento; em produção é same-origin via nginx — `server/index.js:43-46`.
- O `socket.io` é anexado ao mesmo `httpServer`; ele intercepta `/socket.io/` e as demais rotas caem no handler HTTP — `server/index.js:20-21`, `server/index.js:146`.

### Bootstrap (ordem de inicialização)

`server/index.js:212-223` — antes de aceitar conexões:

1. `db.init()` — garante o schema do Postgres (idempotente).
2. `Promise.all([users.init(), recipients.init(), settings.init()])` — carrega os caches em memória (para `verifyToken`/`login` serem síncronos e rápidos).
3. `httpServer.listen(PORT, HOST, ...)`.
4. `whatsapp.init()` e `startRtspIngestion(...)`.

### Dependências (`server/package.json`)

| Pacote | Uso |
|---|---|
| `socket.io` ^4.8.3 | Relé de frames e eventos em tempo real |
| `pg` ^8.21.0 | Cliente Postgres (histórico/indicadores e cadastros) |
| `@whiskeysockets/baileys` ^6.7.0 | Canal WhatsApp não-oficial (WhatsApp Web) |
| `qrcode` ^1.5.4 | Gera o QR de pareamento do WhatsApp como data URL |
| `pino` ^9.5.0 | Logger (silenciado) do Baileys |

Scripts: `start` = `node index.js`; `dev` = `node --watch index.js` (`server/package.json:7-10`).
Node 18 não tem `globalThis.crypto` global — `whatsapp.js:9` faz o polyfill com `node:crypto`.webcrypto.

---

## 2. Autenticação e autorização (no backend)

A autenticação é caseira, baseada em **token HMAC assinado** + senha com **scrypt**. Toda a lógica está em `server/users.js`.

### Senhas (scrypt)

- Formato armazenado: `scrypt$<salt>$<derivedKey>` — `server/users.js:18-21`.
- `hashPassword(pwd)`: salt aleatório de 16 bytes, `scryptSync(pwd, salt, 64)`.
- `verifyPassword(stored, pwd)`: recalcula e compara com `crypto.timingSafeEqual` (resistente a timing attack) — `server/users.js:22-29`.

### Token de sessão (HMAC)

- `signToken(u)`: corpo `{ id, papel, exp }` em base64url + assinatura HMAC-SHA256 com `AUTH_SECRET` — `server/users.js:30-33`.
- TTL: `AUTH_TTL_MS` (default 7 dias) — `server/users.js:11`.
- `AUTH_SECRET`: env var; default `"dev-inseguro-troque-AUTH_SECRET-em-producao"` (**a confirmar** se trocado em produção) — `server/users.js:10`.
- `verifyToken(token)`: valida assinatura (timing-safe), expiração e se o usuário existe e está `ativo`; devolve `{ id, usuario, papel }` — `server/users.js:34-46`.

### Guards HTTP (`server/index.js`)

- `bearer(req)` — extrai o token do header `Authorization: Bearer ...` (`index.js:28`).
- `requireAuth(req,res)` — qualquer papel autenticado; responde **401** se inválido (`index.js:30-34`).
- `requireSuper(req,res)` — exige `papel === "superadmin"`; responde **401** (não autenticado) ou **403** (sem permissão) (`index.js:36-40`).

### Guard do socket.io

`server/index.js:150-158` — middleware `io.use(...)`: todo socket precisa de token válido em `handshake.auth.token`. Exceção: sockets com `query.role === "camera"` podem usar o `CAMERA_TOKEN` (token de dispositivo), se a env estiver definida. Sem token válido → `Error("unauthorized")`.

### Papéis

- `superadmin` e `usuario` (`schema.sql:59`, default `'usuario'`).
- O sistema garante **ao menos 1 superadmin ativo**: bloqueia rebaixar/desativar o último (`users.js:102-103`) e remover o último (`users.js:113`).

### Bootstrap do superadmin

No 1º boot, se não houver usuários, cria um superadmin (`users.js:67-69`, `:76`, `:83`):
- usuário: `SUPERADMIN_USER` (default `admin`)
- senha: `SUPERADMIN_PASSWORD` (default `admin@box3`) — log avisa "TROQUE a senha".
- O arquivo `server/users.json` contém esse superadmin `admin` semeado (`users.json:1-13`).

---

## 3. Endpoints HTTP

Todos os endpoints abaixo são tratados em `server/index.js` (linhas indicadas). Respostas são JSON via helper `json(res, code, obj)` (`index.js:27`). Erros de parse caem em **400** "requisição inválida" (`index.js:142`); rota desconhecida → **404** (`index.js:144`).

### 3.1 Autenticação e perfil

| Método | Rota | Auth | Payload | Resposta | Ref |
|---|---|---|---|---|---|
| POST | `/api/login` | público | `{ usuario, senha }` | `{ token, user:{id,usuario,papel} }` ou 401 `{error}` | `index.js:50-54` |
| GET | `/api/me` | qualquer | — | perfil público (sem `senhaHash`) | `index.js:75-77` |
| PATCH/PUT | `/api/me` | qualquer | `{ whatsapp?, filtros?, optIn? }` | `{...user}` ou 400 `{error}` | `index.js:78` |

`updateProfile` normaliza o telefone (só dígitos), valida `filtros` (`{ativo, somenteCriticos, tipos[]}`) e grava `optInEm` (consentimento LGPD em epoch-ms) — `users.js:121-128`.

### 3.2 Histórico / indicadores (Postgres)

| Método | Rota | Auth | Payload | Resposta | Ref |
|---|---|---|---|---|---|
| POST | `/api/ingest` | qualquer | `{ kind, op, payload }` | `{ ok:true }` | `index.js:57-62` |
| GET | `/api/data/{ativ\|read\|obj\|fad}/buckets` | qualquer | — | array de buckets (camelCase) | `index.js:63-67` |
| GET | `/api/data/{ativ\|read\|obj\|fad}/events` | qualquer | — | array de eventos (camelCase) | `index.js:63-67` |
| POST | `/api/data/clear` | superadmin | — | `{ ok:true }` (TRUNCATE de todas as tabelas de histórico) | `index.js:68-72` |

- `kind` ∈ `ativ | read | obj | fad`; `op` define a sub-rota de ingestão (ver §5.2). Limite de corpo do ingest: 200 KB (`index.js:59`).
- O roteamento de buckets/events usa regex `^/api/data/(ativ|read|obj|fad)/(buckets|events)$` (`index.js:63`).

### 3.3 Usuários (superadmin)

| Método | Rota | Auth | Payload | Resposta | Ref |
|---|---|---|---|---|---|
| GET | `/api/users` | superadmin | — | lista pública (sem `senhaHash`) | `index.js:133` |
| POST | `/api/users` | superadmin | `{ usuario, senha, papel }` | 201 `{...user}` ou 400 `{error}` | `index.js:134` |
| PATCH | `/api/users/:id` | superadmin | `{ ativo?, papel?, senha? }` | `{...user}` ou 400 `{error}` | `index.js:136-139` |
| DELETE | `/api/users/:id` | superadmin | — | `{ ok:true }` ou 400 `{error}` | `index.js:140` |

`:id` casa o regex `^/api/users/([\w-]+)$` (`index.js:136`).

### 3.4 Destinatários de WhatsApp (superadmin)

| Método | Rota | Auth | Payload | Resposta | Ref |
|---|---|---|---|---|---|
| GET | `/api/recipients` | superadmin | — | array de destinatários | `index.js:88-89` |
| POST | `/api/recipients` | superadmin | `{ nome, numero, somenteCriticos?, tipos? }` | 201 `{...recipient}` ou 400 | `index.js:90` |
| PATCH | `/api/recipients/:id` | superadmin | `{ ativo?, nome?, numero?, somenteCriticos?, tipos? }` | `{...recipient}` ou 400 | `index.js:92-95` |
| DELETE | `/api/recipients/:id` | superadmin | — | `{ ok:true }` | `index.js:96` |

Validação do número: só dígitos, mínimo 10 (DDI+DDD), único — `recipients.js:38-42`.

### 3.5 Configuração de notificações (superadmin)

| Método | Rota | Auth | Payload | Resposta | Ref |
|---|---|---|---|---|---|
| GET | `/api/notif-settings` | superadmin | — | objeto de settings (ver §6) | `index.js:101` |
| PUT/PATCH | `/api/notif-settings` | superadmin | objeto completo de settings | settings normalizadas | `index.js:102` |
| POST | `/api/notif-preview` | superadmin | objeto de settings | `{ atividade, fadiga, leitura, objetos }` (mensagens de exemplo formatadas, **sem salvar**) | `index.js:104-117` |

### 3.6 WhatsApp e enrolamento de câmera (superadmin)

| Método | Rota | Auth | Payload | Resposta | Ref |
|---|---|---|---|---|---|
| GET | `/api/wa-status` | superadmin | — | `{ enabled, connected, qr }` | `index.js:120-123` |
| POST | `/api/wa-test` | superadmin | `{ numero }` | `{ ok:true }` ou 400 `{error}` | `index.js:124-129` |
| GET | `/api/camera-enroll` | superadmin | — | `{ token: CAMERA_TOKEN \| null }` | `index.js:82-85` |

`status()` do WhatsApp expõe `qr` como data URL para o painel renderizar (`whatsapp.js:59`).

### 3.7 CORS / preflight

Qualquer `OPTIONS` → **204** com os headers CORS (`index.js:46`). Headers permitidos: `content-type, authorization`; métodos: `GET, POST, PATCH, DELETE, OPTIONS`.

---

## 4. Eventos socket.io

Conexão dividida por `handshake.query.role`: `"camera"` ou (qualquer outro =) **dashboard** — `server/index.js:168-208`. Limite de buffer: `maxHttpBufferSize: 8e6` (8 MB), CORS `*` (`index.js:146`).

Estado em memória (`index.js:160-165`):
- `cameras: Map<id, {id, label, kind?}>` — câmeras conectadas.
- `socketById: Map<id, socket>` — para enviar config de captura direcionada.
- Dashboards entram na sala `"dashboards"` (`index.js:193`).

| Direção | Evento | Emissor → Receptor | Payload | Ref |
|---|---|---|---|---|
| handshake | `auth.token` / `query.role`, `query.id`, `query.label` | cliente → servidor | token de sessão ou CAMERA_TOKEN; papel; id/label da câmera | `index.js:150-158`, `:170-172` |
| ↓ | `cameras` | servidor → dashboards | `Camera[]` = `[{id,label,kind?}]` (lista atual) | `index.js:165`, `:176`, `:188`, `:194` |
| ↑ | `frame` | câmera → servidor | `{ buf, w, h, ts }` (JPEG binário) | `index.js:181-183` |
| ↓ | `frame` | servidor → dashboards (**volatile**) | `{ id, buf, w, h, ts }` | `index.js:182` |
| ↑ | `set-capture` | dashboard → servidor | `{ id, width, quality, fps }` | `index.js:199-203` |
| ↓ | `capture` | servidor → câmera-alvo | `{ width, quality, fps }` | `index.js:202` |
| ↑ | `alert` | dashboard → servidor | `{ text, ts }` | `index.js:206` |
| — | `disconnect` | — | remove câmera e re-emite `cameras` | `index.js:185-190` |

Observações de design:
- **`frame` é `volatile`** (`index.js:181-182`): se um dashboard está lento, o frame é descartado em vez de enfileirar — vídeo prefere o frame mais novo a acumular latência.
- O evento **`alert`** dispara duas ações (`index.js:206`): `alerts.notify(p)` → webhook andon; e `dispatch.dispatchAlert(text, ts)` → WhatsApp dos destinatários elegíveis.
- **Câmeras RTSP** (`rtsp.js:76`) emitem o mesmo evento `frame` (`{ id, buf, ts }`), então o dashboard trata câmera IP como qualquer outra; são registradas com `kind: "rtsp"` (`rtsp.js:51`).

---

## 5. Banco de dados (Postgres)

### 5.1 Camada de conexão (`server/db.js`)

- Cliente `pg.Pool` (máx 5 conexões) — `db.js:17-32`.
- Duas formas de configurar (`db.js:15`):
  - `DATABASE_URL` (override completo), **ou**
  - `PGHOST` + `PGPORT` (def. 5432) + `PGUSER` + `PGPASSWORD` + `PGDATABASE` (ou `VISAO_DB`).
- `configured()` é `false` se nada estiver setado → o hub **continua de pé**, mas o histórico fica indisponível (`db.js:3`, `:15`, `:40`).
- **bigint (OID 20) parseado para Number** (`db.js:10`): os valores são epoch-ms, cabem no número seguro do JS; sem isso o front quebraria com strings.
- `init()` executa o `schema.sql` inteiro (idempotente) no boot — `db.js:37-49`.

### 5.2 Ingestão e leitura de indicadores (`server/pgstore.js`)

`pgstore.js` espelha em SQL a lógica de "merge por bucket horário" do antigo store do browser (antes era IndexedDB). Buckets são agregados por **hora** (`hourOf(ts)` = floor para a hora cheia, `pgstore.js:6-7`).

Despacho do ingest: `INGEST["${kind}:${op}"]` (`pgstore.js:10-14`). Operações suportadas (`pgstore.js:16-95`):

| `kind:op` | Tabela alvo | Estratégia |
|---|---|---|
| `ativ:samples` | `ativ_buckets` | UPSERT por `id = cameraId\|zoneId\|hora`; soma `idle_ms/samples/active_samples`, `greatest(people_peak)` |
| `ativ:alert` | `ativ_events` + `ativ_buckets` | insere evento e incrementa `alerts` no bucket |
| `read:read` | `read_buckets` (+ `read_events` se `newBox`) | UPSERT; soma `reads/boxes/multi_reads`; mantém `per_camera` (JSONB) por câmera |
| `read:pass` | `read_buckets` | incrementa `passages` |
| `obj:samples` | `obj_buckets` | UPSERT por `setor\|classe\|hora`; soma `samples/count_sum`, `greatest(peak)`, soma `present` |
| `obj:event` | `obj_events` | insere evento (`type`=entrou/saiu, setor, classe) |
| `fad:samples` | `fad_buckets` | UPSERT por `posto\|hora`; soma estados `ok/fadiga/celular/duplo` + `ear_sum/ear_samples` |
| `fad:event` | `fad_events` | insere evento (posto, type) |

Leitura (`pgstore.js:97-111`): `buckets(kind)` e `events(kind)` retornam linhas já com **alias camelCase** (ex.: `camera_id as "cameraId"`, `hour_start as "hourStart"`) para o front montar as mesmas "cells". Eventos vêm `order by ts desc`.

`clear()` faz `TRUNCATE` das 8 tabelas de histórico (`pgstore.js:113-116`).

> Nota: se `db.configured()` é `false`, `ingest` é no-op e `buckets/events` retornam `[]` (`pgstore.js:11`, `:110-111`). Ou seja, **o histórico NÃO tem fallback em arquivo** — sem Postgres, indicadores simplesmente não persistem.

### 5.3 Schema (`server/schema.sql`)

Idempotente (`create table if not exists`). Princípio LGPD: **só indicadores agregados, nunca imagens** (`schema.sql:2-3`). O banco deve existir antes (`CREATE DATABASE visao_patio;` + `PGDATABASE`).

#### Tabelas de histórico

**`ativ_buckets`** (atividade — ocupação/ociosidade/fluxo por área), `schema.sql:8-13`
PK `id` = `${cameraId}|${zoneId}|${hourStart}`; `camera_id`, `area`, `atividade`, `hour_start` (bigint), `idle_ms` (bigint), `alerts`, `samples`, `active_samples`, `people_peak`.

**`ativ_events`**, `schema.sql:14-17` — `id bigserial PK`, `ts`, `camera_id`, `camera`, `area`, `atividade`, `duration_min`, `shift`.

**`read_buckets`** (leitura de código de barras / expedição), `schema.sql:20-25`
PK `id` = `${ponto}|${hourStart}`; `ponto`, `hour_start`, `boxes`, `reads`, `multi_reads`, `passages`, `per_camera` (**jsonb**, default `{}`).

**`read_events`**, `schema.sql:26-29` — `id bigserial`, `ts`, `ponto`, `code`, `cameras`, `shift`.

**`obj_buckets`** (objetos — contagem/presença por setor × classe), `schema.sql:32-36`
PK `id` = `${setor}|${classe}|${hourStart}`; `setor`, `classe`, `hour_start`, `samples`, `count_sum`, `peak`, `present`.

**`obj_events`**, `schema.sql:37-40` — `id bigserial`, `ts`, `type`, `setor`, `classe`, `shift`.

**`fad_buckets`** (fadiga — tempo em cada estado de risco por posto), `schema.sql:43-48`
PK `id` = `${posto}|${hourStart}`; `posto`, `hour_start`, `samples`, `ok`, `fadiga`, `celular`, `duplo`, `ear_sum` (double precision), `ear_samples`.

**`fad_events`**, `schema.sql:49-52` — `id bigserial`, `ts`, `posto`, `type`, `shift`.

#### Tabelas de cadastro/configuração

**`users`**, `schema.sql:55-65`
`id` (text PK), `usuario` (unique not null), `senha_hash` (`scrypt$salt$dk`), `papel` (default `usuario`), `ativo` (bool, def true), `whatsapp` (text), `filtros` (jsonb — `{ativo, somenteCriticos, tipos[]}`), `opt_in_em` (bigint — consentimento LGPD), `criado_em` (bigint).

**`recipients`** (números avulsos de WhatsApp do superadmin), `schema.sql:68-72`
`id` (PK), `nome`, `numero` (unique not null), `ativo` (def true), `somente_criticos` (def true), `tipos` (jsonb def `[]`), `criado_em`.

**`app_settings`** (config genérica, ex.: notificações), `schema.sql:75-78`
`id` (PK, ex.: `'notif'`), `data` (jsonb).

#### Índices, `schema.sql:81-88`

- Eventos por `ts desc`: `idx_{ativ,read,obj,fad}_events_ts`.
- Buckets por hora: `idx_{ativ,read,obj,fad}_buckets_hour`.

#### Diagrama do schema

```
┌──────────────── HISTÓRICO (indicadores agregados, LGPD-safe) ────────────────┐
│                                                                              │
│  ativ_buckets                         ativ_events                            │
│  ─ id (PK) = cam|zone|hour            ─ id bigserial (PK)                     │
│    camera_id, area, atividade           ts, camera_id, camera, area,         │
│    hour_start, idle_ms, alerts,         atividade, duration_min, shift       │
│    samples, active_samples, people_peak                                      │
│                                                                              │
│  read_buckets                         read_events                            │
│  ─ id (PK) = ponto|hour               ─ id bigserial (PK)                     │
│    ponto, hour_start, boxes, reads,     ts, ponto, code, cameras, shift      │
│    multi_reads, passages, per_camera(jsonb)                                  │
│                                                                              │
│  obj_buckets                          obj_events                             │
│  ─ id (PK) = setor|classe|hour        ─ id bigserial (PK)                     │
│    setor, classe, hour_start,           ts, type, setor, classe, shift       │
│    samples, count_sum, peak, present                                         │
│                                                                              │
│  fad_buckets                          fad_events                             │
│  ─ id (PK) = posto|hour               ─ id bigserial (PK)                     │
│    posto, hour_start, samples, ok,      ts, posto, type, shift               │
│    fadiga, celular, duplo, ear_sum, ear_samples                             │
└──────────────────────────────────────────────────────────────────────────────┘

┌──────────────── CADASTRO / CONFIGURAÇÃO ────────────────┐
│  users                          recipients              app_settings          │
│  ─ id (PK)                      ─ id (PK)               ─ id (PK) ex.'notif'   │
│    usuario (unique)               nome                    data (jsonb)         │
│    senha_hash                     numero (unique)                              │
│    papel, ativo, whatsapp         ativo, somente_criticos                     │
│    filtros (jsonb)                tipos (jsonb)                                │
│    opt_in_em, criado_em           criado_em                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

**Relacionamentos:** o schema **não define foreign keys explícitas**. Os vínculos são lógicos/por convenção:
- buckets e events de um mesmo domínio se relacionam pelas colunas de negócio (`camera_id`/`area`, `ponto`, `setor`+`classe`, `posto`) e janela de tempo (`hour_start`/`ts`), não por FK.
- `users.whatsapp` e `recipients.numero` são as duas fontes de destinatários reunidas (dedupe por número) no `dispatch.js` (não há FK entre elas).

---

## 6. Persistência e fallback (Postgres vs arquivos JSON)

O padrão é: **cache em memória + persistência em Postgres se `db.configured()`; caso contrário, arquivo JSON local**. Cada módulo decide no `init()` e guarda a flag `usingPg`.

| Domínio | Módulo | Com Postgres | Sem Postgres (fallback) |
|---|---|---|---|
| Usuários | `users.js` | tabela `users` | `server/users.json` |
| Destinatários | `recipients.js` | tabela `recipients` | `server/recipients.json` |
| Config notificações | `settings.js` | `app_settings (id='notif')` | `server/notif-settings.json` |
| Histórico/indicadores | `pgstore.js` | tabelas de histórico | **sem fallback** (no-op / `[]`) |

Detalhes:
- **users** — `init()` lê do PG e, se vazio, faz bootstrap do superadmin; em erro de PG, cai para JSON (`users.js:71-84`). Escrita: `persist()`/`persistDelete()` (UPSERT/DELETE no PG ou `saveFile()`) — `users.js:55-65`.
- **recipients** — análogo, sem bootstrap (`recipients.js:25-36`, `:14-23`).
- **settings** — `init()` lê `app_settings` e, se ausente, insere os defaults; fallback para JSON em erro (`settings.js:47-60`). `update()` grava no PG ou no arquivo (`settings.js:63-72`). Há um `cur` default síncrono para o dispatch nunca ver `undefined` (`settings.js:45`).
- **histórico** — depende exclusivamente do Postgres; sem ele, ingest é ignorado e leituras retornam vazio (ver §5.2).

> Observação: o fallback JSON é por design "dev / PG desligado". Em produção multi-instância, o cache em memória + JSON não é compartilhado — assume-se Postgres (a confirmar com o deploy).

---

## 7. Gestão de configurações de notificações (`server/settings.js`)

Objeto de configuração (defaults em `settings.js:11-22`):

```jsonc
{
  "marca": "Visão de Pátio",
  "incluirLocal": true,
  "incluirHora": true,
  "incluirRodape": true,
  "tipos": {
    "atividade": { "ativo": true, "titulo": "Operação · Parada de área", "instrucao": "" },
    "fadiga":    { "ativo": true, "titulo": "Segurança · Operador",      "instrucao": "" },
    "leitura":   { "ativo": true, "titulo": "Expedição · Leitura",       "instrucao": "" },
    "objetos":   { "ativo": true, "titulo": "Pátio · Objetos",           "instrucao": "" }
  }
}
```

- `normalize(p)` (`settings.js:25-43`): mescla sobre os defaults e aplica limites (`titulo` ≤ 80 chars, `instrucao` ≤ 300, `marca` ≤ 80; booleanos `!== false`).
- Consumido pelo `dispatch.formatWhatsApp()` para montar a mensagem profissional (título, ícone 🔴/🟡, local 📍, hora 🕒, rodapé com a marca) — `dispatch.js:26-46`.
- O preview (`/api/notif-preview`) usa amostras fixas por tipo e devolve as mensagens já formatadas, sem persistir — `index.js:107-116`.
- Se um tipo está `ativo:false`, o dispatch **não envia** alertas daquele tipo — `dispatch.js:75`.

---

## 8. Notificações (contexto do disparo)

Embora fora do escopo central de "banco/APIs", estes módulos consomem os cadastros e a config:

- **Andon / webhook** (`alerts.js`): `ALERT_WEBHOOK_URL` liga o recurso; payload genérico `{app, source, text, content, ts}` (casa Slack/Teams/Discord/Zapier...); dedup por mensagem em `ALERT_DEDUP_MS` (def 60s) — `alerts.js:7-35`.
- **WhatsApp** (`whatsapp.js`): Baileys/WhatsApp Web não-oficial; ligado por `WHATSAPP_ENABLED=1`; sessão persiste em `server/wa-auth/`; QR exposto como data URL; reconecta em 3s salvo logout — `whatsapp.js:11-60`.
- **Dispatch** (`dispatch.js`): classifica o texto por palavra-chave (`tipo` + `critico` se contém "⚠"), reúne destinatários das duas fontes (recipients + usuários com whatsapp/opt-in/filtro), aplica filtros e dedup por `numero|text` em `ALERT_DEDUP_MS`, e envia a mensagem formatada — `dispatch.js:13-85`.

---

## 9. Como o frontend conversa com o servidor (`src/api.ts`)

`src/api.ts` é o cliente HTTP das rotas autenticadas. O login em si é feito em `auth.tsx` (a confirmar). Base de URL = `APP_CONFIG.net.serverUrl` (mesma origem em prod via nginx; `:4000` em dev) — `api.ts:1-3`, `:22-26`.

- Token guardado em `localStorage["vp-auth"].token` e enviado como `Authorization: Bearer ...` — `api.ts:5-13`.
- Helpers `apiGet` / `apiSend(method, path, body)`; `parse()` trata 204 (sem corpo) e extrai `{error}` em falhas — `api.ts:14-26`.

Mapeamento dos endpoints consumidos (todos confirmados no servidor):

| Função (api.ts) | Método/Rota | Ref |
|---|---|---|
| `getMe` / `updateMe` | GET / PATCH `/api/me` | `api.ts:31-32` |
| `listUsers` / `createUser` / `patchUser` / `deleteUser` | GET/POST `/api/users`, PATCH/DELETE `/api/users/:id` | `api.ts:36-39` |
| `getCameraEnroll` | GET `/api/camera-enroll` | `api.ts:40` |
| `getWaStatus` / `waTest` | GET `/api/wa-status`, POST `/api/wa-test` | `api.ts:44-45` |
| `getNotifSettings` / `saveNotifSettings` / `previewNotif` | GET/PATCH `/api/notif-settings`, POST `/api/notif-preview` | `api.ts:50-52` |
| `listRecipients` / `createRecipient` / `patchRecipient` / `deleteRecipient` | GET/POST `/api/recipients`, PATCH/DELETE `/api/recipients/:id` | `api.ts:56-59` |

> `src/api.ts` **não** cobre `/api/login`, `/api/ingest`, `/api/data/*` nem os eventos socket.io — esses são consumidos por outros módulos do front (login em `auth.tsx`; ingest/leitura de histórico e socket no cliente de câmera/dashboard — a confirmar nos arquivos correspondentes).

---

## 10. Variáveis de ambiente (resumo)

| Env | Default | Módulo | Função |
|---|---|---|---|
| `PORT` | 4000 | index.js | Porta do hub |
| `HOST` | 0.0.0.0 | index.js | Bind (prod: 127.0.0.1) |
| `CAMERA_TOKEN` | — | index.js | Token de dispositivo p/ câmeras |
| `AUTH_SECRET` | dev-inseguro... | users.js | Chave HMAC dos tokens |
| `AUTH_TTL_MS` | 7 dias | users.js | TTL da sessão |
| `SUPERADMIN_USER` / `SUPERADMIN_PASSWORD` | admin / admin@box3 | users.js | Bootstrap do superadmin |
| `DATABASE_URL` | — | db.js | Conexão PG (override) |
| `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` (ou `VISAO_DB`) | —/5432/... | db.js | Conexão PG por partes |
| `WHATSAPP_ENABLED` | (off) | whatsapp.js | Liga o canal WhatsApp |
| `ALERT_WEBHOOK_URL` | — | alerts.js | Liga o andon/webhook |
| `ALERT_DEDUP_MS` | 60000 | alerts.js / dispatch.js | Janela de dedup |
| `RTSP_SOURCES` / `RTSP_FPS` / `RTSP_WIDTH` / `RTSP_QUALITY` | — / 8 / 480 / 7 | rtsp.js | Fontes e qualidade RTSP |

---

*Fim do documento. Toda a informação acima foi extraída do código-fonte real em `server/` e `src/api.ts`; itens marcados "a confirmar" dependem de arquivos/deploy fora do escopo lido.*
