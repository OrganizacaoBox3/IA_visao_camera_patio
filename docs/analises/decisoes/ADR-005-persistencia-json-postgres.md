# ADR-005 — Persistência: cache em memória + Postgres com fallback JSON

## Contexto
Novos dados precisaram persistir (eventos de alarme, views, tripwires). O projeto já
tinha um padrão (`recipients.js`, `settings.js`, `pgstore.js`): cache em memória +
Postgres quando configurado, com fallback para arquivo JSON local.

## Decisão
Seguir o mesmo padrão para todos os novos stores (`events.js`, `camcfg.js`): `init()`
detecta `db.configured()`; se sim usa Postgres (tabelas aditivas em `schema.sql`, DDL
idempotente, sem alterar tabelas existentes), senão grava JSON local. Arquivos de
runtime com possível conteúdo sensível ou volumoso vão para o `.gitignore`
(`alarms.json`, `camcfg.json`, `cameras.json`, `rtsp.sources.json`, `wa-auth/`).

## Consequências
- (+) Funciona sem Postgres (dev/POC) e escala para Postgres (produção) sem refactor.
- (+) Consistência com o código existente.
- (−) Concorrência multi-instância não é coordenada via JSON (fallback); Postgres é o
  caminho para produção real.
- (−) Sem migrations formais — `schema.sql` idempotente é o mecanismo atual.
