# Registro de Decisões de Arquitetura (ADRs)

Decisões técnicas relevantes tomadas durante a evolução do MVP. Formato leve:
Contexto → Decisão → Consequências. Status: aceito salvo indicação.

| ADR | Decisão | Status |
|-----|---------|--------|
| [001](ADR-001-paralelizacao-por-arquivo.md) | Paralelização de agentes por propriedade exclusiva de arquivo | aceito |
| [002](ADR-002-lgpd-imagens-efemeras.md) | LGPD: imagens efêmeras no cliente, persistir só metadados | aceito |
| [003](ADR-003-going-gray.md) | "Going gray": disciplina de cor por estado | aceito |
| [004](ADR-004-politica-alarme-isa18.md) | Política de alarme (ISA-18.2/EEMUA 191) antes de mais alertas | aceito |
| [005](ADR-005-persistencia-json-postgres.md) | Persistência: cache + Postgres com fallback JSON | aceito |
| [006](ADR-006-live-sync-last-write-wins.md) | Sincronização ao vivo last-write-wins via socket | aceito |

> Convenção: novas decisões de peso ganham um ADR aqui. Mudanças que revertem um ADR
> criam um novo ADR com status "substitui ADR-XXX".
