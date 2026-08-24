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
  site_key text unique,                       -- (legado Fase 0; a credencial viva é site_key_hash)
  criado_em bigint not null
);
create index if not exists site_cliente_idx on site(cliente_id);

-- Fase 1 (aditivo/idempotente): a credencial do hub vira HASH (nunca guardamos a chave crua) +
-- o carimbo do último heartbeat. ADD COLUMN IF NOT EXISTS não altera dado existente.
alter table site add column if not exists site_key_hash text;   -- hash da site_key (sitekey.js)
alter table site add column if not exists last_seen bigint;      -- epoch-ms do último heartbeat

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

-- ════════════════════════════════════════════════════════════════════════════
-- PONTE DVR (Fase 2) — domínio de acesso remoto ao DVR do cliente via túnel.
-- Ver box3-mobile/planejamento/ponte-dvr/contratos.md (§3 registro, §8 identidade Opção A).
--
-- Modelo: o COLETOR (device box3 rodando o app-ponte-dvr) é o edge-gateway do domínio DVR
-- (contratos §8). Ele NÃO é reusado da tabela `site` (que é o hub silo de CÂMERAS + RLS de
-- alarm_event) — são dois parques distintos; misturá-los poluiria a frota de câmeras. Em vez
-- disso, `coletor` é um "site" próprio do domínio DVR, com a MESMA mecânica de site_key
-- (sitekey.js): guarda só o HASH; a chave crua sai UMA vez no enrollment (padrão API key).
--
-- A tabela de SESSÃO (abrir/estado/encerrar + remote_port + timeout de inatividade) é a C-be-5
-- e entra ABAIXO, com a sua própria lógica e testes (F3 backend). Aditivo/idempotente como o
-- resto do arquivo.
--
-- LGPD/sigilo: NENHUMA credencial do DVR mora aqui (contratos §3) — a validação da senha é
-- efêmera no app; o backend só guarda marca/modelo/ip/porta + o consentimento.
-- ════════════════════════════════════════════════════════════════════════════

-- ── coletor: o ENROLLMENT — liga empresa(box3) ↔ cliente(visão) + credencial site_key ──
-- empresa_id_box3 é o ELO com o outro backend (a empresa homologada no box3); a fonte de
-- verdade do DEVICE segue no box3 (contratos §8). site_key_hash é a credencial que autentica
-- a API DVR (e, futuramente, o login-plugin do frps). `revogado` cobre a mitigação de drift
-- (coletor reatribuído no box3 ⇒ enrollment obsoleto ⇒ site_key revogada).
create table if not exists coletor (
  id text primary key,
  cliente_id text not null references cliente(id) on delete restrict,
  empresa_id_box3 text not null,               -- o elo: id da empresa homologada no box3
  coletor_id_box3 text,                         -- id do device no box3 (pode chegar depois/drift)
  nome text,
  site_key_hash text not null,                  -- hash da site_key do coletor (sitekey.js)
  revogado boolean not null default false,      -- enrollment obsoleto ⇒ túnel e API DVR recusados
  revogado_em bigint,
  criado_em bigint not null
);
create index if not exists coletor_cliente_idx on coletor(cliente_id);
create index if not exists coletor_empresa_idx on coletor(empresa_id_box3);

-- ── dvr: o aparelho registrado pelo coletor — 1 por coletor (idempotência do registro) ──
-- cliente_id é DENORMALIZADO do coletor (âncora direta para o canAccess do técnico na F4).
-- consentimento_* guarda o aceite (aceito/quando/versaoTexto). NENHUMA credencial do DVR.
create table if not exists dvr (
  id text primary key,
  coletor_id text not null references coletor(id) on delete cascade,
  cliente_id text not null references cliente(id) on delete restrict,
  marca text,
  modelo text,
  ip text,
  porta integer,
  consentimento_aceito boolean not null default false,
  consentimento_em bigint,
  consentimento_versao text,
  criado_em bigint not null,
  atualizado_em bigint
);
-- 1 DVR por coletor: o UNIQUE torna o registro idempotente por (coletorId) (contratos §3).
create unique index if not exists dvr_coletor_uidx on dvr(coletor_id);
create index if not exists dvr_cliente_idx on dvr(cliente_id);

-- ── auditoria_dvr: quem/qual DVR/qual ação/quando (a auditoria que o visão não tinha) ──
-- ator = coletorId (device) ou user_id (integrador/técnico). Cobre enrollment (dvr_id NULL),
-- registro e — nas próximas ondas — abrir/encerrar sessão e acesso do técnico.
create table if not exists auditoria_dvr (
  id bigserial primary key,
  ator text not null,
  dvr_id text,
  coletor_id text,
  acao text not null,
  detalhe jsonb,
  em bigint not null
);
create index if not exists auditoria_dvr_dvr_idx on auditoria_dvr(dvr_id);
create index if not exists auditoria_dvr_coletor_idx on auditoria_dvr(coletor_id);
create index if not exists auditoria_dvr_em_idx on auditoria_dvr(em);

-- ════════════════════════════════════════════════════════════════════════════
-- PONTE DVR (F3 backend) — SESSÃO (C-be-5): o ciclo do acesso remoto por sessão.
-- Ver contratos.md §4 (abrir/estado/encerrar + timeout de inatividade).
--
-- Quem ABRE: o COLETOR (o app, autenticado por site_key) — §4 "pessoa no site toca liberar
-- acesso no app". O backend aloca um `remote_port` de loopback no relay e devolve
-- { sessaoId, relay:{serverAddr,serverPort,token}, remotePort, hostPublico }.
--
-- Esta MESMA linha É o MAPA DE ROTA que o nginx (B-3, próxima onda) vai consumir:
-- host_publico → remote_port → dvr, das sessões com status='ativa' (stores.sessoes.rotasAtivas).
-- Encerrar/timeout viram status='encerrada' → somem do mapa automaticamente (a rota "cai").
--
-- TIMEOUT de inatividade (§4/§7): `ultima_atividade` é renovada pelo /_dvr_auth a cada acesso
-- do técnico (F4, próxima onda); no abrir nasce = aberta_em. Uma varredura periódica
-- (index.js) encerra as sessões ociosas > CP_DVR_IDLE_MS.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists sessao (
  id text primary key,
  dvr_id text not null references dvr(id) on delete cascade,
  coletor_id text not null references coletor(id) on delete cascade,
  cliente_id text not null references cliente(id) on delete restrict,  -- denormalizado (canAccess do técnico)
  ator text not null,                           -- quem abriu: coletorId (app) ou user_id (técnico)
  status text not null default 'ativa' check (status in ('ativa','encerrada')),
  remote_port integer not null,                 -- porta de loopback alocada no relay (frps)
  host_publico text not null,                   -- cliente-x.dvr.box3.software (nginx roteia por aqui)
  aberta_em bigint not null,
  encerrada_em bigint,
  ultima_atividade bigint                        -- base do timeout; renovada pelo /_dvr_auth (F4)
);
create index if not exists sessao_coletor_idx on sessao(coletor_id);
create index if not exists sessao_dvr_idx on sessao(dvr_id);
create index if not exists sessao_cliente_idx on sessao(cliente_id);
create index if not exists sessao_status_idx on sessao(status);
-- Corrida/menor privilégio: no máximo UMA sessão ativa por remote_port (alocação segura sob
-- concorrência — a store recomputa a porta ao violar). WHERE status='ativa' libera a porta ao encerrar.
create unique index if not exists sessao_remote_port_ativa_uidx on sessao(remote_port) where status = 'ativa';
-- No máximo UMA sessão ativa por coletor (1 DVR/coletor, 1 túnel — contratos §2). A store trata a
-- violação reusando a sessão ativa existente (abrir idempotente).
create unique index if not exists sessao_coletor_ativa_uidx on sessao(coletor_id) where status = 'ativa';
