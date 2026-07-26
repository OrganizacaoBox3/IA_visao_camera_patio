-- ════════════════════════════════════════════════════════════════════════════
-- Visão de Pátio — esquema COMPLETO do Postgres (fonte única; o hub roda no boot).
-- Só INDICADORES agregados — nunca imagens (LGPD). Idempotente (CREATE ... IF NOT EXISTS).
-- Criar o banco antes:  CREATE DATABASE visao_patio;  e apontar PGDATABASE para ele.
-- ════════════════════════════════════════════════════════════════════════════

-- ── HISTÓRICO: ATIVIDADE (ocupação/ociosidade/fluxo por área) ────────────────
-- CARIMBO DE TURNO (spec-turnos-por-zona F3 — colunas ADITIVAS, ver §"CARIMBO" no fim):
-- `shift_id` tem TRÊS estados e o SQL só tem dois (valor/NULL) — por isso o SENTINELA:
--   'sh…' = dentro do turno · ''  = resolvido e FORA de turno (D7) · NULL = linha SEM carimbo
--   (dado antigo, ou zona/site sem turnos cadastrados = 24/7, comportamento de sempre).
-- O bucket ganha a dimensão de turno na CHAVE: turno com minutos (06:30) corta a hora ao meio,
-- então id = `${cameraId}|${zoneId}|${hourStart}|${turno}` — SÓ quando há carimbo. Sem carimbo o
-- id segue com 3 segmentos (a linha de hoje continua a MESMA — zero migração de dado; CA-5).
create table if not exists ativ_buckets (
  id text primary key,            -- `${cameraId}|${zoneId}|${hourStart}` [|`${turno}` quando carimbado]
  camera_id text, area text, atividade text, hour_start bigint not null,
  idle_ms bigint default 0, alerts int default 0,
  samples int default 0, active_samples int default 0, people_peak int default 0,
  shift_id text, shift text, in_pause boolean, business_date text
);
create table if not exists ativ_events (
  id bigserial primary key, ts bigint not null,
  camera_id text, camera text, area text, atividade text, duration_min int, shift text,
  shift_id text, in_pause boolean, business_date text
);

-- ── HISTÓRICO: LEITURA (código de barras / expedição) ────────────────────────
create table if not exists read_buckets (
  id text primary key,            -- `${ponto}|${hourStart}`
  ponto text, hour_start bigint not null,
  boxes int default 0, reads int default 0, multi_reads int default 0, passages int default 0,
  per_camera jsonb default '{}'::jsonb
);
-- `cameras` está OBSOLETA desde 2026-07-26 (auditoria de produto, achado A7). Ela existia para o
-- agregador multi-câmera por Ponto de Leitura — REMOVIDO na faxina do ADR-016 (a remoção está
-- documentada em src/reading/cluster.ts). Sem esse agregador, ninguém no sistema sabe em quantas
-- câmeras uma caixa foi vista: até hoje o hub gravava o literal `1` nos dois caminhos (SQL e
-- fallback JSON), um número que AFIRMAVA "exatamente uma câmera" sem ter medido nada. O insert
-- agora OMITE a coluna ⇒ NULL, que é a ausência de INFORMAÇÃO — a MESMA semântica do `shift_id`
-- NULL (ver §CARIMBO no topo): não se inventa valor para dado que o sistema não produz mais.
-- A COLUNA FICA no schema DE PROPÓSITO: `drop column` reescreveria a tabela numa base de cliente e
-- destruiria as linhas históricas cujo `1` foi gravado de verdade. Se o agregador multi-câmera
-- voltar, volte a escrevê-la — com valor MEDIDO, nunca com constante.
-- (A ORDEM das colunas fica como sempre foi: `cameras` NÃO é movida para o fim. Reordenar só
--  afetaria bases NOVAS — `create table if not exists` é no-op em base existente — e criaria
--  divergência gratuita de layout entre instalações. Nada aqui é posicional: todo insert/select
--  nomeia as colunas.)
create table if not exists read_events (
  id bigserial primary key, ts bigint not null,
  ponto text, code text,
  cameras int,                    -- OBSOLETA (ver acima): NÃO escrever. Só leitura do histórico.
  shift text
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

-- ── HISTÓRICO: FLUXO DE PESSOAS (cruzamentos de tripwire — in/out) ───────────
-- Evento por CRUZAMENTO — só metadados (câmera/linha/direção/ts), nunca imagem (LGPD).
-- Colunas in_count/out_count ("in"/"out" são reservadas); a API expõe como "in"/"out".
create table if not exists flow_buckets (
  id text primary key,            -- `${cameraId}|${tripwireId}|${hourStart}`
  camera_id text, camera_label text, tripwire_id text, hour_start bigint not null,
  in_count int default 0, out_count int default 0
);
-- ⚠ NÃO APAGUE `flow_events` por "parecer morta" (2026-07-26, auditoria de produto). Ela É escrita
-- a cada cruzamento, mas o front hoje só consome `flow_buckets` (fetchBuckets) — então um grep
-- superficial a acusa de órfã, exatamente como acusou a app_views que foi removida abaixo. A
-- diferença é REAL: esta é o ÚNICO lugar onde o cruzamento CRU carrega `shift_id`/`business_date`
-- corretos, e é por ela que o filtro de TURNO do painel de Fluxo será consertado — `flow_buckets`
-- agrega por hora e NÃO tem a dimensão de turno na chave (ao contrário de `ativ_buckets`, cujo id
-- ganhou o segmento `|turno`; ver §CARIMBO no topo). Escrever hoje é o que garante histórico
-- quando essa onda chegar; apagá-la agora seria começar do zero, sem dado retroativo.
create table if not exists flow_events (
  id bigserial primary key, ts bigint not null,
  camera_id text, camera_label text, tripwire_id text, dir text, shift text,
  shift_id text, in_pause boolean, business_date text
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

-- (As tabelas BLE — bt_tags, bt_stations, bt_floorplan, bt_fingerprints, bt_tag_locations —
--  migraram com o domínio para o repo mvp_trilateracao_BLE; ADR-018. Este schema é ADITIVO:
--  instalações existentes que já as criaram NÃO sofrem DROP — as tabelas ficam dormentes.)

-- ── TURNOS DE TRABALHO (cadastro global — contexto operacional das métricas) ──
-- Entidade GLOBAL nomeada (spec-turnos-por-zona F1): cadastrada 1×, atribuída a N zonas via
-- cam_zones.data (shiftIds — F2). `dias` = dias da semana em que o turno INICIA (0=dom..6=sáb,
-- jsonb — D1/D5); `inicio`/`fim` = "HH:MM" wall-clock do site (fim ≤ início ⇒ +1 dia — D2);
-- `pausas` = [{inicio:"HH:MM", duracaoMin}] dentro da janela (D3). SÓ config (LGPD).
create table if not exists shifts (
  id text primary key,
  nome text not null,
  dias jsonb not null default '[]'::jsonb,
  inicio text not null,
  fim text not null,
  pausas jsonb not null default '[]'::jsonb,
  ativo boolean default true,
  criado_em bigint
);

-- ── EVENTOS DE ALARME (fila acionável com acknowledge) ───────────────────────
-- LGPD: SÓ METADADOS — nada de imagens/frames. Campos são texto/ids/timestamps.
-- priority: advisory | high | critical (calculada pela política em alarmPolicy.js).
-- state:    new | acknowledged | forwarded (ciclo de vida na central).
create table if not exists alarm_events (
  id text primary key,
  ts bigint not null,
  camera_id text, camera_label text, zona text, tipo text,
  priority text default 'advisory',
  text text,
  state text default 'new',
  ack_by text, ack_at bigint
);

-- ── CONFIG COMPARTILHADA DAS CÂMERAS (operadores/turnos) ─────────────────────
-- `app_views` (layouts salvos do dashboard) foi REMOVIDA daqui em 2026-07-26: tabela 100% MORTA —
-- zero INSERT, zero SELECT, zero rota, zero teste no repo inteiro; a UI de "views" que a
-- justificaria nunca foi implementada. O `create table` era a única ocorrência do nome.
--
-- Removido SÓ o CREATE — de propósito NÃO existe um `drop table if exists` aqui. Numa base já
-- criada a tabela sobrevive órfã e INOFENSIVA (ninguém escreve nem lê nela; ela não entra no
-- `truncate` do clear() nem em backup crítico), enquanto o DROP seria IRREVERSÍVEL e destruiria
-- qualquer linha que um operador tenha inserido à mão. Assimetria decisiva: o custo de deixar é
-- zero; o custo de errar o DROP é dado de cliente perdido. Base NOVA simplesmente não a cria mais.
-- TRIPWIRES: linhas de contagem por câmera. `data` = array de { id, a:{x,y}, b:{x,y} } (0..1).
-- SÓ geometria/ids — nunca imagem/frame (LGPD).
create table if not exists cam_tripwires (
  camera_id text primary key,
  data jsonb not null default '[]'::jsonb
);
-- ZONES: zonas (ROIs + modo/config) por câmera. `data` = array de Zone (src/zones.ts):
-- { id, label, x,y,w,h (0..1), modo, mask?, idleAlertMs, sensitivity, atividade, ponto, selectedClasses[] }.
-- SÓ geometria/ids/config — nunca imagem/frame (LGPD).
create table if not exists cam_zones (
  camera_id text primary key,
  data jsonb not null default '[]'::jsonb
);
-- CAMCONFIG: config de câmera por câmera. `data` = objeto CameraCfg (src/cameraConfig.ts):
-- { modo, pontoLeitura, capture, selectedClasses[] }. SÓ metadados de config (LGPD).
create table if not exists cam_config (
  camera_id text primary key,
  data jsonb not null default '{}'::jsonb
);
-- CALIBRAÇÃO: homografia de chão por câmera (medir distância em metros; ADR tags-bluetooth §3).
-- `data` = { points:[{px:{x,y 0..1}, world:{x,y metros}}, …≥4], H:[9 números row-major], updatedAt }.
-- H é computada no cliente (src/vision/homography.ts). SÓ geometria/números — nunca imagem (LGPD).
create table if not exists cam_calibration (
  camera_id text primary key,
  data jsonb not null default '{}'::jsonb
);

-- ── ÍNDICES (consultas: eventos por ts desc; buckets por hora) ───────────────
create index if not exists idx_ativ_events_ts on ativ_events (ts desc);
create index if not exists idx_read_events_ts on read_events (ts desc);
create index if not exists idx_obj_events_ts  on obj_events  (ts desc);
create index if not exists idx_fad_events_ts  on fad_events  (ts desc);
create index if not exists idx_flow_events_ts on flow_events (ts desc);
create index if not exists idx_ativ_buckets_hour on ativ_buckets (hour_start);
create index if not exists idx_read_buckets_hour on read_buckets (hour_start);
create index if not exists idx_obj_buckets_hour  on obj_buckets  (hour_start);
create index if not exists idx_fad_buckets_hour  on fad_buckets  (hour_start);
create index if not exists idx_flow_buckets_hour on flow_buckets (hour_start);
create index if not exists idx_alarm_events_ts on alarm_events (ts desc);

-- ── CARIMBO DE TURNO: migração ADITIVA em banco JÁ CRIADO ────────────────────
-- `create table if not exists` NÃO adiciona coluna nova a uma tabela existente — um hub que já
-- rodou antes da spec-turnos-por-zona nunca veria as colunas do carimbo (o insert quebraria).
-- `add column if not exists` é idempotente e ADITIVO: coluna NOVA e NULA (nenhuma coluna
-- existente é alterada/renomeada/retipada, nenhum dado é reescrito). Linha antiga fica com
-- shift_id NULL = "sem carimbo" — que NÃO é "fora de turno" (ausência de INFORMAÇÃO, não de
-- turno): o relatório a lê pelo legado em vez de inventar ociosidade fora de turno.
alter table ativ_buckets add column if not exists shift_id text;
alter table ativ_buckets add column if not exists shift text;
alter table ativ_buckets add column if not exists in_pause boolean;
alter table ativ_buckets add column if not exists business_date text;
alter table ativ_events  add column if not exists shift_id text;
alter table ativ_events  add column if not exists in_pause boolean;
alter table ativ_events  add column if not exists business_date text;
alter table flow_events  add column if not exists shift_id text;
alter table flow_events  add column if not exists in_pause boolean;
alter table flow_events  add column if not exists business_date text;
