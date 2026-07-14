# control-plane — Fase 0 (fundação de segurança)

Serviço **separado** do hub (spec: `docs/analises/spec-control-plane.md` §7). Idioma da casa:
`node:http` + `pg` nativo, sem framework, sem ORM, sem IdP. **Fase 0 = só a fundação segura + os
gates.** Sem UI, sem cadastro (isso é a Fase 1).

## Arquivos

| arquivo | o quê |
|---|---|
| `schema.sql` | as 6 tabelas (partner→cliente→site, app_user, membership, alarm_event) + **RLS `FORCE` na `alarm_event`**. Idempotente. |
| `db.js` | `pg.Pool` + **`withTenant(siteId, fn)`** — transação com `set_config('app.current_tenant', …, true)` (transaction-scoped, fail-closed). |
| `auth.js` | token HMAC com **escopo** (`{id,papel,scope_type,scope_id,exp}`) + **`canAccess(claims, resource, tree)`** puro. |
| `index.js` | servidor mínimo: `/health` + esqueleto do `ctx` (`json`/`readBody`/`requireScope`). |
| `auth.test.js` | `canAccess` + token, **roda sempre** (puro, sem banco). |
| `rls.test.js` | **o GATE de isolamento** — exige Postgres real; SKIP declarado sem ele. |

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
