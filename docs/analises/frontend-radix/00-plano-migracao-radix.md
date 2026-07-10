# Plano de Migração — Radix Primitives na Aplicação Inteira

Consolida as 5 auditorias (`01`..`05` nesta pasta) num plano executável para maximizar
o uso de primitivas Radix (integração com o browser, acessibilidade, responsividade),
seguindo o mesmo modelo de ondas/propriedade-de-arquivo do `plano-desenvolvimento.md`.

## Objetivo e princípios
- **Máximo de Radix**: todo controle interativo (botão, toggle, aba, menu, diálogo,
  área rolável, tooltip) usa primitiva Radix, salvo exceção justificada.
- **Browser-native + A11y**: foco/teclado/ARIA/portal/scroll-lock vêm "de graça" do Radix.
- **Responsividade**: Popper (colisão com viewport), ScrollArea (rolagem consistente),
  Dialog/Sheet (mobile), container queries para painéis laterais.
- **Tokens**: estilizar via os tokens existentes (`--state-*`, `--cam-*`, `--sp-*`);
  migrar hex hardcoded de `ui.css` para tokens.
- **Wrapper padrão**: `forwardRef` + `asChild` (via `@radix-ui/react-slot`) em todos os
  wrappers de `src/ui/`.

## Diagnóstico consolidado
**Já é Radix (bom):** Select, Slider, Switch, Checkbox, o Dialog de config de zona,
Label/Field, Toast, Tooltip (montado), SegmentedControl (ToggleGroup). AlarmHealthPage
é a referência de boas práticas.

**Primitivas instaladas e OCIOSAS (custo já pago, zero uso):** `Tabs`,
`DropdownMenu`, `ScrollArea` → maiores quick wins.

**A INSTALAR:** `@radix-ui/react-alert-dialog` (confirmações destrutivas) e
`@radix-ui/react-slot` (composição `asChild`). Opcional futuro: Popover, Separator,
RadioGroup, Accordion.

**Lacunas recorrentes:**
1. `SegmentedControl`/ToggleGroup usado para trocar PAINÉIS sem semântica tab/tabpanel
   (ReportPage, drawer do CameraWorkspace, seções de UsersPage) → migrar para `Tabs`.
2. 15+ regiões `overflow:auto` manuais → `ScrollArea`.
3. Botões/toggles nativos (`<button>` sem `aria-pressed`) e chips bespoke de
   multisseleção → `Button(asChild)`/`Toggle`/`ToggleGroup`.
4. Confirmações: `ReportPage` "limpar histórico" sem NENHUMA confirmação;
   `UsersPage:125` usa `window.confirm` → `AlertDialog`.
5. `title=` em ícones → `Tooltip` Radix.
6. Drawer de alarmes (DashboardPage) é `<aside>` bespoke sem foco/ESC/mobile → `Dialog`.

## ⚠️ Restrição crítica (não negociável)
**NÃO** transformar a casca fullscreen da câmera (`CameraWorkspace` `<div className="cam"
role="dialog">`) em Radix `Dialog`. O Portal + scroll-lock + `pointer-events` do Radix
**remontaria o `<canvas>`** e quebraria o loop rAF e o editor de mouse de zonas/tripwires.
Manter o trap de foco manual ali (que já cede ao Radix quando o diálogo de config abre).
Idem para o palco de vídeo — overlays sobre o canvas continuam sendo canvas/DOM próprio.

## Fases e paralelização (propriedade exclusiva de arquivo)

### Fase 0 — Fundação (1 agente, serial; é o contrato das demais)
Dono: `package.json`, `src/ui/*` (todos), `src/ui/ui.css`.
- Instalar `@radix-ui/react-alert-dialog` e `@radix-ui/react-slot`.
- Criar wrappers novos em `src/ui/`: `Tabs`, `ScrollArea`, `DropdownMenu`, `AlertDialog`,
  `Toggle`/`ToggleGroup` (genérico), e exportar em `index.ts`.
- Padronizar `forwardRef` + `asChild` (Slot) nos wrappers existentes (Switch, Select,
  Slider, Dialog, Button…) para compor com Tooltip/Dialog.
- Migrar hex hardcoded de `ui.css` → tokens `--state-*`/`--cam-*`.
- **Exporta o CONTRATO** (assinaturas dos wrappers) para as Fases 1/2 consumirem.
- Validação: `tsc` + `vite build`.

### Fase 1 — Migração por tela (PARALELA — arquivos disjuntos)
Cada agente dono de um arquivo, consumindo os wrappers da Fase 0:
| Agente | Arquivo(s) | Principais trocas |
|--------|-----------|-------------------|
| F1-a | `src/CameraWorkspace.tsx` (+`cine.css`/`telemetry.css`) | drawer → `Tabs`; modo (Pausar/Congelar/Zona/Linha) → `Toggle`/`ToggleGroup` (aria-pressed); listas (zonas/linhas/timeline) → `ScrollArea`; `title=`→`Tooltip`. **Sem tocar na casca fullscreen.** |
| F1-b | `src/FadigaView.tsx` | toggles de som/detecções → `Toggle`/`ToggleGroup`; lista/timeline → `ScrollArea`; `Tooltip`. |
| F1-c | `src/routes/DashboardPage.tsx` (+`alarms.css`/`views.css`) | drawer de alarmes → `Dialog` (sheet); listas → `ScrollArea`; remover `gridTemplateColumns` inline (corrige media query); Switches já ok. |
| F1-d | `src/routes/ReportPage.tsx` (+`alarms.css` se próprio) | abas internas → `Tabs`; tabelas/listas → `ScrollArea`; "limpar histórico" → `AlertDialog`. |
| F1-e | `src/routes/UsersPage.tsx` | remoção → `AlertDialog` (substitui `window.confirm`); seções → `Tabs`; tabelas → `ScrollArea`; ações por linha → `DropdownMenu`. |
| F1-f | `src/routes/ProfilePage.tsx` + `src/routes/CameraPage.tsx` | chips "Tipos" → `ToggleGroup type=multiple`; CameraPage tem pouco a migrar. |
| F1-g | `src/routes/AlarmHealthPage.tsx` (+`alarm-health.css`) | lista de shelves → `ScrollArea`; já é boa referência. |
| F1-h | `src/components/AppShell.tsx` | nav/rail consistência; eventual `DropdownMenu` no usuário. |

Até ~8 agentes em paralelo (todos arquivos disjuntos).

### Fase 2 — Responsividade global (1 agente)
Dono: `src/index.css`, `index.html`.
- `100vh`→`100dvh` (5 ocorrências); `viewport-fit=cover` + safe-area (bottom-nav, Toast).
- **Container queries** para colapsar painéis laterais (`.main 1fr/360px`, `.full-body`,
  `.cam-drawer`) entre 641–900px (preserva "imagem soberana").
- `min-width` em `.rtable`; alvos de toque ≥44px (`.del`, `.ui-btn--sm`, `.ui-seg-item`).
- Consolidar breakpoints dispersos (1000/980/900/860/720/640) num conjunto canônico.
- Coordenar com F1-c (remoção do inline grid do Dashboard).
> Pode rodar em paralelo com a Fase 1 (arquivo `index.css` é disjunto dos `.tsx`),
> com a ressalva de coordenar a correção do grid do Dashboard.

### Fase 3 — Validação e registro
- `tsc` + `vite build` + `e2e` (atualizar/expandir os testes de Select-em-Dialog para
  cobrir Tabs/AlertDialog).
- ADR novo: "Adoção de Radix como camada de UI; exceção da casca fullscreen do canvas".

## Riscos e mitigações
- **Casca fullscreen / canvas** (alto): restrição acima — não migrar; manter trap manual.
- **Tabs vs SegmentedControl** (médio): nem todo SegmentedControl vira Tabs — só os que
  controlam painéis. Onde é filtro/modo sem painel, manter ToggleGroup.
- **ScrollArea + rAF/overlays** (baixo/médio): aplicar ScrollArea só a listas/painéis,
  nunca ao palco de vídeo.
- **e2e** (médio): os testes atuais dependem de Select dentro de Dialog; Tabs/AlertDialog
  mudam o DOM — atualizar seletores.

## Estimativa
Fase 0: médio. Fase 1: 8 frentes pequenas/médias em paralelo. Fase 2: médio. Fase 3: baixo.
A maior parte do valor (Tabs, ScrollArea, AlertDialog, drawer→Dialog, fixes de
responsividade) é de esforço baixo/médio porque as primitivas já estão instaladas.

## Sequência recomendada
1. **Fase 0** (fundação/contrato) — bloqueia as demais.
2. **Fase 1 + Fase 2** em paralelo (8 + 1 agentes, arquivos disjuntos).
3. **Fase 3** (validação + ADR + commits lógicos).
