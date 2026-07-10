# ADR-001 — Paralelização de agentes por propriedade exclusiva de arquivo

## Contexto
O trabalho foi executado por múltiplos agentes em paralelo. O projeto **não é um
repositório git** durante boa parte do esforço (sem worktree/branch para isolar
edições concorrentes). Edições simultâneas no mesmo arquivo por agentes diferentes
se sobrescreveriam.

## Decisão
Cada arquivo tem **um único agente dono** por onda. Trabalho cross-cutting que toca
um arquivo é feito pelo dono dele. Quando há dependência de contrato entre frentes,
organiza-se em **ondas**: a camada de contrato (backend/tipos) primeiro, consumidores
depois. Lógica reutilizável é extraída para **arquivos novos** (ex.: `vision/counting.ts`,
`server/camcfg.js`) para permitir paralelismo sem colisão.

## Consequências
- (+) Paralelismo real (até 4 agentes simultâneos) sem conflito de escrita.
- (+) `CameraWorkspace.tsx` é o gargalo estrutural → suas mudanças são necessariamente
  seriais entre ondas.
- (−) Contratos entre agentes paralelos exigem especificação explícita no prompt;
  erros de tipo transitórios podem aparecer enquanto um agente vizinho ainda roda
  (validação combinada ao fim de cada onda resolve).
- Validação após cada onda: `tsc` + `vite build` + `e2e` + `node --check`.
