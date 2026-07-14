-- ════════════════════════════════════════════════════════════════════════════
-- Control-plane — esquema do POOL (um banco único, multi-cliente). Fase 0.
-- Ver docs/analises/spec-control-plane.md §2 (modelo de dados) e §5 (o furo do RLS).
--
-- LGPD: só CADASTRO + METADADO AGREGADO. `alarm_event` NUNCA guarda frame/imagem —
-- só {tipo, ts, meta_jsonb}. Nenhum vídeo vive aqui (o vídeo é Silo, fica no site).
--
-- Idempotente: CREATE ... IF NOT EXISTS + guards em DO-blocks. Aditivo — reexecutar
-- não altera tabelas existentes nem apaga dado. O hub roda o seu schema.sql; este é
-- de um SERVIÇO SEPARADO (control-plane/), com o seu próprio banco.
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- SETUP DO USUÁRIO DE CONEXÃO (o §5 do spec, camadas 2 e 3 — LEIA antes de subir):
--
--   O control-plane DEVE conectar como um usuário NÃO-DONO e SEM BYPASSRLS. Um
--   superuser (ou o DONO da tabela) IGNORA a RLS — e aí o isolamento entre clientes
--   é fantasia. Crie o banco e o usuário do app assim (o dono roda isto UMA vez;
--   o app NUNCA conecta como dono):
--
--     CREATE DATABASE control_plane;
--     -- conecte no control_plane e rode este schema.sql como um usuário ADMIN
--     -- (que vira o DONO das tabelas). Depois crie o usuário do app:
--     CREATE ROLE cp_app LOGIN PASSWORD '...';            -- NÃO superuser, NÃO BYPASSRLS
--     GRANT CONNECT ON DATABASE control_plane TO cp_app;
--     GRANT USAGE ON SCHEMA public TO cp_app;
--     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cp_app;
--     GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cp_app;
--
--   O `FORCE ROW LEVEL SECURITY` (abaixo) faz a RLS valer ATÉ para o dono da tabela —
--   cinto e suspensório, caso um dia o app conecte como dono por engano.
-- ────────────────────────────────────────────────────────────────────────────

-- ── CADASTRO: a hierarquia (partner → cliente → site), por FK auto-referente ──
-- Sem tenant_id redundante no cadastro: a árvore JÁ é a hierarquia (spec §2). O
-- isolamento das tabelas de cadastro é por canAccess() no app (a subárvore do escopo
-- do token), NÃO por RLS de linha — o que precisa de RLS é o DADO agregado (alarm_event).

create table if not exists partner (          -- o integrador/revenda
  id text primary key,
  nome text not null,
  criado_em bigint not null
);

create table if not exists cliente (          -- a conta final
  id text primary key,
  partner_id text not null references partner(id) on delete restrict,
  nome text not null,
  criado_em bigint not null
);
create index if not exists cliente_partner_idx on cliente(partner_id);

create table if not exists site (             -- 1:1 com um hub silo (site_key = credencial do hub)
  id text primary key,
  cliente_id text not null references cliente(id) on delete restrict,
  nome text not null,
  site_key text unique,
  criado_em bigint not null
);
create index if not exists site_cliente_idx on site(cliente_id);

-- ── CADASTRO: pessoas + o ESCOPO (membership como tabela de junção) ───────────
create table if not exists app_user (         -- pessoa (senha scrypt, mesmo esquema do hub)
  id text primary key,
  email text unique not null,
  senha_hash text not null,
  ativo boolean not null default true,
  criado_em bigint not null
);

-- membership É o RBAC-com-escopo: um usuário pode ter papéis diferentes em escopos
-- diferentes (admin de um cliente, operador de outro). scope_type ∈
-- {platform, partner, cliente, site}; scope_id aponta a linha do respectivo nível
-- (NULL quando scope_type='platform' — o topo vê tudo). role é o papel naquele escopo.
create table if not exists membership (
  id text primary key,
  user_id text not null references app_user(id) on delete cascade,
  scope_type text not null check (scope_type in ('platform','partner','cliente','site')),
  scope_id text,                              -- NULL sse platform; senão o id do partner/cliente/site
  role text not null,
  criado_em bigint not null
);
create index if not exists membership_user_idx on membership(user_id);

-- ── DADO AGREGADO: alarm_event — o tenant é o site_id ─────────────────────────
-- LGPD: SÓ metadado. `meta` é jsonb de indicadores (nunca imagem/frame). Esta é a
-- ÚNICA tabela com RLS de linha (o dado por tenant); o tenant = site_id.
create table if not exists alarm_event (
  id bigserial primary key,
  site_id text not null references site(id) on delete cascade,
  tipo text not null,
  ts bigint not null,
  meta jsonb
);
create index if not exists alarm_event_site_idx on alarm_event(site_id);
create index if not exists alarm_event_ts_idx on alarm_event(ts);

-- ════════════════════════════════════════════════════════════════════════════
-- RLS na alarm_event — o GATE de isolamento (§5). As 4 camadas:
--   (1) o middleware usa set_config('app.current_tenant', $1, true) TRANSACTION-scoped
--       (control-plane/db.js withTenant) — fail-CLOSED por construção.
--   (2) FORCE ROW LEVEL SECURITY (abaixo) — vale até para o dono da tabela.
--   (3) usuário de conexão sem BYPASSRLS (o setup no topo deste arquivo).
--   (4) PgBouncer, se um dia entrar: só transaction pooling (GUC é por sessão).
--
-- A policy: só enxerga/insere linhas cujo site_id casa com o current_tenant da
-- transação. Se o GUC não foi setado, current_setting(..., true) devolve NULL, o
-- predicado vira `site_id = NULL` → FALSE para toda linha → ZERO linhas (fail-closed).
-- ════════════════════════════════════════════════════════════════════════════

alter table alarm_event enable row level security;
alter table alarm_event force row level security;

-- CREATE POLICY não tem "IF NOT EXISTS" no PG — guard idempotente via catálogo.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'alarm_event' and policyname = 'alarm_event_tenant_isolation'
  ) then
    create policy alarm_event_tenant_isolation on alarm_event
      using      (site_id = current_setting('app.current_tenant', true))
      with check (site_id = current_setting('app.current_tenant', true));
  end if;
end$$;
