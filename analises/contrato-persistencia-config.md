# Contrato — persistência de zonas + config de câmera (backend + client)

> Onda 1 (esta): camada de contrato no backend + client. Os consumidores front
> (`src/zones.ts`, `src/cameraConfig.ts`, `CameraWorkspace`) migram na **Onda 2**.
> Segue ADR-005 (persistência cache-em-memória + Postgres/fallback JSON) e ADR-006
> (live-sync last-write-wins via `camcfg-updated`). Espelha o padrão de VIEWS/TRIPWIRES.
> LGPD: SÓ geometria/ids/nomes/config — nunca imagem, frame ou PII.

## Endpoints HTTP

Todos sob a origem do hub (prod: nginx faz proxy de `/api/`; dev: `:4000` com CORS).

| Método | Rota                     | Auth               | Corpo             | Resposta          |
| ------ | ------------------------ | ------------------ | ----------------- | ----------------- |
| GET    | `/api/zones/:cameraId`   | `requireAuth`      | —                 | `Zone[]`          |
| PUT    | `/api/zones/:cameraId`   | `requireConfigurer`| `{ zones: Zone[] }` | `Zone[]` (salvo) |
| GET    | `/api/camconfig/:cameraId` | `requireAuth`    | —                 | `CameraCfg \| null` |
| PUT    | `/api/camconfig/:cameraId` | `requireConfigurer`| `{ config: CameraCfg }` | `CameraCfg` (salvo) |

- **`requireAuth`**: qualquer usuário autenticado (401 se sem token válido).
- **`requireConfigurer`**: superadmin OU engenheiro (`users.canConfigure`); 403 caso contrário.
  Coerente com o gate de edição no front (mesma regra dos tripwires).
- **PUT last-write-wins**: substitui a lista/objeto inteiro da câmera. Sem merge incremental.
- **GET camconfig** devolve `null` quando a câmera nunca teve config salva → o front aplica
  os defaults de `src/cameraConfig.ts`.
- **PUT camconfig** com config inválida (não-objeto) → `400 { error: "config inválida" }`.
- Validação defensiva no servidor (`server/camcfg.js`): coords clampadas a 0..1, `modo`
  restrito a `atividade|leitura|objetos|fadiga`, `capture` a `media|alta|maxima`, zonas
  sem `id` descartadas e ids duplicados deduplicados, `selectedClasses` normalizado a
  string[] não vazias. `mask` só é persistida quando presente (retrocompat).

## Evento socket (live-sync — ADR-006)

Após um PUT bem-sucedido o hub emite para a sala `dashboards` o evento **aditivo**
`camcfg-updated` (já existente para views/tripwires — contrato NÃO alterado):

```
{ kind: "zones",     cameraId }   // após PUT /api/zones/:cameraId
{ kind: "camconfig", cameraId }   // após PUT /api/camconfig/:cameraId
```

`kind` agora aceita `"views" | "tripwires" | "zones" | "camconfig"`. A Onda 2 deve
tratar `zones`/`camconfig` re-buscando a câmera afetada (mesmo padrão de `tripwiresRev`
descrito no ADR-006: pular re-fetch durante edição local para não sobrescrever trabalho).

## Client (`src/api.ts`) — assinaturas

Tipos reusados das fontes canônicas (re-exportados via `../api`, sem duplicar):
`Zone` de `src/zones.ts`, `CameraCfg` de `src/cameraConfig.ts`.

```ts
getZones(cameraId: string): Promise<Zone[]>
saveZones(cameraId: string, zones: Zone[]): Promise<Zone[]>
getCamConfig(cameraId: string): Promise<CameraCfg | null>
saveCamConfig(cameraId: string, config: CameraCfg): Promise<CameraCfg>
```

Erros chegam como `ApiError` (mensagem amigável em pt-BR) igual ao resto do client.

## Persistência (`server/camcfg.js`)

Cache em memória (`Map` por `cameraId`) + Postgres quando `db.configured()`, senão
fallback `server/camcfg.json` (mesmo arquivo de views/tripwires; `.gitignore`). Chaves
novas no JSON: `zones` e `camConfigs` (mapas `cameraId → dado`).

Tabelas (`server/schema.sql`, aditivas, idempotentes):

```sql
create table if not exists cam_zones  (camera_id text primary key, data jsonb not null default '[]'::jsonb);
create table if not exists cam_config (camera_id text primary key, data jsonb not null default '{}'::jsonb);
```

## Tipos (referência)

`Zone` (src/zones.ts): `{ id, label, x, y, w, h, modo, mask?, idleAlertMs, sensitivity, atividade, ponto, selectedClasses[] }` — `x,y,w,h` normalizados 0..1; `modo ∈ atividade|leitura|objetos|fadiga`.

`CameraCfg` (src/cameraConfig.ts): `{ modo, pontoLeitura, capture, selectedClasses[] }` — `capture ∈ media|alta|maxima`.
