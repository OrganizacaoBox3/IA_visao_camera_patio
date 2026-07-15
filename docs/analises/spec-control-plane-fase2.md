# SPEC — Control-plane Fase 2: agregação + o portal (SPA)

> Deriva de `spec-control-plane.md` (Fase 2). Fases 0 (fundação+RLS) e 1 (cadastro+login+ingest+hub
> se registra) já no main. Esta fase dá o LADO VISÍVEL: ler os alarmes que a Fase 1 grava, e a SPA
> que mostra a frota por escopo. **Fase 3 (vídeo por túnel) fica FORA** — é a mais complexa e não é
> MVP para "ver seus clientes".

## O que a Fase 1 já entregou (não refazer)
- `POST /api/ingest/alarm` GRAVA `alarm_event` via `withTenant(site_id)` (RLS). `POST /api/site/heartbeat`
  atualiza `site.last_seen`. CRUD scoped de partners/clientes/sites/users/memberships. `POST /api/login`
  → token com escopo. `canAccess` + `withTenant` funcionando.

## Fase 2 — o delta

### Backend (control-plane/, aditivo em routes.js + um overview.js)
1. **`GET /api/overview`** — a frota do escopo do chamador, numa chamada:
   `{ scope, partners:[{id,nome}], clientes:[{id,partner_id,nome}], sites:[{id,cliente_id,nome,last_seen,online,alarms24h}] }`
   Só os nós ACESSÍVEIS (reusa o filtro `canAccess`/`scopeInTree` do CRUD). `online` = `now - last_seen <
   ONLINE_MS` (10 min = 2× heartbeat). `alarms24h` = contagem de `alarm_event` das últimas 24h POR SITE,
   cada uma via `withTenant(site_id)` (RLS-safe). Custo: N transações (N = sites acessíveis) — aceitável no
   MVP; se N crescer muito, cap + nota (declarar o limite, nunca truncar em silêncio).
2. **`GET /api/sites/:id/alarms?limit=&since=`** — drill-down: `canAccess(site)` → `withTenant(site)` →
   `select ... from alarm_event where ts >= since order by ts desc limit N`. Devolve `{ alarms:[{id,tipo,ts,meta}] }`.
   Paginação simples por `since`/`limit` (default limit 50, teto 500).
3. Testes: overview scoped (partner-admin de B não vê site de A; contagem por site correta) + alarms
   drill-down (403 fora do escopo; withTenant isola). Rodam com PG (skip declarado sem, padrão da casa).

### Frontend — o portal (control-plane/web/, Vite+React+TS standalone)
App PRÓPRIO (o portal é central, deploy separado do hub silo — não vive em src/). Idioma React da casa,
com um conjunto MÍNIMO de estilo/átomos local (tokens + Button/Table/Badge enxutos — compartilhar o
`src/ui` do hub é monorepo, fica para depois; declarado).
- **Login** (`POST /api/login`) → guarda o token (memória + sessionStorage) + o escopo.
- **Frota** (home, `GET /api/overview`): árvore partner → cliente → site; cada site com nome, ONLINE/
  OFFLINE (going-gray: cor + texto), e "N alarmes (24h)". Vazio honesto ("nenhum site no seu escopo").
- **Site** (`GET /api/sites/:id/alarms`): a lista de alarmes do site (tipo, hora, câmera/zona do meta),
  com "carregar mais". Sem vídeo (Fase 3).
- Serve em dev por vite; em produção o build estático pode ser servido pelo próprio control-plane
  (`index.js` ganha um static handler simples) OU por um estático à parte — o build agent decide o mais
  simples e reversível.

## Contrato de API entre as frentes (fixo)
- `GET /api/overview` (Bearer token) → `{ scope:{scope_type,scope_id,role}, partners, clientes, sites }`
  (sites com `last_seen:number|null`, `online:boolean`, `alarms24h:number`).
- `GET /api/sites/:id/alarms?limit=50&since=0` (Bearer token) → `{ alarms:[{id,tipo,ts,meta}] }`.
- Erros: 401 sem/inválido token; 403 fora do escopo; JSON `{error}`.

## Invariantes
- **RLS intacta:** ler `alarm_event` SÓ via `withTenant` (a Fase 0 não se afrouxa). O `canAccess` decide
  QUAIS sites; o `withTenant` isola a leitura de CADA um.
- **LGPD:** o plane só tem metadados (o `meta` do alarme). Nenhum frame. Nada muda aqui.
- **Aditivo:** o hub silo segue intacto; a Fase 1 (ingest/cadastro) não é tocada, só estendida.

## Fora de escopo (declarado)
Fase 3 (vídeo por túnel, ADR-010); compartilhar o design-system entre hub e portal (monorepo);
paginação sofisticada; edição de cadastro pela SPA (o CRUD existe na API; a UI de cadastro é uma 2ª leva).
