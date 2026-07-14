-- Provisiona o usuário do APP (cp_app) — NÃO-superuser, SEM BYPASSRLS (spec §5, camada 3).
-- Roda DEPOIS do 01-schema.sql. É este usuário que o control-plane usa em produção;
-- conectar como o dono/superuser furaria a RLS (por isso o FORCE + este usuário separado).
create role cp_app login password 'cp_app_pw' nosuperuser nobypassrls;
grant connect on database control_plane to cp_app;
grant usage on schema public to cp_app;
grant select, insert, update, delete on all tables in schema public to cp_app;
grant usage, select on all sequences in schema public to cp_app;
-- objetos futuros (se o schema crescer) já nascem acessíveis ao app.
alter default privileges in schema public grant select, insert, update, delete on tables to cp_app;
alter default privileges in schema public grant usage, select on sequences to cp_app;
