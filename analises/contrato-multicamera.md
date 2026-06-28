# Contrato — Backend Multi-câmera (Frente A4)

> Contrato dos endpoints HTTP e eventos socket.io **novos/alterados** pela Frente A4
> (`server/rtsp.js`, `server/index.js`, `server/cameras.js`). Documento para a
> **Frente A2 (Config + Dashboard + CameraPage)** consumir.
>
> Base: código real em `server/`. Os eventos/endpoints **existentes** (`frame`,
> `cameras`, `set-capture`, `capture`, `alert`, login, etc.) seguem **inalterados** —
> ver `docs-regenerada/05` e `06`. Aqui só o que mudou.

---

## 1. Resumo do que mudou

| Área | Novo/alterado |
|---|---|
| Reconexão RTSP | Retry fixo de 3s → **backoff exponencial limitado** + **health-check** de stream congelado (`rtsp.js`) |
| Status por câmera | **Novo evento socket `camera-status`** (RTSP e navegador) |
| CRUD de câmeras | **Novos endpoints HTTP `/api/cameras`** (GET/POST/PATCH/DELETE) — add/remove/list em runtime, sem reiniciar o hub |
| Persistência | Câmeras dinâmicas em **`server/cameras.json`** (legadas seguem em `rtsp.sources.json`/env) |
| Transporte | **Transporte flexível**: RTSP (tcp/udp/http/auto), **HLS (.m3u8)** e **MJPEG (http)** detectados pelo esquema da URL |

O evento `frame` e o evento `cameras` **continuam idênticos** — A2 não precisa mudar o relé de vídeo nem a montagem da grade. `camera-status` é **aditivo** (a UI pode ignorar e nada quebra).

---

## 2. Evento socket `camera-status` (NOVO)

Emitido **servidor → sala `dashboards`**. Informa o estado de conexão de cada câmera.

### Payload

```ts
type CameraStatus = {
  id: string;        // mesmo id usado em `cameras` e no evento `frame`
  state: "connecting" | "online" | "error" | "stopped";
  fps?: number;      // fps real medido (só RTSP; navegador não envia)
  lastError?: string | null; // mensagem do último erro (ex.: "stream congelado"); null quando online
  label?: string;    // rótulo da câmera (conveniência)
  kind?: "rtsp" | "browser"; // origem da câmera
};
```

### Estados

| state | Significado |
|---|---|
| `connecting` | ffmpeg subindo / reconectando (ainda sem frames) |
| `online` | recebendo frames dentro da janela de saúde |
| `error` | erro persistente: stream congelado, ffmpeg ausente, ou desistência após `RTSP_MAX_RETRIES` |
| `stopped` | câmera removida/desabilitada (RTSP) ou nó de navegador desconectado |

### Quando é emitido

- **RTSP** (`rtsp.js`):
  - na criação da fonte (`connecting`);
  - na **mudança de estado** (connecting → online → error…);
  - **periodicamente** a cada `RTSP_STATUS_MS` (default 5000ms) com o `fps` atualizado enquanto online;
  - ao remover/desabilitar (`stopped`).
- **Navegador** (`index.js`):
  - ao conectar a câmera (`online`);
  - ao desconectar (`stopped`).
- **Snapshot inicial**: quando um dashboard conecta, o servidor envia **um `camera-status` por câmera** conhecida (logo após o `cameras`), para a UI hidratar o estado sem esperar a próxima transição.

### Recomendação de consumo (A2)

```ts
const status = new Map<string, CameraStatus>();
socket.on("camera-status", (s: CameraStatus) => status.set(s.id, s));
socket.on("cameras", (list) => { /* tiles; cruze com status.get(id) p/ badge online/erro/fps */ });
```

> Câmera **listada em `cameras`** mas com `camera-status.state !== "online"` ⇒ mostrar badge de erro/reconexão. Câmera com `state === "stopped"` normalmente também sai da lista `cameras` (RTSP removida / nó desconectado).

---

## 3. Endpoints HTTP `/api/cameras` (NOVOS)

CRUD das câmeras IP/RTSP **dinâmicas** (adicionadas em runtime pela UI). Persistido em `server/cameras.json`. As fontes legadas de `rtsp.sources.json`/env **não** aparecem aqui (são read-only, sobem só no boot com ids `rtsp-1`, `rtsp-2`…).

**Auth: `superadmin`** em todos (mesma guarda `requireSuper` de `/api/users` e `/api/recipients`) — header `Authorization: Bearer <token>`. Sem token → 401; sem ser superadmin → 403.

### Modelo de uma câmera

```ts
type Camera = {
  id: string;          // estável, gerado: "cam-<10 hex>" (NÃO posicional — não quebra zonas ao reordenar)
  label: string;
  url: string;         // rtsp:// | rtsps:// | http(s):// (HLS .m3u8 ou MJPEG). Sensível: pode conter credenciais
  transport?: "tcp" | "udp" | "http" | "auto"; // só p/ rtsp; ausente = tcp (default). "auto" omite o flag
  fps?: number;        // 1–30; ausente = default global (env RTSP_FPS, 8)
  width?: number;      // 160–1920; ausente = default global (env RTSP_WIDTH, 480)
  quality?: number;    // 1–31 (-q:v do ffmpeg, menor = melhor); ausente = default (env RTSP_QUALITY, 7)
  enabled: boolean;    // false = cadastrada mas com ffmpeg parado
  criadoEm: number;    // epoch-ms
};
```

### Endpoints

| Método | Rota | Auth | Body | Resposta | Efeito em runtime |
|---|---|---|---|---|---|
| GET | `/api/cameras` | superadmin | — | `Camera[]` | — |
| POST | `/api/cameras` | superadmin | `{ label?, url, transport?, fps?, width?, quality?, enabled? }` | 201 `Camera` · 400 `{error}` | se `enabled !== false`, **sobe o ffmpeg** (sem reiniciar o hub) |
| PATCH | `/api/cameras/:id` | superadmin | qualquer subconjunto do modelo | 200 `Camera` · 400 `{error}` | `enabled:false` → **para** o stream; senão **reinicia** com os novos parâmetros |
| DELETE | `/api/cameras/:id` | superadmin | — | 200 `{ ok:true }` · 404 `{error}` | **para e remove** o stream |

- `:id` casa `^/api/cameras/([\w-]+)$`.
- **Validação** (400): `url` obrigatória e deve começar com `rtsp://`, `rtsps://` ou `http(s)://`. `fps/width/quality` são "clampados" às faixas acima.
- **GET retorna a `url` completa** (com credenciais) — é endpoint superadmin. Tratar como sensível na UI (não logar/expor). Nos logs do servidor a URL é mascarada (`redact`).

### Exemplos

Adicionar uma câmera RTSP (UDP):
```http
POST /api/cameras
Authorization: Bearer <token-superadmin>
Content-Type: application/json

{ "label": "Doca 3", "url": "rtsp://user:pass@10.0.0.52:554/Streaming/Channels/101", "transport": "udp" }
```
→ `201 { "id": "cam-1a2b3c4d5e", "label": "Doca 3", "url": "...", "transport": "udp", "enabled": true, "criadoEm": 1750000000000 }`

Adicionar um feed HLS de demonstração (sem transporte — http autodetectado):
```http
POST /api/cameras
{ "label": "Demo HLS", "url": "https://exemplo.com/stream/playlist.m3u8" }
```

Desabilitar temporariamente (mantém o cadastro, para o ffmpeg):
```http
PATCH /api/cameras/cam-1a2b3c4d5e
{ "enabled": false }
```

Após cada operação, A2 deve esperar os eventos `cameras` (lista) e `camera-status` (estado) chegarem pelo socket — a API HTTP **não** retorna o estado de conexão, só o cadastro.

---

## 4. Reconexão e health-check (comportamento; sem API nova)

Mudanças internas em `rtsp.js` que A2 percebe **apenas** via `camera-status`:

- **Backoff exponencial limitado**: espera `min(BASE * 2^(tentativa-1), MAX)` entre reconexões, reiniciando a contagem ao receber o 1º frame. Defaults: base 2000ms, teto 30000ms.
- **Health-check de congelamento**: se o ffmpeg fica vivo mas para de entregar frames por `RTSP_STALE_MS` (default 15000ms), o stream é considerado `error`, o processo é morto e reconecta com backoff.
- **ffmpeg ausente** (`ENOENT`): a câmera fica `error` com `lastError: "ffmpeg não encontrado no PATH"` e **não** fica em loop de retry. As câmeras de navegador seguem funcionando.

### Variáveis de ambiente (novas)

| Env | Default | Função |
|---|---|---|
| `RTSP_RECONNECT_BASE_MS` | 2000 | 1ª espera do backoff |
| `RTSP_RECONNECT_MAX_MS` | 30000 | teto do backoff |
| `RTSP_MAX_RETRIES` | 0 | máx. de tentativas consecutivas (`0` = ilimitado; o delay já é limitado) |
| `RTSP_STALE_MS` | 15000 | tempo sem frame que marca "congelado" |
| `RTSP_STATUS_MS` | 5000 | cadência do refresh de fps/status |

As envs existentes `RTSP_FPS`/`RTSP_WIDTH`/`RTSP_QUALITY`/`RTSP_SOURCES` seguem válidas (defaults globais; sobrescritos por câmera quando o cadastro informa `fps/width/quality`).

---

## 5. Transporte flexível (detecção por URL)

`rtsp.js` monta os args de input do ffmpeg conforme o esquema da `url`:

| URL | Args de input | Observação |
|---|---|---|
| `rtsp://` / `rtsps://` | `-rtsp_transport <tcp\|udp\|http> -i <url>` | default `tcp`; `transport:"auto"` **omite** o flag (ffmpeg decide) |
| `http(s)://…​.m3u8` | `-i <url>` | HLS — ffmpeg autodetecta |
| `http(s)://…` (MJPEG/outros) | `-i <url>` | MJPEG/HTTP — ffmpeg autodetecta |

Em todos os casos a saída é re-codificada para MJPEG e entregue no **mesmo evento `frame`** — A2 não distingue a origem.

---

## 6. Compatibilidade / não-quebra

- Eventos `frame`, `cameras`, `set-capture`, `capture`, `alert`: **inalterados**.
- Câmeras legadas (`rtsp.sources.json`/`RTSP_SOURCES`) seguem subindo no boot com ids `rtsp-1`, `rtsp-2`… (ids posicionais preservados — não quebra zonas/config já salvas).
- `camera-status` é **aditivo**: um dashboard que não escuta o evento continua funcionando como hoje.
- Persistência das câmeras dinâmicas é em arquivo JSON (`server/cameras.json`) — **não** houve mudança de schema do Postgres. Arquivo sensível (URLs com credenciais): manter fora do versionamento.
