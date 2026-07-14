# control-plane — Fase 0 + Fase 1 (fundação de segurança + cadastro/login/ingest)

Serviço **separado** do hub (spec: `docs/analises/spec-control-plane.md` §7). Idioma da casa:
`node:http` + `pg` nativo, sem framework, sem ORM, sem IdP. **Fase 0** = a fundação segura + os
gates (schema, RLS, `withTenant`, `canAccess`, token com escopo). **Fase 1** (esta) = cadastro +
login + o ingest hub→plane. Sem UI ainda (SPA é a Fase 2).

## Arquivos

| arquivo | o quê |
|---|---|
| `schema.sql` | as 6 tabelas (partner→cliente→site, app_user, membership, alarm_event) + **RLS `FORCE` na `alarm_event`** + (Fase 1, aditivo) `site.site_key_hash`/`site.last_seen`. Idempotente. |
| `db.js` | `pg.Pool` + **`withTenant(siteId, fn)`** — transação com `set_config('app.current_tenant', …, true)` (transaction-scoped, fail-closed). |
| `auth.js` | token HMAC com **escopo** (`{id,papel,scope_type,scope_id,exp}`) + **`canAccess(claims, resource, tree)`** puro. |
| `password.js` | scrypt (`hashPassword`/`verifyPassword`) — **mesmo esquema do hub** (`server/users.js`). |
| `sitekey.js` | credencial do hub silo: `generateSiteKey` (randomBytes) + hash sha256 + `verifySiteKey` timing-safe. Guardamos só o HASH. |
| `stores.js` | CRUD (partner/cliente/site/app_user/membership) via `db.query` — cadastro **não** tem RLS de linha (isolamento é `canAccess` no app, spec §5). |
| `access.js` | monta a fatia da árvore do banco e chama `canAccess` — `guardAccess`/`guardScope`/`scopeInTree`. Todo handler passa por aqui. |
| `login.js` | `selectScope` puro: >1 membership → o token leva a de **maior privilégio** (platform>partner>cliente>site). |
| `routes.js` | as rotas da API (login + CRUD + ingest/heartbeat), cada CRUD atrás de `requireScope` + `canAccess`. |
| `index.js` | servidor: `/health` + `ctx` + dispatch p/ `routes.handle`. |
| `seed.js` | bootstrap idempotente do platform-admin (`npm run seed`). |
| `auth.test.js` / `login.test.js` / `access.test.js` / `sitekey.test.js` | **puros, rodam sempre** (sem banco). |
| `rls.test.js` / `cadastro.pg.test.js` | exigem Postgres real; SKIP declarado sem ele. |

## Bootstrap (o ovo-galinha) — `npm run seed`

Sem nenhum usuário não dá p/ logar. `seed.js` cria (idempotente) um **platform-admin** a partir de
env, no molde do superadmin do hub:

```bash
cd control-plane
CP_DATABASE_URL="postgres://cp_app:cp_app_pw@localhost:55432/control_plane" \
  CP_ADMIN_EMAIL="admin@voce.com" CP_ADMIN_PASSWORD="troque-isto" \
  npm run seed
```

Sem `CP_ADMIN_PASSWORD` ele usa um **default inseguro** (com WARN gritado) — só p/ dev. Reexecutar
não duplica e **não** sobrescreve a senha de um usuário já existente.

## API (Fase 1)

- `POST /api/login` `{email, senha}` → `{token, user, scope}`. Sem membership → 403.
- CRUD `/api/partners`, `/api/clientes`, `/api/sites`, `/api/users`, `/api/memberships` (Bearer token;
  cada um atrás de `canAccess` no recurso/escopo alvo — herança para baixo, spec §3).
  - **Criar site** devolve a `site_key` **crua UMA vez** (padrão API key); o banco guarda só o hash.
- `POST /api/ingest/alarm` e `POST /api/site/heartbeat` — **autenticados por site**, não por token de
  usuário (ver o contrato abaixo).

### Contrato hub → plane (ingest/heartbeat)

Auth por header: **`x-site-id`** + **`x-site-key`** (a chave em texto; o plane compara com o HASH
guardado, timing-safe). `site inexistente → 404`, `site_key errada → 401`.

```
POST {CP_URL}/api/ingest/alarm
  x-site-id: <SITE_ID>   x-site-key: <SITE_KEY>
  body = evento do hub (events.record): { id, ts, cameraId, cameraLabel, zona, tipo, priority, text, state }
  → 202. Grava em alarm_event via withTenant(site_id): tipo=body.tipo, ts=body.ts,
        meta = jsonb do resto ({id,cameraId,cameraLabel,zona,priority,text,state}).

POST {CP_URL}/api/site/heartbeat   (mesma auth) → 200, atualiza site.last_seen.
```

No **hub** (Frente B), as envs `CP_URL` / `SITE_ID` / `SITE_KEY` regem o forwarder — **ausente →
inerte** (a disciplina da casa).

## O usuário `pg` (invariante do §5)

O control-plane **DEVE** conectar como um usuário **não-dono e SEM `BYPASSRLS`** — um superuser (ou o
dono da tabela) ignora a RLS e o isolamento vira fantasia. O `FORCE ROW LEVEL SECURITY` do `schema.sql`
faz a policy valer até para o dono (cinto e suspensório). Setup (o dono roda uma vez):

```sql
CREATE DATABASE control_plane;
-- aplicar schema.sql como um usuário ADMIN (vira o dono das tabelas), depois:
CREATE ROLE cp_app LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE control_plane TO cp_app;
GRANT USAGE ON SCHEMA public TO cp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cp_app;
```

O `docker-compose.yml` + `init/02-grants.sql` já fazem exatamente isso para rodar o gate localmente.

## Envs (prefixo `CP_`, não colidem com o hub)

- `CP_DATABASE_URL` **ou** `CP_PGHOST`/`CP_PGPORT`/`CP_PGUSER`/`CP_PGPASSWORD`/`CP_PGDATABASE`
- `CP_AUTH_SECRET` (troque em produção — o default é inseguro), `CP_AUTH_TTL_MS`, `CP_PORT` (default 4100)

## Rodar o gate de RLS

```bash
cd control-plane && docker compose up -d          # sobe PG + cp_app sem BYPASSRLS
CP_DATABASE_URL="postgres://cp_app:cp_app_pw@localhost:55432/control_plane" \
  npx vitest run control-plane/rls.test.js
docker compose down -v
```

Sem Postgres, `rls.test.js` faz **SKIP** (e imprime um aviso). O `auth.test.js` roda sempre.
