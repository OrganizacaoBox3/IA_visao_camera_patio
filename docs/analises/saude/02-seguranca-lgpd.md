# Auditoria de Saúde — 02 · Segurança, LGPD e Segredos

> **Dimensão:** Segurança · LGPD · Segredos.
> **Lente (critério):** `CLAUDE.md` §3 (invariantes: LGPD/local-first, segredos, SQL) e §8 (uso de IA); `../agentes/exploracao/POLITICA_USO_IA.md` (gate de classificação de dados); `PRATICAS_ENGENHARIA.md` (seção Segurança).
> **Escopo:** leitura estática do código e do estado do repositório git. **Nada foi alterado.** Arquivos de credencial (`server/wa-auth/*`) foram **apenas constatados** — conteúdo NÃO lido.
> **Data:** 2026-06-28. Notação: **(E)** evidência direta no código · **(I)** inferência · **⚠️** viola invariante do `CLAUDE.md`.

---

## 0. Veredito (TL;DR)

**🔴 REPROVADO em Segredos. 🟢 APROVADO em LGPD. 🟡 Auth/Rede aceitável-para-MVP com dívidas.**

A higiene de **dados/LGPD** é genuinamente forte e bem desenhada — a invariante "nenhuma imagem persistida" é respeitada em **todas** as camadas (relé RTSP em memória, snapshot/clip são download local, schema só metadados). A higiene de **segredos** é o oposto: há **credencial de produção real versionada em git** (senha Postgres de um banco em **IP público**) e o **hash do superadmin** committado, ambos violando frontalmente `CLAUDE.md §3`. Auth tem boa base criptográfica (scrypt + HMAC + timing-safe) mas carrega as dívidas clássicas de MVP: token em `localStorage`, sem rate-limiting no login, defaults inseguros.

---

## 1. Scorecard por sub-item

| # | Sub-item | Status | Evidência |
|---|----------|:------:|-----------|
| **A. Segredos versionados** | | | |
| A1 | Senha Postgres em texto plano no `deploy/visao-hub.service` | 🔴 | `deploy/visao-hub.service:34` `Environment="PGPASSWORD=<SENHA-REDIGIDA>` + `:31 PGHOST=<HOST-REDIGIDO>` (IP público). **(E) ⚠️** |
| A2 | Arquivo do segredo está **versionado** (não só presente) | 🔴 | `git ls-files deploy/visao-hub.service` → rastreado; `git log` → commit `529512b` "import inicial". Segredo está no **histórico**. **(E) ⚠️** |
| A3 | `users.json` (hash do superadmin) versionado | 🔴 | `git ls-files server/users.json` → rastreado; `git show HEAD:server/users.json` contém `senhaHash: "scrypt$<HASH-REDIGIDO>` real. **NÃO está no `.gitignore`.** **(E) ⚠️** |
| A4 | `.gitignore` cobre os runtime-JSON sensíveis | 🟡 | Cobre `wa-auth/`, `cameras.json`, `alarms.json`, `camcfg.json`, `alarm-shelves.json`, `rtsp.sources.json` (`.gitignore:19-39`). **Falta `users.json`** (e o genérico `server/*.json`). **(E)** |
| A5 | Demais runtime-JSON realmente fora do git | 🟢 | `git ls-files server/*.json` → só `package*.json`, `*.example.json`, `users.json`. `rtsp.sources.json` presente no disco e **não** rastreado. **(E)** |
| A6 | `wa-auth/` (sessão Baileys) protegido | 🟢 | Existe no disco (93 arquivos, incl. `creds.json`) — **constatado, não lido**. Não rastreado (`.gitignore:26`). **(E)** |
| A7 | `.env*` / exemplos sem segredo real | 🟢 | `.env.production.example` só comentários; `rtsp.sources.example.json` usa `usuario:senha` placeholder; `AUTH_SECRET` no `.service` é placeholder `troque-por-…`. **(E)** |
| **B. LGPD — "sem imagem persistida"** | | | |
| B1 | Relé de frames não grava em disco | 🟢 | `server/index.js:314-316` (`volatile.emit("frame")`); `server/rtsp.js:134-142` (ffmpeg→`emit`, buffer em memória, sem `writeFile`). **(E)** |
| B2 | Persistência só metadados (PG) | 🟢 | `server/schema.sql:3` "Só INDICADORES… nunca imagens"; `pgstore.js`/`events.js` só texto/ids/timestamps; nenhuma coluna `bytea`/blob/base64. **(E)** |
| B3 | Eventos de alarme = só metadados | 🟢 | `server/events.js:12-14,49-64` (`build()` só campos texto); `schema.sql:84-92` (`alarm_events` sem imagem). **(E)** |
| B4 | Snapshot/clip são efêmeros e locais | 🟢 | `src/CameraWorkspace.tsx:863-866,892` "download manual… NUNCA vai ao servidor"; `src/camera/clipExport.ts` usa `canvas.toBlob`+`<a download>`. Cine-loop é buffer em memória. **(E)** |
| B5 | Nó câmera não persiste, só transmite | 🟢 | `src/routes/CameraPage.tsx:77` `c.toBlob(...)`→socket; sem gravação. **(E)** |
| B6 | PII tratada com consentimento | 🟡 | Armazena telefone (`users.whatsapp`, `recipients.numero`) — PII — mas com carimbo de consentimento `opt_in_em` (`schema.sql:64`, `users.js:139`). PII legítima, minimizada. **(E)** |
| **C. Autenticação** | | | |
| C1 | Hash de senha forte | 🟢 | `server/users.js:25-35` `scrypt` com salt aleatório de 16B. **(E)** |
| C2 | Comparações timing-safe | 🟢 | `users.js:34` (senha) e `:47` (token HMAC) usam `crypto.timingSafeEqual`. **(E)** |
| C3 | Token de sessão assinado | 🟢 | `users.js:37-53` HMAC-SHA256 sobre payload com `exp`; verifica assinatura e expiração. **(E)** |
| C4 | `AUTH_SECRET` default inseguro | 🟡 | `users.js:17` fallback `"dev-inseguro-troque-AUTH_SECRET-em-producao"`; `.service:28` envia placeholder. Se não trocado em prod → **tokens forjáveis**. **(E) ⚠️** |
| C5 | Senha default do superadmin hardcoded | 🔴 | `users.js:75` `SUPERADMIN_PASSWORD \|\| "admin@box3"`. Combinado com A3 (hash committado), credencial padrão é efetivamente pública. **(E) ⚠️** |
| C6 | Token em `localStorage` (exposto a XSS) | 🟡 | `src/auth.tsx:42`, `src/api.ts:6`, `src/routes/CameraPage.tsx:12` (`vp-auth`). Dívida conhecida no `PRATICAS_ENGENHARIA.md:58`. **(E)** |
| C7 | Rate-limiting no login | 🔴 | Ausente. `index.js:61-65` `/api/login` sem contador/throttle/429; grep não acha `rate/limit/attempt`. Brute-force viável. **(E)** |
| C8 | Guards consistentes nos endpoints | 🟢 | `requireAuth/requireConfigurer/requireSuper` (`index.js:34-51`) aplicados: `/api/cameras` → super (`:216-243`), `/api/alarms` → auth + shelve/unshelve → configurer (`:88-142`), `/api/views` → auth GET/PUT (`:248-257`), `/api/tripwires` → auth GET / configurer PUT (`:262-273`). Socket.io exige token (`:282-290`). **(E)** |
| C9 | Escrita de views compartilhadas | 🟡 | `/api/views` PUT permite a **qualquer** autenticado substituir a lista global inteira (`index.js:250-256`). Intencional (operadores organizam), mas sem trilha de auditoria de quem alterou. **(E/I)** |
| **D. Input / SQL** | | | |
| D1 | Queries parametrizadas | 🟢 | 100% `$n` em `pgstore.js`, `events.js`, `users.js`; `jsonb_set(array[$6::text], …)` parametrizado (`pgstore.js:50-51`). Sem concatenação. **(E)** |
| D2 | Validação de input | 🟡 | Ad-hoc: `JSON.parse` + checagem manual; `normalizeRole` cai no papel mais restrito (`users.js:97`); sem Zod/Joi. **(E)** |
| D3 | Limite de corpo (anti-DoS) | 🟢 | `readBody(req, limit)` corta payloads (`index.js:26-30`); ingest/views/tripwires usam `200_000`. Socket `maxHttpBufferSize: 8e6`. **(E)** |
| D4 | Guard read-only (SIAG) | 🟢 (N/A) | Este hub não toca SIAG/SQL Server (só Postgres gravável próprio). Invariante SIAG read-only do `CLAUDE.md §3` não se aplica aqui. `clear()`/`truncate` está atrás de `requireSuper`. **(E/I)** |
| D5 | `schema.sql` idempotente/aditivo | 🟢 | `create table if not exists` / `create index if not exists` em todo o arquivo. **(E)** |
| **E. Rede / CORS / CSP** | | | |
| E1 | CSP em produção | 🟡 | `deploy/nginx-visao.conf:43` CSP completa (HSTS, nosniff, `frame-ancestors none`, Permissions-Policy `camera=(self)`), **mas** `script-src` com `'unsafe-inline' 'unsafe-eval'` (exigido por TFJS/wasm) enfraquece defesa anti-XSS — agrava C6. **(E)** |
| E2 | CORS do hub | 🟡 | `index.js:54` `Access-Control-Allow-Origin: *` e `io = new Server(..., { cors:{ origin:"*" }})` (`:278`) **incondicionais** no código. Mitigado em prod por same-origin via nginx (comentário `:54`), mas o código é permissivo por padrão. **(E)** |
| E3 | Superfície de exposição | 🟢 | `.service:21` `HOST=127.0.0.1` → hub só no loopback; nginx faz o proxy e o TLS. Hardening systemd (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`). **(E)** |
| E4 | Banco Postgres exposto | 🔴 | `PGHOST=<HOST-REDIGIDO>:5432` é IP público (`.service:31-32`) — com a senha vazada (A1), o banco é alcançável da internet. **(E/I) ⚠️** |

---

## 2. Achados críticos (P0 primeiro)

### 🔴 P0-1 — Senha do Postgres de produção versionada, em banco de IP público
- **Onde:** `deploy/visao-hub.service:31-35` (`PGHOST=<HOST-REDIGIDO>`, `PGPORT=5432`, `PGUSER=postgres`, `PGPASSWORD=<SENHA-REDIGIDA>`). Rastreado e no histórico git (commit `529512b`).
- **Viola:** `CLAUDE.md §3` ("Segredos: nunca versionar `.env`/credenciais"). O próprio `CLAUDE.md §6` já reconhece a pendência: *"rotacionar a credencial Postgres em `deploy/visao-hub.service`"* — **ainda aberta**.
- **Risco concreto:** credencial `postgres` (superusuário) de um banco em **IP público na porta padrão 5432**. Qualquer pessoa com acesso ao repositório (ou ao histórico) obtém leitura/escrita/`DROP` total do banco de indicadores e usuários, e potencialmente do servidor. Mesmo que o arquivo seja removido do `HEAD`, **permanece no histórico**.
- **Correção:** (1) **Rotacionar a senha do Postgres AGORA** (a vazada deve ser considerada comprometida). (2) Substituir o valor no `.service` por placeholder e injetar via `EnvironmentFile=/etc/visao/secrets.env` (modo 600, fora do git) ou secrets manager. (3) Restringir o Postgres a `pg_hba`/firewall (somente o host do hub; idealmente tirar da internet). (4) Limpar o histórico git (`git filter-repo`/BFG) se o repo for compartilhado/empurrado.

### 🔴 P0-2 — `users.json` versionado com hash do superadmin + senha default conhecida
- **Onde:** `git ls-files server/users.json` (rastreado); `git show HEAD:server/users.json` → `senhaHash: "scrypt$<HASH-REDIGIDO>`. Senha default `"admin@box3"` hardcoded em `server/users.js:75`. `.gitignore` **não** lista `users.json`.
- **Viola:** `CLAUDE.md §3` (segredos/credenciais fora do git) + DoD §7 ("sem segredo no código").
- **Risco concreto:** o hash do superadmin está no repositório. Se o usuário não trocou a senha bootstrap (`admin@box3`, pública neste código), o par usuário+senha do administrador é efetivamente conhecido → tomada de conta total (gestão de usuários, câmeras, notificações). Scrypt protege contra recuperação por força bruta, mas **não** contra uma senha default já conhecida.
- **Correção:** (1) Adicionar `server/users.json` (e preferencialmente `server/*.json` com exceções para `*.example.json`/`package*.json`) ao `.gitignore`; (2) `git rm --cached server/users.json` e limpar histórico; (3) confirmar que a senha do superadmin em produção foi trocada; (4) em produção usar Postgres (não o fallback JSON) para a base de usuários.

### 🔴 P0-3 — Login sem rate-limiting (brute-force)
- **Onde:** `server/index.js:61-65` (`/api/login`) — nenhum contador/atraso/bloqueio; grep por `rate|limit|attempt|429` não retorna nada relevante.
- **Risco concreto:** com C5 (senha default) e sem throttle, brute-force/credential-stuffing contra contas é trivial; o hub valida tokens a cada request, então uma sessão obtida dá acesso amplo.
- **Correção:** rate-limit por IP+usuário (ex.: janela deslizante simples em memória, backoff exponencial, 429) — coerente com a filosofia "zero-dependência" da casa. P1 se a superfície já estiver atrás de `auth_basic`/VPN; P0 se exposta publicamente.

### 🟡 P0-adjacente — `AUTH_SECRET` com default inseguro
- **Onde:** `server/users.js:17` fallback `"dev-inseguro-troque-AUTH_SECRET-em-producao"`; `.service:28` envia placeholder.
- **Risco:** se em produção não for definido um valor forte, os tokens HMAC são **forjáveis** por qualquer um que conheça o default (público no código) → bypass total de autenticação. Tratar como gate de deploy: o boot deveria **recusar subir** com o secret default em `NODE_ENV=production`.

---

## 3. Pontos fortes confirmados (não regredir)

- **LGPD/local-first íntegro (`CLAUDE.md §3`):** nenhuma imagem/frame persiste em servidor — verificado nas 5 camadas pedidas (`events.js`, `pgstore.js`, `schema.sql`, `rtsp.js`, `CameraWorkspace.tsx`/`CameraPage.tsx`). Snapshot e clip são download local explícito; cine-loop é buffer em memória. Schema declara e cumpre "só indicadores".
- **Cripto de auth correta:** scrypt salgado + token HMAC com expiração + `timingSafeEqual` em ambas as comparações, **sem dependências** (alinhado ao "padrão da casa").
- **SQL 100% parametrizado** — nenhuma concatenação; `jsonb_set` também parametrizado.
- **RBAC consistente** nos endpoints novos e antigos; socket exige token; URLs RTSP são **redigidas** nos logs (`rtsp.js:60`).
- **Retenção/minimização** de eventos de alarme configurável (`events.js:36-37,84-97`).

---

## 4. Plano de retrofit (priorizado, com esforço)

### P0 — fazer antes de qualquer deploy/compartilhamento do repo
| Ação | Esforço |
|------|:------:|
| Rotacionar a senha do Postgres comprometida; trocar `PGPASSWORD` por `EnvironmentFile` fora do git (`P0-1`) | S (1-2h) |
| Restringir o Postgres por firewall/`pg_hba` ao host do hub (tirar 5432 da internet) (`P0-1`) | S-M |
| `users.json` → `.gitignore` + `git rm --cached` + confirmar senha do superadmin trocada (`P0-2`) | S (~1h) |
| Limpar o histórico git dos segredos (`git filter-repo`/BFG) — se o repo já saiu do laptop | M (½ dia) |
| Boot recusa `AUTH_SECRET` default em produção; gerar secret forte (`P0-adj`) | S (~1h) |
| Rate-limiting no `/api/login` (backoff + 429, em memória) (`P0-3`) | S-M (~½ dia) |

### P1 — robustez de autenticação e exposição
| Ação | Esforço |
|------|:------:|
| Endurecer `.gitignore` (`server/*.json` com exceção de `*.example.json`/`package*.json`) para prevenir futuros vazamentos | S |
| CORS do hub: restringir `origin` por env (lista de origens) em vez de `*` incondicional | S |
| Mitigar token-em-`localStorage`: avaliar cookie `HttpOnly`+`SameSite` (ou aceitar risco e documentar como ADR), dado o `unsafe-inline/eval` na CSP | M |
| Trilha de auditoria mínima (quem alterou views/câmeras/usuários) — espelha `app_audit_log` citado em `PRATICAS_ENGENHARIA.md:40` | M |
| Validação de input com schema (Zod) nos endpoints de escrita | M |

### P2 — defesa em profundidade / governança
| Ação | Esforço |
|------|:------:|
| Reduzir `unsafe-inline`/`unsafe-eval` da CSP via nonces onde TFJS permitir | M-L |
| Migrar a base de usuários para sempre-Postgres em prod (evitar fallback `users.json`) | S |
| Política de retenção LGPD documentada (definir `ALARM_EVENTS_RETENTION_DAYS` > 0) e DPIA mínima do tratamento de telefones | S-M |
| CI/pre-push com **gitleaks/trufflehog** + `verify` (fecha lacuna "Onda 0" do `CLAUDE.md §6`) | M |

---

## 5. Aderência à `POLITICA_USO_IA.md` (§8 do `CLAUDE.md`)

- Os segredos em `deploy/visao-hub.service` e `server/users.json` estão **no working dir** — a `POLITICA_USO_IA.md` (§1.5 item 3, §3 item 4) alerta que agentes como Claude Code/Cursor **auto-carregam** o contexto do diretório, e que `.env`/credenciais/PII jamais devem entrar nele. O vazamento P0-1/P0-2 é também um risco de **exfiltração para IA** (classe "Restrito/Regulado" da matriz §2 — *nunca* vai para IA). Resolver os P0 fecha simultaneamente este flanco. **(I)**
- Esta auditoria respeitou a coleira: `wa-auth/*` foi apenas **constatado** (existe `creds.json`), nunca lido.

---

> **Resumo de uma linha:** LGPD exemplar; segredos em estado crítico — rotacionar a senha do Postgres e remover `users.json`/credenciais do git **antes** de qualquer push ou deploy.
