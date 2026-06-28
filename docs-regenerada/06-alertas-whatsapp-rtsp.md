# Alertas, Notificações (WhatsApp) e Integração RTSP

> Documento técnico do MVP de Visão Computacional (hub Node + frontend React/Vite).
> Baseado exclusivamente no código em `server/`. Trechos referenciados no formato `arquivo:linha`.
>
> Módulos cobertos: `server/alerts.js`, `server/dispatch.js`, `server/whatsapp.js`,
> `server/recipients.js`, `server/settings.js` (apoio), `server/rtsp.js`,
> `server/rtsp.sources.example.json` e a pasta `server/wa-auth/`.

---

## 1. Visão geral

O hub (`server/index.js`) é um relé de frames de câmeras (socket.io) que **não processa nem armazena vídeo**. A inteligência de detecção roda no painel (frontend); quando o painel decide que algo merece atenção, ele emite um evento `alert` pelo socket. O servidor então faz duas coisas em paralelo (`server/index.js:206`):

1. **Andon digital** — repassa o texto cru do alerta para um *webhook externo* genérico (`server/alerts.js`).
2. **Dispatch para WhatsApp** — classifica e formata o alerta numa mensagem profissional e envia para os destinatários elegíveis (`server/dispatch.js` → `server/whatsapp.js`).

Em paralelo a tudo isso, o hub também ingere câmeras IP via **RTSP** usando `ffmpeg`, convertendo o stream em frames JPEG que entram no mesmo pipeline de câmeras de navegador (`server/rtsp.js`).

```
┌─────────────┐   socket "alert"    ┌──────────────────────────────────────┐
│  Painel /   │ ──────────────────► │  index.js  (io.on "alert")  :206      │
│  Dashboard  │  { text, ts }       └───────────┬───────────────┬──────────┘
└─────────────┘                                 │               │
                                                ▼               ▼
                                   ┌────────────────┐   ┌───────────────────┐
                                   │  alerts.notify │   │ dispatch.dispatch │
                                   │  (Andon webhook)│  │ Alert(text, ts)   │
                                   └───────┬────────┘   └─────────┬─────────┘
                                           │                      │
                                           ▼                      ▼
                                   Webhook HTTP externo   classify + formatWhatsApp
                                  (Slack/Teams/n8n/...)            │
                                                                   ▼
                                                          targets() (recipients
                                                          + usuários opt-in)
                                                                   │
                                                                   ▼
                                                          whatsapp.sendText →
                                                          Baileys (WhatsApp Web)
```

---

## 2. Geração e disparo de alertas (Andon) — `server/alerts.js`

O módulo `alerts.js` implementa o **Andon digital**: repassa alertas críticos do painel para um **webhook externo genérico**. Roda no servidor porque a URL do webhook é segredo e não pode ir no bundle do navegador (`server/alerts.js:1-2`).

### Configuração (variáveis de ambiente)

| Variável | Default | Função |
|----------|---------|--------|
| `ALERT_WEBHOOK_URL` | `""` (vazio = desligado) | URL do webhook; obrigatória para ligar (`server/alerts.js:7`) |
| `ALERT_DEDUP_MS` | `60000` (60 s) | Janela que ignora o **mesmo** alerta repetido (`server/alerts.js:8`) |

O Andon só está ativo quando `ALERT_WEBHOOK_URL` está definido — `andonEnabled()` retorna `!!WEBHOOK_URL` (`server/alerts.js:12`). No boot, o servidor loga se o Andon está ativo ou desligado (`server/index.js:217`).

### Payload e compatibilidade

O payload do webhook inclui **tanto `text` quanto `content`** propositalmente, para casar sem configuração extra com Slack, Teams, Discord, Zapier, Make, n8n e endpoints próprios (`server/alerts.js:3-4`, `server/alerts.js:15`):

```json
{ "app": "Visão de Pátio", "source": "andon", "text": "...", "content": "...", "ts": 1700000000000 }
```

O envio é um `POST` JSON via `fetch`; erros (HTTP não-OK ou falha de rede) são apenas logados, sem lançar exceção (`server/alerts.js:14-22`).

### Deduplicação

`notify(p)` (`server/alerts.js:25-35`) aplica dedup **por mensagem** usando um `Map` em memória (`lastSent`, texto → timestamp):

- Ignora payloads vazios e texto vazio.
- Se o mesmo `text` foi enviado dentro de `DEDUP_MS`, é descartado (`server/alerts.js:31`).
- Limpeza preguiçosa: quando o `Map` passa de 300 entradas, remove as antigas (`server/alerts.js:33`).
- O envio é "fire-and-forget" via `void post(...)` (`server/alerts.js:34`).

> Nota: este dedup é **independente** do dedup do dispatch de WhatsApp (seção 4), embora ambos usem a mesma variável `ALERT_DEDUP_MS`.

---

## 3. Como o alerta chega ao servidor — `server/index.js`

O painel (papel "dashboard") emite o evento socket `alert` com `{ text, ts }`. O handler único dispara as duas vias (`server/index.js:205-206`):

```js
socket.on("alert", (p) => { alerts.notify(p); if (p && p.text) dispatch.dispatchAlert(String(p.text), p.ts); });
```

Apenas sockets autenticados conseguem chegar aqui: o middleware `io.use` valida um token de sessão (ou `CAMERA_TOKEN` para dispositivos câmera) antes de aceitar a conexão (`server/index.js:150-158`).

---

## 4. Pipeline de dispatch para WhatsApp — `server/dispatch.js`

`dispatch.dispatchAlert(text, ts)` (`server/dispatch.js:71-85`) é o coração do envio. Fluxo:

1. **Guarda de entrada** — só prossegue se houver texto, o WhatsApp estiver habilitado e **conectado** (`server/dispatch.js:72`). Sem conexão, o alerta é simplesmente ignorado (não enfileira).
2. **Classificação** — `classify(text)` (`server/dispatch.js:13-21`).
3. **Tipo desligado** — se o superadmin marcou o tipo como inativo nas configurações, aborta (`server/dispatch.js:75`).
4. **Formatação** — `formatWhatsApp(...)` monta a mensagem profissional (não o texto cru do toast) (`server/dispatch.js:76`).
5. **Seleção de destinatários** — `targets(meta)` (`server/dispatch.js:55-69`).
6. **Envio com dedup por (número|texto)** — `whatsapp.sendText(...)` para cada alvo (`server/dispatch.js:78-83`).

### 4.1 Classificação — `classify(text)`

Por palavra-chave, define dois atributos (`server/dispatch.js:13-21`):

- `critico`: `true` se o texto contém o caractere `⚠` (`server/dispatch.js:15`).
- `tipo`: um de quatro valores, por regex (case-insensitive):
  - `fadiga` — `fadiga|celular|bocejo|operador|risco`
  - `leitura` — `leitura|no-?read|taxa|c[oó]digo`
  - `objetos` — `objeto|presen|carreg|palete|empilhad|caixa`
  - `atividade` — default quando nenhum casa.

### 4.2 Formatação da mensagem — `formatWhatsApp(text, meta, ts, s)`

Gera a mensagem com markdown do WhatsApp (`*negrito*`, `_itálico_`), configurável pelo superadmin via `settings` (`server/dispatch.js:26-46`). Lógica:

- Remove o prefixo `⚠`/`!`/espaços iniciais (`server/dispatch.js:28`).
- Tenta extrair um **local** do padrão `"Local: mensagem"` quando o separador `": "` aparece nos primeiros 60 caracteres (`server/dispatch.js:30-31`).
- Para tipo `fadiga`, substitui rótulos curtos por frases descritivas via `FADIGA_DETALHE` (`Fadiga`, `Celular`, `Duplo`, `OK`) (`server/dispatch.js:24`, `server/dispatch.js:32`).
- Capitaliza a primeira letra (sem mexer em emoji) (`server/dispatch.js:33`).
- Anexa a `instrucao` extra do tipo, se configurada (`server/dispatch.js:34`).
- Formata data/hora em `pt-BR`, fuso `America/Sao_Paulo` (`server/dispatch.js:35`).
- Monta as linhas com cabeçalho (`🔴 *ALERTA*` se crítico, senão `🟡 *Aviso*`), local opcional (`📍`), hora opcional (`🕒`), corpo e rodapé opcional (`server/dispatch.js:36-45`).

Os textos do cabeçalho/título, e quais campos incluir (local, hora, rodapé, marca), vêm das configurações do superadmin (`server/settings.js`, ver seção 6).

### 4.3 Seleção de destinatários — `targets(meta)`

Une **duas fontes** num `Map` deduplicado por número (`server/dispatch.js:1-3`, `server/dispatch.js:55-69`):

1. **Lista do superadmin** (`recipients.all()`) — números avulsos. Inclui só os `ativo` e que passam no filtro `passes(...)` (`server/dispatch.js:57-61`).
2. **Usuários do sistema** com WhatsApp no perfil + **opt-in** + filtro `ativo` (`server/dispatch.js:62-67`). Campos relevantes do usuário: `whatsapp`, `optInEm`, `filtros` (ver `server/users.js:123-125`). Em caso de número repetido, a lista de recipients tem prioridade (`if (!map.has(...))`, `server/dispatch.js:66`).

O filtro `passes(f, meta)` (`server/dispatch.js:48-52`):
- Se `somenteCriticos` e o alerta não for crítico → descarta.
- Se há lista de `tipos` e o tipo do alerta não está nela → descarta.

### 4.4 Deduplicação de envio

`sent` é um `Map` com chave `"${numero}|${text}"` → timestamp (`server/dispatch.js:11`). Cada alvo só recebe o mesmo texto uma vez por janela `DEDUP_MS` (`server/dispatch.js:79-81`). Limpeza preguiçosa acima de 800 entradas (`server/dispatch.js:84`). Falhas de envio são logadas por destinatário, sem interromper o laço (`server/dispatch.js:82`).

---

## 5. Integração WhatsApp (Baileys) — `server/whatsapp.js`

Canal **não-oficial** via biblioteca `@whiskeysockets/baileys` (`^6.7.0`, ver `server/package.json:12`), conectando como **WhatsApp Web (multi-device)**. O próprio código alerta: uso interno/demo, **risco de ban**, recomenda número dedicado (`server/whatsapp.js:1`). É descrito como adaptador isolado — trocar pela Cloud API oficial depois mexe só neste arquivo (`server/whatsapp.js:4`).

### 5.1 Ativação e dependências

- Ligado por `WHATSAPP_ENABLED=1` (ou `true`) (`server/whatsapp.js:12`). `init()` só inicia o socket se habilitado (`server/whatsapp.js:60`), chamado no boot (`server/index.js:219`).
- **Workaround Node 18**: a Web Crypto API não é global por padrão (só virou global no Node 20); o código define `globalThis.crypto = require("node:crypto").webcrypto` para evitar "crypto is not defined" em loop de reconexão (`server/whatsapp.js:7-9`).
- Dependências: `qrcode` (gera o QR como data URL) e `pino` (logger, nível `silent`) (`server/whatsapp.js:23-24`, `server/whatsapp.js:30`).

### 5.2 Autenticação via QR / pareamento

`start()` (`server/whatsapp.js:19-48`):

- Carrega/persiste credenciais com `useMultiFileAuthState(AUTH_DIR)`, onde `AUTH_DIR = server/wa-auth` (`server/whatsapp.js:11`, `server/whatsapp.js:26`).
- Casa a versão do WhatsApp Web com `fetchLatestBaileysVersion()` para evitar loop de reconexão (`server/whatsapp.js:27-28`).
- Cria o socket com `makeWASocket({ version, auth: state, ... browser: ["Visao de Patio","Chrome","1.0"] })` (`server/whatsapp.js:30`).
- `creds.update` → `saveCreds` persiste as credenciais em `wa-auth/` automaticamente (`server/whatsapp.js:31`).
- `connection.update` (`server/whatsapp.js:32-42`):
  - Ao receber `qr`, gera um **data URL** via `QRCode.toDataURL` e guarda em `qrDataUrl` para o painel exibir (`server/whatsapp.js:33`). O painel mostra esse QR na tela de Usuários.
  - `connection === "open"` → `connected = true`, limpa o QR (`server/whatsapp.js:34`).
  - `connection === "close"` → reseta estado; se o motivo foi `loggedOut` (`DisconnectReason.loggedOut`), exige re-pareamento e não reconecta; caso contrário, **reconecta automaticamente em 3 s** (`server/whatsapp.js:35-41`).

Flags de controle de estado em memória: `sock`, `connected`, `qrDataUrl`, `starting` (`server/whatsapp.js:14-17`); guardas evitam start concorrente (`server/whatsapp.js:20`).

### 5.3 Status e QR para o painel

`status()` retorna `{ enabled, connected, qr }` (`server/whatsapp.js:59`). Exposto ao superadmin em `GET /api/wa-status` (`server/index.js:120-123`). O painel usa esse `qr` (data URL) para renderizar o QR de pareamento.

### 5.4 Envio de mensagens

`sendText(numberDigits, text)` (`server/whatsapp.js:51-57`):
- Lança erro se desabilitado ou desconectado (`server/whatsapp.js:52-53`).
- Normaliza o número para **somente dígitos** (espera DDI+DDD) e exige no mínimo 10 dígitos (`server/whatsapp.js:54-55`).
- Envia via `sock.sendMessage("<digitos>@s.whatsapp.net", { text })` (`server/whatsapp.js:56`).

### 5.5 Teste manual

`POST /api/wa-test` (superadmin) envia uma mensagem fixa de teste para um número informado, retornando erro 400 se falhar (`server/index.js:124-129`).

---

## 6. Configuração das notificações — `server/settings.js`

Controla, pelo superadmin, **marca**, o que a mensagem mostra e, por tipo de alerta, se notifica + título + instrução extra (`server/settings.js:1-3`). Consumido pelo dispatch via `settings.get()` (`server/dispatch.js:26`, `server/dispatch.js:74`).

### Estrutura (DEFAULTS, `server/settings.js:11-22`)

- `marca` (default `"Visão de Pátio"`), `incluirLocal`, `incluirHora`, `incluirRodape` (booleanos).
- `tipos`: objeto com `atividade`, `fadiga`, `leitura`, `objetos`, cada um com `{ ativo, titulo, instrucao }`.

`normalize(p)` valida/mescla sobre os defaults e limita tamanhos (`titulo` ≤ 80, `instrucao` ≤ 300, `marca` ≤ 80) (`server/settings.js:25-43`). Há um valor inicial síncrono para o dispatch nunca ver `undefined` (`server/settings.js:45`).

### Persistência

Cache em memória; persiste no **Postgres** (`app_settings` id `'notif'`) se configurado, ou em `notif-settings.json` como fallback (`server/settings.js:8`, `server/settings.js:47-72`).

### Endpoints (superadmin)

- `GET /api/notif-settings` — config atual (`server/index.js:101`).
- `PUT`/`PATCH /api/notif-settings` — salva (`server/index.js:102`).
- `POST /api/notif-preview` — **prévia sem salvar**: gera mensagens de exemplo para os 4 tipos usando `dispatch.formatWhatsApp` + `dispatch.classify` (`server/index.js:104-117`).

---

## 7. Gestão de destinatários — `server/recipients.js`

Destinatários de WhatsApp do superadmin (números avulsos), separados dos usuários do sistema. Cache em memória; escrita no Postgres se configurado, ou em `recipients.json` como fallback (`server/recipients.js:1-2`, `server/recipients.js:8-23`).

### Modelo de um destinatário

`{ id, nome, numero, ativo, somenteCriticos, tipos[], criadoEm }` (`server/recipients.js:42`). O `id` é gerado como `"r" + 5 bytes hex` (`server/recipients.js:42`).

### Operações

- `create({nome,numero,somenteCriticos,tipos})` (`server/recipients.js:38-45`): normaliza o número para só dígitos (`server/recipients.js:12`), exige ≥ 10 dígitos (mensagem orienta `DDI+DDD`, ex. `5584999999999`), rejeita número duplicado, e por padrão `ativo: true` e `somenteCriticos` verdadeiro salvo se explicitamente `false`.
- `update(id, patch)` (`server/recipients.js:46-55`): aplica parcialmente `ativo`, `nome`, `numero` (renormalizado), `somenteCriticos`, `tipos`.
- `remove(id)` (`server/recipients.js:56`).
- `all()` retorna a lista em memória (`server/recipients.js:58`), usada pelo dispatch (`server/dispatch.js:57`).

### Persistência (detalhe)

- Se Postgres configurado: `init()` carrega da tabela `recipients`; escrita por `upsert` (`insert ... on conflict (id) do update`) e `delete` (`server/recipients.js:14-23`, `server/recipients.js:25-36`).
- Fallback: `recipients.json` reescrito inteiro a cada mudança (`server/recipients.js:13`).

### Endpoints (superadmin)

- `GET`/`POST /api/recipients` (`server/index.js:88-91`).
- `PATCH`/`DELETE /api/recipients/:id` (`server/index.js:92-97`).

> LGPD: o comentário do módulo registra que o consentimento é de responsabilidade do superadmin (`server/recipients.js:2`). Usuários do sistema, por outro lado, têm **opt-in** próprio (`optInEm`, `server/users.js:125`).

---

## 8. Ingestão de fontes RTSP — `server/rtsp.js`

O navegador **não reproduz RTSP**. Aqui o `ffmpeg` lê o stream RTSP e produz frames JPEG (MJPEG), emitidos como o **mesmo evento `frame`** das câmeras de navegador → o dashboard trata uma câmera IP como qualquer outra (zonas, análise, histórico) sem mudança no front (`server/rtsp.js:1-5`). Requer `ffmpeg` no PATH. O comentário sugere WebRTC (go2rtc/mediamtx) como caminho de produção de baixa latência (`server/rtsp.js:5`).

### 8.1 Configuração das fontes — `loadSources()`

Duas fontes possíveis, nesta ordem de precedência (`server/rtsp.js:14-31`):

1. **Arquivo** `server/rtsp.sources.json` — array `[{ label, url }]`; filtra entradas sem `url` (`server/rtsp.js:16-22`).
2. **Variável de ambiente** `RTSP_SOURCES` — formato `"label=url;label=url"`; sem `=`, usa label automático `RTSP N` (`server/rtsp.js:23-29`).

Se nenhuma fonte existir, loga e não faz nada (`server/rtsp.js:92-95`).

**Exemplo** (`server/rtsp.sources.example.json` — modelo a copiar para `rtsp.sources.json`):

```json
[
  { "label": "Pátio - Expedição", "url": "rtsp://usuario:senha@10.0.0.50:554/Streaming/Channels/101" },
  { "label": "Doca - Carga", "url": "rtsp://usuario:senha@10.0.0.51:554/cam/realmonitor?channel=1&subtype=0" }
]
```

> Note que as URLs RTSP contêm credenciais embutidas (`usuario:senha@`). O `rtsp.sources.json` real, portanto, é um arquivo sensível (ver seção 10). Nos logs a URL é redigida por `redact(url)`, que mascara o trecho `user:pass@` (`server/rtsp.js:33`, `server/rtsp.js:88`).

### 8.2 Parâmetros de captura (env)

| Variável | Default | Uso |
|----------|---------|-----|
| `RTSP_FPS` | `8` | `fps` do filtro ffmpeg |
| `RTSP_WIDTH` | `480` | largura (escala mantendo proporção, `-2`) |
| `RTSP_QUALITY` | `7` | `-q:v` (qualidade JPEG) |

Definidos em `server/rtsp.js:97-101`, aplicados nos args do ffmpeg em `server/rtsp.js:58-62`.

### 8.3 Pipeline por fonte — `startOne()`

Para cada fonte (`server/rtsp.js:47-89`):
- Registra a câmera no mapa `cameras` com `kind: "rtsp"` e id `rtsp-<n>`, e faz `broadcast()` para os dashboards (`server/rtsp.js:48-52`).
- `spawnFfmpeg()` invoca `ffmpeg -rtsp_transport tcp -i <url> -an -vf fps=...,scale=... -f mjpeg -q:v ... pipe:1` (`server/rtsp.js:56-63`).
- **Extração de JPEGs**: `drainFrames()` varre o buffer procurando marcadores SOI (`FFD8`) e EOI (`FFD9`), emitindo cada JPEG completo e mantendo o parcial (`server/rtsp.js:11-12`, `server/rtsp.js:35-45`, `server/rtsp.js:72-78`).
- Cada frame é emitido a `io.to("dashboards").emit("frame", { id, buf: jpeg, ts })` — mesmo formato dos nós webcam; socket.io entrega como ArrayBuffer no cliente (`server/rtsp.js:75-77`).
- **Resiliência**:
  - `ffmpeg` ausente (`ENOENT`) → loga instrução de instalação, remove a câmera e para esta fonte (as câmeras de navegador seguem funcionando) (`server/rtsp.js:65-69`).
  - Stream cai (`close`) → reconecta em 3 s, zerando o buffer (`server/rtsp.js:79-84`).
  - stderr do ffmpeg é silenciado (`server/rtsp.js:71`).

A ingestão é iniciada no boot, depois do `listen`, recebendo `{ io, cameras, broadcast }` (`server/index.js:220-221`, `server/rtsp.js:91-103`).

---

## 9. Diagrama do fluxo completo (evento → alerta → dispatch → WhatsApp)

```
                        ┌──────────────────────────────────────────────┐
                        │  PAINEL (frontend) — detecção de eventos       │
                        │  (fadiga, leitura, objetos, parada de área)    │
                        └───────────────────────┬────────────────────────┘
                                                 │ socket "alert" { text, ts }
                                                 ▼
                        ┌──────────────────────────────────────────────┐
                        │  index.js  io.on("alert")            :205-206  │
                        └──────────┬───────────────────────┬────────────┘
                                   │                        │
                ┌──────────────────▼──────┐   ┌─────────────▼─────────────────────┐
                │ alerts.notify(p)         │   │ dispatch.dispatchAlert(text, ts)   │
                │  • dedup por texto       │   │  guard: enabled + connected? :72   │
                │  • POST webhook genérico │   └─────────────┬─────────────────────┘
                └──────────┬───────────────┘                 │
                           ▼                                  ▼
                ┌──────────────────────┐         classify(text) → {critico, tipo}
                │ Webhook externo       │                     │
                │ Slack/Teams/n8n/...   │         tipo ativo? (settings)  :75
                └──────────────────────┘                     │
                                                              ▼
                                                  formatWhatsApp(text, meta, ts, settings)
                                                              │  (cabeçalho, local, hora, rodapé)
                                                              ▼
                                          targets(meta) = recipients (ativos+filtro)
                                                       ∪ usuários (opt-in+filtro), dedup nº
                                                              │
                                                  para cada nº: dedup "nº|texto"  :79-81
                                                              ▼
                                          whatsapp.sendText(nº, msg)
                                                              ▼
                                          Baileys → WhatsApp Web (multi-device)
                                          sessão persistida em server/wa-auth/
                                                              ▼
                                          📱 Destinatário recebe a notificação
```

Fluxo paralelo (RTSP, alimenta a detecção do painel):

```
Câmera IP ──RTSP──► ffmpeg (rtsp.js) ──JPEG/MJPEG──► io.emit("frame") ──► Dashboard
                                                                          (mesma análise
                                                                           das webcams)
```

---

## 10. Segurança e credenciais

### 10.1 A pasta `server/wa-auth/`

`wa-auth/` é o **estado de sessão / credenciais do WhatsApp (Baileys)**, gerado e mantido por `useMultiFileAuthState(AUTH_DIR)` (`server/whatsapp.js:11`, `server/whatsapp.js:26`). Contém, entre outros, `creds.json` (credenciais da sessão pareada), chaves de pré-chave (`pre-key-*.json`), chaves de sessão/sender (`session-*.json`, `sender-key-*.json`) e chaves de sincronização de estado (`app-state-sync-*.json`).

> O conteúdo desses arquivos **não foi lido** na elaboração deste documento, por conterem material criptográfico sensível.

**Implicações de segurança:**
- Esses arquivos equivalem a uma **sessão de WhatsApp logada**. Quem os possui pode enviar mensagens como o número pareado.
- **NÃO devem ser versionados** (Git) nem expostos em backups públicos, imagens de container ou logs. Recomenda-se adicionar `server/wa-auth/` ao `.gitignore` (**a confirmar** se já está ignorado — não verificado neste levantamento).
- Ao trocar de número ou em caso de vazamento, deslogar no app do WhatsApp e apagar `wa-auth/` força um novo pareamento por QR.

### 10.2 Outras credenciais e segredos

- **`ALERT_WEBHOOK_URL`** — URL do webhook é segredo; o Andon roda no servidor justamente para não expô-la no bundle do navegador (`server/alerts.js:1-2`). Manter apenas em variável de ambiente.
- **`WHATSAPP_ENABLED`** — flag de ativação (`server/whatsapp.js:12`). O canal é **não-oficial** (Baileys), com risco de ban; o próprio código recomenda usar um **número dedicado** (`server/whatsapp.js:1`).
- **URLs RTSP com credenciais embutidas** — `rtsp.sources.json` (e a env `RTSP_SOURCES`) contêm `usuario:senha@host` (ver `server/rtsp.sources.example.json`). O arquivo real é sensível e não deve ser versionado; apenas o `*.example.json` (sem segredos reais) deve ir ao repositório. Nos logs as credenciais são mascaradas por `redact()` (`server/rtsp.js:33`).
- **Persistência local** — `recipients.json`, `notif-settings.json` e `users.json` (fallback sem Postgres) contêm números de WhatsApp e dados de usuários; são dados pessoais (LGPD) e não deveriam ser versionados.
- **Controle de acesso** — todos os endpoints de configuração (recipients, notif-settings, wa-status, wa-test) exigem **superadmin** via `requireSuper` (`server/index.js:36-40`, `server/index.js:88-129`); o socket de alerta exige token de sessão válido (`server/index.js:150-158`).
- **CORS** — a API responde com `Access-Control-Allow-Origin: *` (dev cross-origin); em produção o comentário indica same-origin via nginx/Caddy e `HOST=127.0.0.1` para só ser alcançável pelo reverse proxy (`server/index.js:16-18`, `server/index.js:43`).

---

## 11. Resumo de configuração (variáveis de ambiente)

| Variável | Módulo | Default | Função |
|----------|--------|---------|--------|
| `ALERT_WEBHOOK_URL` | alerts | — | Liga o Andon; URL do webhook |
| `ALERT_DEDUP_MS` | alerts, dispatch | `60000` | Janela de dedup (ambos os módulos) |
| `WHATSAPP_ENABLED` | whatsapp | desligado | `1`/`true` para ativar o canal WhatsApp |
| `RTSP_SOURCES` | rtsp | — | Fontes `label=url;...` (alternativa ao JSON) |
| `RTSP_FPS` | rtsp | `8` | Frames por segundo |
| `RTSP_WIDTH` | rtsp | `480` | Largura do frame |
| `RTSP_QUALITY` | rtsp | `7` | Qualidade JPEG (`-q:v`) |
| `PORT` / `HOST` | index | `4000` / `0.0.0.0` | Porta/host do hub |

Arquivos de configuração relacionados (fallback local quando sem Postgres): `server/rtsp.sources.json` (a partir do `.example.json`), `server/recipients.json`, `server/notif-settings.json`.
