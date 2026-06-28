-- ════════════════════════════════════════════════════════════════════════════
-- Visão de Pátio — esquema COMPLETO do Postgres (fonte única; o hub roda no boot).
-- Só INDICADORES agregados — nunca imagens (LGPD). Idempotente (CREATE ... IF NOT EXISTS).
-- Criar o banco antes:  CREATE DATABASE visao_patio;  e apontar PGDATABASE para ele.
-- ════════════════════════════════════════════════════════════════════════════

-- ── HISTÓRICO: ATIVIDADE (ocupação/ociosidade/fluxo por área) ────────────────
create table if not exists ativ_buckets (
  id text primary key,            -- `${cameraId}|${zoneId}|${hourStart}`
  camera_id text, area text, atividade text, hour_start bigint not null,
  idle_ms bigint default 0, alerts int default 0,
  samples int default 0, active_samples int default 0, people_peak int default 0
);
create table if not exists ativ_events (
  id bigserial primary key, ts bigint not null,
  camera_id text, camera text, area text, atividade text, duration_min int, shift text
);

-- ── HISTÓRICO: LEITURA (código de barras / expedição) ────────────────────────
create table if not exists read_buckets (
  id text primary key,            -- `${ponto}|${hourStart}`
  ponto text, hour_start bigint not null,
  boxes int default 0, reads int default 0, multi_reads int default 0, passages int default 0,
  per_camera jsonb default '{}'::jsonb
);
create table if not exists read_events (
  id bigserial primary key, ts bigint not null,
  ponto text, code text, cameras int, shift text
);

-- ── HISTÓRICO: OBJETOS (contagem/presença por setor × classe) ────────────────
create table if not exists obj_buckets (
  id text primary key,            -- `${setor}|${classe}|${hourStart}`
  setor text, classe text, hour_start bigint not null,
  samples int default 0, count_sum int default 0, peak int default 0, present int default 0
);
create table if not exists obj_events (
  id bigserial primary key, ts bigint not null,
  type text, setor text, classe text, shift text
);

-- ── HISTÓRICO: FADIGA (operador — tempo em cada estado de risco) ─────────────
create table if not exists fad_buckets (
  id text primary key,            -- `${posto}|${hourStart}`
  posto text, hour_start bigint not null,
  samples int default 0, ok int default 0, fadiga int default 0, celular int default 0, duplo int default 0,
  ear_sum double precision default 0, ear_samples int default 0
);
create table if not exists fad_events (
  id bigserial primary key, ts bigint not null,
  posto text, type text, shift text
);

-- ── USUÁRIOS (multi-usuário, papéis) ─────────────────────────────────────────
create table if not exists users (
  id text primary key,
  usuario text unique not null,
  senha_hash text not null,       -- scrypt$salt$dk (nunca em texto)
  papel text not null default 'usuario',   -- 'superadmin' | 'usuario'
  ativo boolean default true,
  whatsapp text default '',
  filtros jsonb,                  -- { ativo, somenteCriticos, tipos[] }
  opt_in_em bigint,               -- consentimento LGPD (epoch ms) ou null
  criado_em bigint
);

-- ── DESTINATÁRIOS de WhatsApp do superadmin (números avulsos) ────────────────
create table if not exists recipients (
  id text primary key,
  nome text, numero text unique not null, ativo boolean default true,
  somente_criticos boolean default true, tipos jsonb default '[]'::jsonb, criado_em bigint
);

-- ── CONFIGURAÇÃO da aplicação (ex.: notificações, id='notif') ────────────────
create table if not exists app_settings (
  id text primary key,
  data jsonb not null
);

-- ── ÍNDICES (consultas: eventos por ts desc; buckets por hora) ───────────────
create index if not exists idx_ativ_events_ts on ativ_events (ts desc);
create index if not exists idx_read_events_ts on read_events (ts desc);
create index if not exists idx_obj_events_ts  on obj_events  (ts desc);
create index if not exists idx_fad_events_ts  on fad_events  (ts desc);
create index if not exists idx_ativ_buckets_hour on ativ_buckets (hour_start);
create index if not exists idx_read_buckets_hour on read_buckets (hour_start);
create index if not exists idx_obj_buckets_hour  on obj_buckets  (hour_start);
create index if not exists idx_fad_buckets_hour  on fad_buckets  (hour_start);
