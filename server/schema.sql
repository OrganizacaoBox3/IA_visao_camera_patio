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

-- ── HISTÓRICO: FLUXO DE PESSOAS (cruzamentos de tripwire — in/out) ───────────
-- Evento por CRUZAMENTO — só metadados (câmera/linha/direção/ts), nunca imagem (LGPD).
-- Colunas in_count/out_count ("in"/"out" são reservadas); a API expõe como "in"/"out".
create table if not exists flow_buckets (
  id text primary key,            -- `${cameraId}|${tripwireId}|${hourStart}`
  camera_id text, camera_label text, tripwire_id text, hour_start bigint not null,
  in_count int default 0, out_count int default 0
);
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

-- ── TAGS BLUETOOTH (identidade aumentada na câmera) — registro por nome do BT ──
-- Cadastro das tags que pessoas carregam; a estação BLE casa o que vê (bt_name) com o
-- rótulo. LGPD: só o CADASTRO é persistido (config); leituras de RSSI são efêmeras (em
-- memória, nunca gravadas) — mesma doutrina dos frames (ADR-002). SÓ METADADOS.
create table if not exists bt_tags (
  id text primary key,
  bt_name text unique not null,   -- nome/MAC do Bluetooth p/ casar com o que a estação enxerga
  rotulo text,                    -- nome amigável / pessoa portadora
  ativo boolean default true,
  criado_em bigint
);

-- ── ESTAÇÕES BLE (os coletores/celulares que varrem o BLE e postam as leituras) ──────────────
-- A estação NASCE por AUTO-DESCOBERTA: o app posta em /api/bt/reading e o hub a registra como
-- PENDENTE (nome = o próprio id) — não há cadastro manual. O operador só a BATIZA (nome amigável),
-- (des)ativa e remove. `id` = o stationId que o device manda ([a-zA-Z0-9_-]{1,32}).
-- LGPD: só config/metadado (nenhuma leitura de RSSI é persistida — bt-readings é efêmero, ADR-002).
create table if not exists bt_stations (
  id text primary key,            -- stationId enviado pelo device (chave natural)
  nome text,                      -- rótulo amigável ("Doca 3"); default = o próprio id (pendente)
  ativo boolean default true,
  primeira_vez_em bigint,         -- epoch-ms do 1º POST visto (auto-descoberta)
  ultima_vez_em bigint            -- epoch-ms do último POST (grava espaçado; memória é a fonte viva)
);

-- ── LOCALIZAÇÃO last-known por tag (modelo AirTag: TC22 móvel congela a última posição) ──
-- UMA linha por tag (last-wins, sem trilha/histórico). Só metadado: lat/lon/acc/ts — nunca imagem (LGPD).
create table if not exists bt_tag_locations (
  mac text primary key,           -- MAC (maiúsculo) da tag vista pela estação
  lat double precision,
  lon double precision,
  acc double precision,           -- precisão em metros (ou null)
  ts bigint                       -- epoch-ms da última posição conhecida
);

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
-- VIEWS: layouts salvos do dashboard (lista global). `cameras` = ids das câmeras (jsonb).
-- `ord` preserva a ordem da lista (a UI substitui a lista inteira no PUT).
create table if not exists app_views (
  id text primary key,
  name text not null,
  cameras jsonb not null default '[]'::jsonb,
  ord int default 0
);
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
