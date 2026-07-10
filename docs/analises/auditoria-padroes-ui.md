# Auditoria de padrões de UI — fechamento da migração Tailwind (ADR-008)

**Data:** 2026-07-02 · **Escopo:** `src/ui/` + telas · **Gate:** `npm run verify` verde + e2e 8/8.

## 1. Estado final

- **Design system 100% Tailwind + Radix.** Todos os átomos/moléculas de `src/ui/` (Button,
  IconButton, Input/Textarea/Field, Select, Slider, Switch/Checkbox/ToggleRow, Toggle,
  SegmentedControl, Badge/Alert/EmptyState/KpiCard, Spinner/Skeleton, Tabs, ScrollArea,
  DropdownMenu, Dialog, AlertDialog, Toast, Tooltip, PageHeader) estilizados por utilities.
- **Tokens going-gray como fonte única:** o `@theme` de `src/tailwind.css` mapeia
  `--state-*`/`--cam-*`/`--accent`/superfícies — `bg-panel`, `text-accent`, `border-border`
  usam as MESMAS variáveis de `src/index.css :root`. Sem paleta duplicada.
- **Telas varridas:** átomos crus substituídos por componentes, a11y (foco visível em duplo
  anel, alvos ≥44px em ≤640px via `max-[640px]:*` — `src/ui/Button.tsx:40,77`,
  `src/ui/SegmentedControl.tsx:48`), duplicações unificadas.
- **CSS morto purgado:** `src/ui/ui.css` **875 → 182 linhas** (−79%). Restaram apenas:
  variáveis (`--ui-focus`, `--ui-ctrl-h` — consumidas por `appshell.css:15`, `cine.css:89`
  e utilities arbitrárias), 5 `@keyframes` (referenciados via `animate-[…]`), regras
  contextuais re-apontadas (`.cam-drawer [role="combobox"]`, `.zone-sens [data-orientation]`),
  globais de a11y (`[hidden]`, `prefers-reduced-motion`, `.skip-link`, `.shell-main:focus`)
  e classes de página vivas só estilizadas ali (`.cell-toggle`, `.error-*`, `.page-title`,
  `.rep-skeleton`, responsivos `.rep-filters`/`.users-new`). Cabeçalho do arquivo documenta
  cada grupo. Nenhuma regra precisou ser restaurada após o gate (verify + e2e 8/8).
- **Marcadores preservados:** `ui-overlay`/`ui-dialog`/`ui-alertdialog`/`ui-tablist`/`ui-tabpanel`
  permanecem nos `.tsx` SEM regra própria — o e2e seleciona `.ui-overlay`/`.ui-dialog`
  (`e2e/app.spec.ts:96-102`), `alarms.css` reposiciona `.ui-dialog:has(.alarm-drawer__list)`
  e `cine.css` usa `.ui-tablist`/`.ui-tabpanel`. A largura 440px do AlertDialog passou a
  valer pela utility `w-[min(440px,92vw)]` (`src/ui/AlertDialog.tsx:27`), como previsto.

## 2. Achado sistêmico — cascata: CSS de página é *unlayered* e vence utilities

`src/tailwind.css` coloca as utilities em `@layer utilities`; `index.css`, `alarms.css`,
`cine.css`, `views.css`, `alarm-health.css` são **unlayered**. Pela spec, **estilo unlayered
vence qualquer camada** na mesma origem — independentemente de ordem de import ou
especificidade aparente.

**Consequências práticas observadas:**

- Uma utility nunca sobrescreve uma classe de página na mesma propriedade (ex.: `.switch`
  em `index.css:308`, `.page-title` em `index.css:1554` vencendo a fonte do `ui.css`);
  ajustes pontuais do Report via estilo inline também esbarram nos `!important` do bloco
  `@media print` (`index.css:1032+`).
- Foi exatamente por isso que o `.ui-alertdialog` precisou existir como classe enquanto a
  regra `.ui-dialog{width:...}` viveu no `ui.css` — resolvido agora pela purga.

**Recomendação (onda futura, opcional):** mover o CSS de página para `@layer components`
(fica abaixo de `utilities`), OU adotar como regra da casa: **"utility nunca compete com
classe de página na mesma propriedade"** — quem estiliza é um ou outro, nunca os dois.

## 3. Dívidas conhecidas (não corrigidas nesta onda)

| # | Dívida | Evidência |
|---|--------|-----------|
| 1 | `alarms.css` acopla no marcador `.ui-dialog:has(.alarm-drawer__list)` — funciona, mas é frágil (depende do nome no `className` do Dialog). | `src/routes/alarms.css:7` |
| 2 | **Seletor órfão:** `.ui-dialog-body` não existe mais no DOM (o corpo do Dialog usa só utilities — `src/ui/Dialog.tsx:35`). A regra que transformava o corpo do drawer de alarmes em coluna flex está **morta**: a lista rola pelo `overflow-auto` do corpo, mas o layout difere do desenhado (padding não zera, filtros não ficam fixos). Corrigir re-apontando o seletor (ex.: `> div:nth-child(2)` ou um marcador novo) ou expondo `bodyClassName` no Dialog. | `src/routes/alarms.css:36` |
| 3 | **Seletor órfão:** `.cine-bar .ui-toggle` — o Toggle migrado não carrega mais a classe (`src/ui/Toggle.tsx`); o play/pause do cine-loop perdeu o porte compacto (`padding 0 var(--sp-2)`, `min-width var(--ui-ctrl-h)`). Passar utilities via `className` no consumidor. | `src/camera/cine.css:87-90`, consumidor `src/CameraWorkspace.tsx:1498` |
| 4 | Células clicáveis do Heatmap são `<span onClick>` sem `role`/`tabIndex`/teclado (a11y). | `src/routes/report/Heatmap.tsx:82-88` |
| 5 | `AlarmesPanel` re-implementa tendência clicável (`evo-col`) em vez de estender `TrendChart` com seleção. | `src/routes/report/AlarmesPanel.tsx:126-140` vs `src/routes/report/TrendChart.tsx` |
| 6 | Triplets `rgba(...)` **intencionais** nos gráficos (rampa de alpha não sai de token `var()`). Manter documentado, não "corrigir". | `src/routes/report/Heatmap.tsx:13,19` |
| 7 | Aliases legados `--ok`/`--idle`/`--alert` ainda apontam para `--state-*`; conferir consumidores remanescentes e aposentar. | `src/index.css:17-20` |
| 8 | `ReportPage` decide painel por cadeia de booleans/ternários por modo; um `Record<Mode, ...>` simplificaria. | `src/routes/ReportPage.tsx:379-383,467` |

## 4. Próximo passo opcional (com apetite)

1. **Migrar o CSS de páginas** (`index.css`, ~2.570 linhas, + `alarms.css`/`cine.css`/`views.css`)
   para utilities ou ao menos para `@layer components`. É a maior frente restante — só vale
   com apetite; fatiar por página, mesma disciplina (verify + e2e por fatia).
2. **Ligar o preflight do Tailwind ao final de tudo**, com auditoria visual dedicada
   (hoje `tailwind.css` importa só `theme` + `utilities` justamente para não resetar o legado).
3. Ao fazer (1), resolver as dívidas #2 e #3 de graça (os seletores órfãos somem junto).

## 5. Validação desta onda

- `npm run verify` **verde**: ESLint + `tsc --noEmit` + build Vite + Vitest **72/72**.
- `npx playwright test --trace off` **8/8 passed (20.7s)** — cobre Dialog, Select-em-Dialog,
  camadas ESC/clique-fora, Tabs e AlertDialog, exatamente as cascas afetadas pela purga.
- Zero regra restaurada pós-purga.
