# ADR-007 — Adoção de Radix como camada de UI (exceção: casca fullscreen do canvas)

## Contexto
O frontend tinha adoção parcial de Radix (Select, Slider, Switch, Dialog de config,
Toast, Tooltip) e muito controle nativo/custom (botões, chips, abas via ToggleGroup,
`overflow:auto` manual, `window.confirm`, `<aside>` de drawer). Objetivo: maximizar
primitivas Radix para melhor integração com o browser, acessibilidade e responsividade.

## Decisão
- **Camada de wrappers Radix em `src/ui/`** (`forwardRef` + `asChild` via `@radix-ui/react-slot`):
  novos `Tabs`, `ScrollArea`, `DropdownMenu`, `AlertDialog`, `Toggle`/`ToggleGroup`,
  além dos existentes padronizados. Instalados `@radix-ui/react-alert-dialog`,
  `@radix-ui/react-slot`, `@radix-ui/react-toggle`. Estilização só por tokens
  (`--state-*`/`--cam-*`/`--sp-*`).
- **Migração por tela**: abas que trocam painel → `Tabs` (ARIA tab/tabpanel);
  regiões roláveis → `ScrollArea`; toggles/chips → `Toggle`/`ToggleGroup` (`aria-pressed`);
  confirmações destrutivas → `AlertDialog` (substitui `window.confirm` e o "limpar
  histórico" sem aviso); `title=` → `Tooltip`; drawer de alarmes → `Dialog`.
  `SegmentedControl` (ToggleGroup) fica reservado a filtro/modo SEM painel.
- **Responsividade**: `100dvh`, `viewport-fit=cover` + safe-area, container queries para
  painéis laterais, `min-width` em tabelas, alvos de toque ≥44px, breakpoints canônicos
  (sm 640 / md 900 / lg 1200).

## Exceção (não negociável)
A casca fullscreen da câmera (`CameraWorkspace`/`FadigaView`: `<div role="dialog">` +
`<canvas>` + loop rAF) **não** vira Radix `Dialog`: o Portal/scroll-lock/`pointer-events`
remontaria o canvas e quebraria o rAF e o editor de mouse de zonas/tripwires. Mantém-se
o trap de foco manual ali (que já cede ao Radix quando o diálogo de config abre).

## Consequências
- (+) A11y/teclado/foco/portal/posicionamento (Popper) consistentes e cross-browser.
- (+) Responsividade real (painéis colapsáveis, touch targets, safe-area, dvh).
- (+) Confirmações destrutivas seguras (fim do `window.confirm` e do clear sem aviso).
- (−) Uso de CSS `:has()` para escopar o drawer de alarmes como sheet (baseline 2023+).
- (−) Grid do Dashboard tem dois mecanismos (data-cols no desktop + media queries no
  mobile) — funcional; unificar em `--dash-cols` é follow-up.
- (−) e2e precisou continuar cobrindo Select-em-Dialog; ampliar para Tabs/AlertDialog
  é recomendado.
