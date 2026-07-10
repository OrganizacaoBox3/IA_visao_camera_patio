# Contrato — Eventos de Alarme com Acknowledge (Onda B)

> Espinha dorsal de **EVENTOS DE ALARME** (fila acionável com acknowledge), item 7 da Onda B
> do `benchmark-interfaces/00-sintese-recomendacoes.md`. Backend puro (Node, sem dependências
> novas). Documento de contrato para as frentes **B3 (relatório)** e **B4 (central)** consumirem.
>
> Arquivos: `server/events.js` (store, novo), `server/index.js` (integração + API),
> `server/schema.sql` (tabela `alarm_events`). Fallback JSON: `server/alarms.json`.

---

## 1. Modelo do evento de alarme (SÓ METADADOS)

Cada evento é **apenas metadados** — texto, identificadores e timestamps. **Nunca** imagem/frame.

```jsonc
{
  "id": "a1b2c3...",          // string única, gerada no servidor
  "ts": 1700000000000,        // epoch-ms do alarme (da decisão da política)
  "cameraId": "rtsp-1",       // string | ausente — id da câmera (ausente se não identificável)
  "cameraLabel": "Doca 2",    // string | ausente — rótulo amigável (resolvido das câmeras vivas)
  "zona": "doca2",            // string | ausente — zona/área lógica
  "tipo": "atividade",        // atividade | fadiga | leitura | objetos (classificação da política)
  "priority": "high",         // advisory | high | critical (JÁ calculada pela política)
  "text": "Doca 2 sem movimentação há 15 min.", // texto do alarme (pode ser resumo de causa-raiz)
  "state": "new",             // new | acknowledged | forwarded
  "ackBy": "joao",            // string | ausente — quem reconheceu/encaminhou
  "ackAt": 1700000050000      // epoch-ms | ausente — quando reconheceu/encaminhou
}
```

Notas de campo:
- `priority` vem direto da decisão de `alarmPolicy.evaluate` (não é recalculada aqui) — mantém
  a meta EEMUA 191 de `critical` baixo.
- `cameraId`/`zona` valem `undefined` quando a política não os identifica (ou usa sentinelas `_`/`*`,
  que são normalizadas para ausentes).
- Campos string vazios são omitidos (normalização `clean()`).

---

## 2. API HTTP

Base: mesmo hub (`server/index.js`), respostas JSON. **Auth:** qualquer usuário autenticado
(`requireAuth`, header `Authorization: Bearer <token>`) — mesmo padrão dos endpoints de
dados/indicadores (`/api/data/*`). 401 se token inválido.

### `GET /api/alarms`
Lista eventos, sempre ordenados por `ts desc` (mais recente primeiro).

| Query param | Tipo | Default | Efeito |
|---|---|---|---|
| `limit` | int | 200 | Máx. de eventos (teto = retenção, ver §4). |
| `since` | epoch-ms | — | Só eventos com `ts > since` (polling incremental). |
| `state` | `new\|acknowledged\|forwarded` | — | Filtra por estado. |
| `priority` | `advisory\|high\|critical` | — | Filtra por prioridade. |

- **Auth:** usuário logado.
- **Resposta:** `200` → `Array<Evento>` (modelo da §1). Params inválidos são ignorados (não erram).
- Ex.: `GET /api/alarms?state=new&priority=critical&limit=50`

### `POST /api/alarms/:id/ack`
Marca o evento como `acknowledged`.

- **Auth:** usuário logado.
- **Body (opcional):** `{ "by"?: string }` — se omitido, usa `usuario` do token.
- **Resposta:** `200` → `Evento` atualizado (`state:"acknowledged"`, `ackBy`, `ackAt`).
  `404 { error }` se o id não existir.
- **Efeito colateral:** emite socket `alarm-update` para os painéis.

### `POST /api/alarms/:id/forward` (opcional)
Marca o evento como `forwarded` (encaminhado).

- **Auth:** usuário logado.
- **Body (opcional):** `{ "by"?: string }`.
- **Resposta:** `200` → `Evento` atualizado (`state:"forwarded"`). `404 { error }` se não existir.
- **Efeito colateral:** emite socket `alarm-update`.

`:id` casa `^/api/alarms/([\w-]+)/(ack|forward)$`.

---

## 3. Eventos socket.io (ADITIVOS)

Novos eventos emitidos do servidor para a sala `"dashboards"`. **Não alteram** nem substituem
`frame`, `cameras`, `alert`, `camera-status` (intactos).

| Evento | Quando | Payload |
|---|---|---|
| `alarm-event` | Um novo alarme é gravado (a política decidiu enviar). | `Evento` (modelo §1, `state:"new"`). |
| `alarm-update` | Um alarme muda de estado (ack/forward). | `Evento` atualizado. |

Painéis ao vivo devem: ao receber `alarm-event` inserir no topo da fila; ao receber `alarm-update`
casar por `id` e substituir.

---

## 4. Persistência, retenção e LGPD

### Padrão (espelha `recipients.js`/`settings.js`)
Cache em memória **+** Postgres quando `db.configured()`; senão **fallback** em
`server/alarms.json`. A escolha é feita no `init()` (flag `usingPg`). O hub continua de pé sem PG.

- **Com Postgres:** tabela `alarm_events` (ver `server/schema.sql`). `record`/`ack`/`forward`
  fazem `insert ... on conflict (id) do update`; `init()` carrega os últimos N por `ts desc`.
- **Sem Postgres:** `server/alarms.json` reescrito inteiro a cada mudança.
- O cache em memória é sempre ordenado por `ts desc` e serve `GET /api/alarms` (rápido, síncrono).

### Tabela `alarm_events`
`id (PK text)`, `ts bigint`, `camera_id`, `camera_label`, `zona`, `tipo`, `priority`
(`advisory|high|critical`), `text`, `state` (`new|acknowledged|forwarded`), `ack_by`,
`ack_at bigint`. Índice `idx_alarm_events_ts (ts desc)`. Adicionada de forma idempotente
(`create table if not exists`), sem tocar nas tabelas existentes.

### Retenção (configurável)
| Env | Default | Efeito |
|---|---|---|
| `ALARM_EVENTS_RETENTION` | `1000` | Nº máximo de eventos guardados (corta os mais antigos). |
| `ALARM_EVENTS_RETENTION_DAYS` | `0` (off) | Descarta eventos com mais de X dias (0 desliga). |

A retenção é aplicada após cada `record` (no cache, no JSON e — com PG — via `delete` por idade
e por excedente de contagem).

### LGPD (OBRIGATÓRIO)
- **Só metadados.** Nenhum campo guarda imagem/frame; não há snapshot por padrão.
- Todos os campos são texto/identificadores/timestamps — consistente com o princípio do schema
  ("só indicadores, nunca imagens").
- `server/alarms.json` (fallback) contém metadados operacionais; tratar como dado interno
  (não versionar), como os demais `*.json` de fallback.

---

## 5. Integração com a política (ponto único)

No handler socket `alert` (`server/index.js`), `alarmPolicy.evaluate(p)` decide **uma vez**
(`null` = suprimido). Quando há decisão, além de Andon (`alerts.notify`) e WhatsApp
(`dispatch.dispatchAlert`), o servidor grava o evento reusando a **mesma decisão** (com a
`priority` já calculada) e emite `alarm-event`. Não há reclassificação nem duplicação:
dedup/supressão de inundação continuam acontecendo na política antes de chegar aqui.

---

## 6. Observabilidade

Logger `pino` (`name:"alarm-events"`, nível `ALARM_LOG_LEVEL`, default `info`):
- `record` → log `info` com `{ id, cameraId, tipo, priority, state }`.
- `ack`/`forward` → log `info` com `{ id, ackBy/by, state }`.
- Falhas de persistência/retenção → log `error`.
