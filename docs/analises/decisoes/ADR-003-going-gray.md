# ADR-003 — "Going gray": disciplina de cor por estado

## Contexto
Convergência de dois domínios independentes no benchmark (NASA/mission control e
SCADA/HMI ISA-101): interfaces de monitoramento maduras usam base neutra e reservam
cor saturada só para anormalidade. A central tendia ao "árvore de natal".

## Decisão
Tokens semânticos de estado em CSS (`--state-neutral/ok/info/warn/critical`, com
variantes `-fg/-bg/-border`) em `src/index.css`. Mapa fixo: ATIVA→neutral,
LENTA/OCIOSA→warn, VAZIA→neutral-dim, ALERTA→critical, advisory→info. Componentes
consomem os tokens em vez de cores hardcoded. Superfície de câmera ao vivo usa tema
dark (`--cam-*`) — "imagem soberana", números no painel lateral.

## Consequências
- (+) Anormalidade salta à vista; percepção de maturidade sobe com baixo custo.
- (+) Tokens centralizam a paleta → mudanças globais num lugar.
- (−) CSS legado (`.dot-status`/`.badge.*`/`.tile.alerting`) ainda usa tokens antigos
  em alguns pontos (tela `/camera`) — migração incremental pendente.
