# Auditoria Radix — CameraWorkspace.tsx e FadigaView.tsx

> Tema: as duas telas interativas mais complexas do MVP (palco de vídeo em canvas/rAF, drawer
> com abas, diálogo de config de zona, sliders de sensibilidade/confiança/calibração, toggles de
> camadas/detecções, editor de zonas e tripwires, cine-loop, telemetria).
> Escopo: **somente leitura/diagnóstico** — nenhum código foi alterado.
> Arquivos lidos: `src/CameraWorkspace.tsx`, `src/FadigaView.tsx` e todos os componentes de
> `src/ui/` consumidos por eles.

---

## 0. Estado do design system (o que já é Radix)

Boa parte da fundação JÁ está sobre Radix. Os dois arquivos consomem `src/ui/`:

| Componente `src/ui` | Implementação | Radix? |
|---|---|---|
| `Select` (`Select.tsx`) | `@radix-ui/react-select` (Root/Trigger/Portal/Content/Item) | ✅ Sim |
| `Switch` (`controls.tsx`) | `@radix-ui/react-switch` | ✅ Sim |
| `Slider` (`controls.tsx`) | `@radix-ui/react-slider` | ✅ Sim |
| `Checkbox`/`CheckboxRow` (`controls.tsx`) | `@radix-ui/react-checkbox` + `react-label` | ✅ Sim (não usado nestes 2 arquivos) |
| `SegmentedControl` (`SegmentedControl.tsx`) | `@radix-ui/react-toggle-group` (single) | ✅ Sim (ToggleGroup) |
| `Dialog` (`Dialog.tsx`) | `@radix-ui/react-dialog` (Portal/Overlay/Content/Title/Description/Close) | ✅ Sim |
| `Input`/`Textarea`/`Field`/`FieldLabel` (`form.tsx`) | `<input>`/`<textarea>` nativos + `@radix-ui/react-label` | ◑ Parcial (label é Radix; campo é nativo) |
| `Button`/`IconButton` (`Button.tsx`) | `<button>` nativo (forwardRef, sem `asChild`) | ❌ Não (wrapper próprio) |
| `Tooltip`/`TooltipProvider` (`Tooltip.tsx`) | `@radix-ui/react-tooltip` | ✅ Sim — **provider já montado** em `main.tsx`, mas **não usado** nestes 2 arquivos (usam `title=` nativo) |
| `Toast`/`ToastProvider` | `@radix-ui/react-toast` | ✅ Sim — provider montado; alertas aqui sobem via callback `onAlert` (toast tratado fora) |

Fatos de stacking relevantes para o palco de vídeo (de `ui.css`/`index.css`):
- `.cam-overlay` (container fullscreen) = `z-index: 10`; `.cam-drawer` = 5; `.cine-bar`/`.cine-flag` = 6.
- Portais Radix renderizam em `document.body` com `z-index`: overlay 100 / dialog 101 / **select-content e tooltip 150** / toast 200.
- **Conclusão:** portais Radix já ficam ACIMA do fullscreen sem ajuste — o `Dialog` e os `Select` atuais já funcionam corretamente sobre o vídeo. O risco clássico de "portal escondido atrás do vídeo" está **resolvido** pela ordem de z-index existente.

---

## 1. Inventário de controles → primitiva Radix alvo

Legenda esforço: **B**aixo / **M**édio / **A**lto. Risco idem.
"Wrapper" = `Button`/`IconButton` de `src/ui` (botão nativo estilizado, ainda não Radix).
"Bespoke" = `<button>`/`<div>` cru escrito direto no arquivo.

### 1.1 CameraWorkspace.tsx

| # | Controle (arquivo:linha) | Tipo atual | Primitiva Radix alvo | Esforço | Risco |
|---|---|---|---|---|---|
| 1 | `CameraWorkspace.tsx:1094` IconButton "Pincel 🖌" | Wrapper (toggle via `active`) | `ToggleGroup` (single, par pincel/borracha) ou `Toggle` | B | B |
| 2 | `:1095` IconButton "Borracha 🧽" | Wrapper (toggle) | idem #1 (mesmo grupo) | B | B |
| 3 | `:1096` Select tamanho do pincel (1×/2×/3×) | **Já Radix Select** | — (manter) | — | — |
| 4 | `:1097` Button "Limpar" | Wrapper | `Button` via `Button asChild` (ou manter) | B | B |
| 5 | `:1098` Button "✓ Concluir" | Wrapper | manter `Button` | B | B |
| 6 | `:1100` Button "❄ Congelar / ▶ Ao vivo" | Wrapper (toggle `active=review`) | `Toggle` (pressed) | B | **M** (entra/sai do modo revisão que controla o rAF) |
| 7 | `:1101` Button "⏸ Pausar / ▶ Retomar" | Wrapper (toggle `active=paused`) | `Toggle` (pressed) | B | **M** (pausa o loop de canvas) |
| 8 | `:1102` Button "✎ Zona" (drawMode) | Wrapper (toggle, gated RBAC) | `Toggle` (pressed) | B | B |
| 9 | `:1103` Button "⇄ Linha" (tripwireMode) | Wrapper (toggle, gated RBAC) | `Toggle` (pressed) | B | B |
| 10 | `:1104` IconButton "✕ Fechar" | Wrapper | manter `Button`/`IconButton` | B | B |
| 11 | `:1109` `<div className="cam-stage">` com `onMouseDown/Move/Up/Leave/ContextMenu` | **Editor canvas nativo** (mouse) | **NÃO migrar** — superfície de desenho | — | **A** se forçado |
| 12 | `:1114` IconButton "‹" quadro anterior | Wrapper | manter | B | B |
| 13 | `:1115` IconButton play/pause cine-loop (`active=cinePlaying`) | Wrapper (toggle) | `Toggle` (pressed) | B | B |
| 14 | `:1116` IconButton "›" próximo quadro | Wrapper | manter | B | B |
| 15 | `:1118` Slider posição do cine-loop | **Já Radix Slider** | — (manter) | — | — |
| 16 | `:1123` Button "⤓ Snapshot" | Wrapper (disabled p/ estado) | manter | B | B |
| 17 | `:1124` Button "⤓ Exportar clipe" | Wrapper (disabled+progresso) | manter | B | B |
| 18 | `:1125` Button "▶ Ao vivo" | Wrapper | manter | B | B |
| 19 | `:1129` **SegmentedControl** das abas do drawer (Zonas/Linhas/Camadas/Timeline/Presença) | **Já Radix ToggleGroup** | **`Tabs`** (semântica correta de abas com painéis) | **M** | M |
| 20 | `:1132` `<div className="drawer-body">` (rolagem do painel) | `<div>` com `overflow:auto` | **`ScrollArea`** | M | B |
| 21 | `:1139` `<button className="del">⚙` Configurar zona | **Bespoke** (gated RBAC, `aria-label`+`title`) | `IconButton` + **`Tooltip`** | B | B |
| 22 | `:1140` `<button className="del">🖌` Pintar área (`.on` = ativo) | **Bespoke** (toggle) | `Toggle` + `Tooltip` | B | B |
| 23 | `:1141` `<button className="del">✕` Remover zona | **Bespoke** | `IconButton` + `Tooltip` | B | B |
| 24 | `:1205` Button "⇄ Nova linha" (size sm, toggle `tripwireMode`) | Wrapper (toggle) | `Toggle` | B | B |
| 25 | `:1206` Button "↺ Zerar contagem" | Wrapper | manter | B | B |
| 26 | `:1214` `<button className="del">⇄` Inverter direção | **Bespoke** | `IconButton` + `Tooltip` | B | B |
| 27 | `:1215` `<button className="del">✕` Remover linha | **Bespoke** | `IconButton` + `Tooltip` | B | B |
| 28 | `:1227-1229` `<ul className="tl">` Timeline (lista rolável) | `<ul>` em `drawer-body` | **`ScrollArea`** (a do #20 já cobre, se a rolagem for por aba) | B | B |
| 29 | `:1256` Button "↺ Reaplicar preset" | Wrapper | manter | B | B |
| 30 | `:1261-1266` **Switch** por camada (boxes/mask/zones/heatmap) | **Já Radix Switch** | — (manter) | — | — |
| 31 | `:1269` Slider "Confiança mínima" | **Já Radix Slider** | — (manter) | — | — |
| 32 | `:1287` **Dialog** "Configurar — zona" | **Já Radix Dialog** | — (manter) | — | — |
| 33 | `:1294` Input nome da zona | Nativo via `Input`/`Field` (label Radix) | manter (já acessível) | — | B |
| 34 | `:1297` Select "Modo" da zona | **Já Radix Select** | — | — | — |
| 35 | `:1302` Select "Atividade" | **Já Radix Select** | — | — | — |
| 36 | `:1305` Select "Limite de parada" (idleAlertMs) | **Já Radix Select** | — | — | — |
| 37 | `:1308` Slider "Sensibilidade ao movimento" | **Já Radix Slider** | — | — | — |
| 38 | `:1323` Input "Ponto de leitura" | Nativo via `Input`/`Field` | manter | — | B |
| 39 | `:1329-1332` `<button className="cfg-chip">` classes de objeto (multi-seleção) | **Bespoke** (chips toggle) | **`ToggleGroup` (type="multiple")** | M | B |
| 40 | `:1085` `<div className="cam" role="dialog" aria-modal>` fullscreen + focus-trap manual (`:403-422`) | **Bespoke** (trap de foco/ESC à mão) | `Dialog` (avaliar) | A | **A** (ver §4) |

### 1.2 FadigaView.tsx

| # | Controle (arquivo:linha) | Tipo atual | Primitiva Radix alvo | Esforço | Risco |
|---|---|---|---|---|---|
| A | `FadigaView.tsx:144` `<div className="tile" onClick>` (abrir monitor) | **Bespoke** div clicável (sem role/teclado) | `Button asChild` (ou `role/tabIndex`) | B | B |
| B | `:167` IconButton "✕ Fechar" | Wrapper | manter | B | B |
| C | `:196` Button "🔊/🔇 Som on/off" (`active=muted`) | Wrapper (toggle) | `Toggle` (pressed) | B | B |
| D | `:199-201` `<button className="cfg-chip">` DETECTORS (face/mãos/celular/risco) | **Bespoke** (chips multi-toggle) | **`ToggleGroup` (type="multiple")** | M | B |
| E | `:208-213` Slider por limiar de calibração (`FADIGA_THRESHOLD_FIELDS`) | **Já Radix Slider** | — (manter) | — | B (grava localStorage por mudança — ok) |
| F | `:215` Button "↺ Restaurar padrão" | Wrapper | manter | B | B |
| G | `:172` `<aside className="cam-drawer">` (painel rolável) | `<aside>` com overflow | **`ScrollArea`** | M | B |
| H | `:145/170` `<div className="viewport/cam-stage">` + `<canvas>` | Canvas de vídeo (sem editor de mouse aqui) | NÃO migrar | — | — |

### 1.3 Transversal (ambos os arquivos)
- **`title=` nativos** em praticamente todos os botões/ícones (ex.: `:1100-1104`, `:1123-1124`, `:1139-1141`, `:1205-1215`, `Fadiga :196/:200/:209`) → **`Tooltip` (Radix)**. O `TooltipProvider` já está montado em `main.tsx:36`; é só envolver os gatilhos. Esforço B por controle, ganho de consistência/touch/estilo.
- **`Button`/`IconButton`** ainda são botão nativo (sem `asChild`). Para a maioria dos casos o nativo basta; o valor de migrar para `Button asChild` aparece quando o gatilho precisa ser também `Tooltip.Trigger`/`Dialog.Trigger`/`ToggleGroup.Item` (composição) — aí `asChild` evita botão-dentro-de-botão.

---

## 2. Onde Radix melhora teclado / foco / acessibilidade no fluxo de vídeo

1. **Abas do drawer → `Tabs` (item #19).** Hoje é `ToggleGroup`, que dá foco roving mas NÃO expõe a relação aba↔painel (`role="tab"`/`role="tabpanel"`/`aria-controls`/`aria-selected`), e os painéis são renderizados por `&&` solto. `Tabs` traz: navegação por **setas ←/→**, `Home/End`, ativação automática/manual, e leitura correta por leitor de tela ("aba 2 de 5"). É a maior melhoria de acessibilidade do drawer.

2. **Toggles de modo (Congelar/Pausar/Zona/Linha/Som/Play-cine, itens #6-9, #13, C) → `Toggle`.** Botão comum com classe `active` não anuncia estado. `Toggle` expõe `aria-pressed`/`data-state`, deixando claro a quem usa leitor de tela que "Pausar" está ATIVO. Importa porque esses controles ficam SOBRE o vídeo e mudam o comportamento do rАF (pausar/congelar) — o estado precisa ser audível.

3. **Chips multi-seleção (classes de objeto #39, detecções de fadiga D) → `ToggleGroup type="multiple"`.** Hoje são `<button class="cfg-chip on">` sem semântica de grupo nem `aria-pressed`. `ToggleGroup` dá grupo navegável por teclado + estado pressionado por item — essencial para configurar "o que contar/detectar" sem mouse.

4. **Ícones de ação por zona/linha (⚙ 🖌 ✕ ⇄, itens #21-23, #26-27) → `IconButton`+`Tooltip`.** Já têm `aria-label` (bom), mas o rótulo só aparece via `title` nativo (sem em touch, atraso fixo, sem estilo). `Tooltip` Radix unifica e funciona com foco de teclado.

5. **`ScrollArea` no drawer/timeline (itens #20, #28, G).** A `ScrollArea` do Radix mantém a rolagem por teclado/roda e dá barras consistentes cross-browser sobre a superfície escura — sem capturar o foco do canvas. Importa quando a lista de zonas/linhas/timeline cresce dentro do painel estreito.

6. **Tile do Fadiga (item A) → gatilho focável.** `<div onClick>` não é alcançável por teclado nem anuncia ação. `Button asChild` (ou `role="button"`+`tabIndex`+`onKeyDown`) torna "Abrir monitor do operador" operável por teclado — relevante porque é o ponto de entrada para o console.

7. **Coordenação de foco já correta — preservar o padrão.** O fullscreen (`:1085`) tem trap manual (`:403-422`) que **DEFERE ESC/Tab ao Radix quando o `Dialog` de config está aberto** (`cfgOpenRef`, `:411`). Esse handshake é o modelo a seguir ao introduzir mais portais Radix (Tabs não portaliza, mas DropdownMenu/Tooltip sim): qualquer trap próprio deve ceder ao trap do Radix quando um overlay Radix estiver aberto, para não brigar pelo foco.

---

## 3. Riscos específicos (canvas / rAF / overlay / foco)

- **R1 — Não converter a casca fullscreen (#40) para `Dialog` sem cuidado (risco ALTO).** O `<div className="cam">` hospeda o `<canvas>` e o loop `requestAnimationFrame`. Trocar por `RDialog.Content` introduz **Portal** (remonta a subárvore → o `canvasRef`/contexto 2D é recriado, o rAF perde o alvo), **scroll-lock** e `pointer-events:none` no body (quebraria o editor de mouse do palco). O trap manual atual já entrega ESC + foco preso com custo baixo e sem mexer no canvas. **Recomendação: manter manual**; migrar só os controles internos.
- **R2 — `Toggle` em Pausar/Congelar (#6, #7) controla o rАF.** A migração é trivial visualmente, mas esses toggles disparam `pausedRef`/`reviewRef` lidos dentro do loop. Garantir que o `onPressedChange` mantenha exatamente a mesma transição de estado (inclusive `disabled={review}` no Pausar) para não dessincronizar o gate de frame (`:503`, `:511`).
- **R3 — `Dialog` de config x canvas (já mitigado, manter).** Quando aberto, o rAF continua rodando e desenhando (correto — vídeo ao vivo atrás). O Radix prende o foco no diálogo; o canvas não é focável, então não há "roubo" problemático. O `cfgOpenRef` já evita que o trap manual e o do Radix briguem. **Não regredir** esse handshake.
- **R4 — Portais sobre o vídeo: stacking OK, mas validar em fullscreen real.** Z-index dos portais (100-200) > `.cam-overlay` (10). Se algum dia a câmera abrir via Fullscreen API nativa (`element.requestFullscreen`), portais em `document.body` ficam FORA do elemento fullscreen e somem. Hoje é fullscreen "CSS" (não API), então está ok — sinalizar caso mude.
- **R5 — `ScrollArea` e altura do drawer.** O `.cam-drawer` usa `flex-direction:column` com `drawer-body` em `overflow:auto`. `ScrollArea` precisa de altura definida no Viewport; encaixar no layout flex (Viewport com `flex:1; min-height:0`) para não quebrar a barra de abas fixa no topo.
- **R6 — `Tabs` desmonta painéis.** Migrar #19 para `Tabs` troca o `&&` por `Tabs.Content`. Hoje os dados das abas (zonas/linhas/timeline/presença) vêm de estado/refs externos ao render, então desmontar o painel inativo não perde estado — **baixo risco**, mas confirmar que nenhuma aba mantém estado local de UI no JSX.
- **R7 — Slider de calibração (E) grava a cada `onChange`.** `FadigaView:67` persiste em localStorage e re-seta thresholds no engine a cada mudança do slider. Já é Radix; só atenção a não introduzir debounce que atrase o feedback visual do overlay.

---

## 4. Recomendações de responsividade

Comportamento atual observado no CSS:
- `index.css:471` — em telas pequenas o `.cam-drawer` vira **bottom sheet** (`top:auto; left/right/bottom:0; height:58%`). Bom ponto de partida.
- `cine.css:79` — `.cine-bar` tem regra de small-screen.
- `ui.css:185` — `.ui-dialog` vira `width:96vw`. `ui-toast`/`ui-select-content` já usam `min(..., vw)`.

Recomendações:
1. **Abas do drawer com overflow horizontal.** São 5 abas (`Zonas/Linhas/Camadas/Timeline/Presença`) num painel de 320px (ou bottom-sheet estreito). Ao migrar para `Tabs`, envolver a `Tabs.List` numa **`ScrollArea` horizontal** (ou `flex-wrap`) para não cortar abas em telas pequenas — hoje o `SegmentedControl` pode estourar a largura.
2. **Barra de ferramentas do header.** Em modo edição/revisão há muitos botões (Pincel/Borracha/Select/Limpar/Concluir; ou Congelar/Pausar/Zona/Linha/Fechar). Garantir `flex-wrap` no `.cam-head` em larguras estreitas, ou agrupar ações secundárias num **`DropdownMenu`** (primitiva disponível) — ex.: Snapshot/Exportar clipe num menu "⋯".
3. **`cine-bar` (controles sobre o vídeo).** São 9 elementos (3 IconButtons + Slider + 2 spans + 3 Buttons). Em telas pequenas, priorizar slider+play e mover Snapshot/Exportar para overflow; manter alvos de toque ≥ 40px. O Slider Radix já é touch-friendly (thumb arrastável), mas o `.cine-slider` precisa de `flex:1; min-width:0`.
4. **Drawer como sheet via primitiva.** Radix não tem "Drawer"; o bottom-sheet atual é CSS. Se quiser foco preso + ESC no sheet em mobile, dá para reusar `Dialog` como sheet (Content posicionado embaixo) — porém herda R1/scroll-lock; avaliar só se a UX mobile exigir modalidade. Para o MVP, manter o sheet CSS atual e só portar os controles internos.
5. **Botões de ação minúsculos (`.del` ⚙🖌✕⇄, FadigaView chips).** Em touch são pequenos; ao migrar para `IconButton`/`ToggleGroup` definir tamanho mínimo de toque (44px) e `Tooltip` que também funcione em foco. Os `cfg-chip` já usam `flex-wrap` (classe `ws-chips`), o que é bom para telas estreitas.
6. **Diálogo de config em mobile.** Já `width:96vw` (`ui.css:185`) e `max-height:85vh` com `body` rolável — adequado; ao adicionar `ScrollArea` interna manter o `max-height`.

---

## 5. Resumo executivo

**Maturidade atual:** Selects, Sliders, Switches, o SegmentedControl, o Dialog de config e os Labels JÁ são Radix. O que falta é (a) os **botões/toggles** (ainda `<button>` nativo via wrapper `Button`/`IconButton`, sem `aria-pressed`), (b) os **chips bespoke** de multi-seleção, (c) **abas do drawer** que deveriam ser `Tabs` em vez de `ToggleGroup`, (d) **áreas roláveis** sem `ScrollArea`, e (e) o uso de `title=` nativo onde já existe `Tooltip` Radix pronto.

**3 maiores oportunidades:**
1. Abas do drawer `SegmentedControl`→**`Tabs`** (semântica tab/tabpanel, setas, leitor de tela) — item #19.
2. Toggles de modo (Pausar/Congelar/Zona/Linha/Som/Play, itens #6-9/#13/C) e chips multi (objetos #39, detecções D) → **`Toggle`/`ToggleGroup`** com `aria-pressed`.
3. **`ScrollArea`** no drawer/timeline (#20/#28/G) + trocar `title=` por **`Tooltip`** (provider já montado) nos ícones de ação por zona/linha.

**Maior risco:** NÃO converter a casca fullscreen (`<div className="cam" role="dialog">`, item #40) para `Dialog` Radix — o Portal/scroll-lock/`pointer-events:none` remontaria o `<canvas>` e quebraria o rAF e o editor de mouse do palco. O trap manual existente (com handshake `cfgOpenRef` que cede ao Radix) já cobre ESC+foco; deve ser mantido e só os controles internos migrados.
