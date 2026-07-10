# Saúde de Frontend / UI — Auditoria pós-migração Radix (Onda G)

> Dimensão: **consistência Radix, responsividade, a11y, tokens, estados de UI.**
> Lente: `CLAUDE.md` §3 (invariantes Radix / going-gray / casca fullscreen) e §4 (padrão front).
> Contexto: `docs/analises/frontend-radix/*` (plano + 5 auditorias) e `docs/analises/implementacao-changelog.md` (Ondas A, G).
> Escopo lido: `src/ui/*`, `src/index.css`, `src/ui/ui.css`, `index.html`, `src/main.tsx`,
> `CameraWorkspace.tsx`, `DashboardPage.tsx`, `ReportPage.tsx`, `UsersPage.tsx`, `ProfilePage.tsx`,
> `AlarmHealthPage.tsx`, `CameraPage.tsx`, `AppShell.tsx`, CSS de feature, `e2e/app.spec.ts`.
> **Nada de código foi alterado.** (E) = evidência direta no código · (I) = inferência · ⚠️ = risco/dívida.
> Data: 2026-06-28.

---

## 1. Scorecard

| Área | Nota | Síntese |
|---|:---:|---|
| **Adoção Radix (wrappers)** | 🟢 | `src/ui/` exemplar: `forwardRef` + `asChild` (Slot) em todos; sem `<select>` nativo; sem `window.confirm`. |
| **Going-gray / tokens** | 🟡 | Dois sistemas convivem: `--ok/--idle/--empty/--alert` (legado) **e** `--state-*`. 69 usos do legado; tints hex duplicam tokens. |
| **Responsividade** | 🟡 | Fundação sólida (100dvh, safe-area, colapso de painéis no md). Mas grid do Dashboard redundante; heatmap/obj-matrix sem scroll horizontal. |
| **Acessibilidade** | 🟢 | skip-link, `:focus-visible`, `prefers-reduced-motion`, Tabs com teclado, casca fullscreen com trap manual correto (invariante OK). |
| **Estados de UI** | 🟢 | ErrorBoundary global, 404 catch-all, toasts Radix, erro≠vazio+retry no relatório, AlertDialog p/ destrutivas. |
| **Cobertura e2e da migração** | 🟡 | Cobre Select-em-Dialog, camadas e casca fullscreen; **não** cobre Tabs nem AlertDialog. |

**Veredito:** migração Radix **bem executada e madura** — a camada de UI (`src/ui/`) é consistente e as invariantes de §3 estão respeitadas (casca fullscreen NÃO virou Dialog; going-gray tem tokens). As dívidas residuais são **acabamento**, não estruturais: (1) bifurcação do sistema de tokens (legado × `--state-*`), (2) redundância/código morto no grid do Dashboard, (3) migração parcial de `title=`/icon-buttons e quebras de layout em tabelas densas no mobile.

---

## 2. Invariantes de §3 — verificação

| Invariante | Status | Evidência |
|---|:---:|---|
| Casca fullscreen da câmera **não** vira Radix Dialog | ✅ | `CameraWorkspace.tsx:1085` — `<div className="cam" role="dialog" aria-modal tabIndex={-1}>` com **trap manual** (`:401-421`): ESC, ciclo de Tab, restaura foco anterior, defere ao Radix quando o Dialog de config abre. (E) |
| Todo controle interativo via wrapper Radix de `src/ui/` | 🟡 | Verdadeiro para Select/Switch/Slider/Tabs/Toggle/Dialog/AlertDialog/ScrollArea/DropdownMenu. Resíduos: alguns `<button>` nativos e `title=` (ver §3.1). (E) |
| Going-gray (cor = informação; base neutra `--state-*`) | 🟡 | Tokens `--state-*` existem e são contrato (`index.css:77-118`); mas CSS legado ainda em `--ok/--idle/--alert` (ver §3.2). (E) |
| Wrapper padrão `forwardRef` + `asChild` | ✅ | `Button.tsx:9,19` (Slot), `Tabs/ScrollArea/AlertDialog/Toggle/ToggleGroup` todos `forwardRef`. (E) |

---

## 3. Inconsistências / dívidas residuais (arquivo:linha → ação)

### 3.1 Adoção Radix — resíduos de migração parcial

- **`title=` nativo em Buttons já migrados** — `CameraWorkspace.tsx:1133` (Snapshot), `:1134` (Exportar clipe), `:1222` (Nova linha), `:1223` (Zerar contagem), `:1277` (Reaplicar preset). Os icon-buttons das **listas** ganharam `<Tooltip>` (`:1149,1152,1155,1231,1234`), mas os Buttons da **toolbar** ficaram no `title=` nativo (sem Popper, sem touch). ⚠️ Migração de `title=`→`Tooltip` ficou **pela metade** no arquivo. → Envolver os Buttons da toolbar em `<Tooltip>`.
- **Badges/labels só com `title=`** — `CameraWorkspace.tsx:1073,1089,1090,1147,1190`. `title=` como única dica → `<Tooltip>` (e os de info pura podem virar `aria-label`). (E)
- **Icon-buttons fora do wrapper** — `CameraWorkspace.tsx:1150,1153,1156,1232,1235` usam `<button className="del">` nativo (com `aria-label`, bom) em vez de `<IconButton>`. Estilo vem do CSS legado `.del`/`.zone .del`. → Trocar por `<IconButton label=…>` (já existe e dá alvo 34px + foco padrão). (E)
- **`<button>` nativos diversos** — `AppShell.tsx:28` (logout, `.rail-item`), `ReportPage.tsx:381-411` (resumo-cards), `:492/562/637/690/746/774` (`.linkbtn`). São defensáveis (card/link bespoke), mas inconsistentes com `Button asChild`. `ReportPage.tsx:716,753` (evo-col/alarm-card) têm `aria-pressed` → aceitável p/ dataviz. (E)
- **`ErrorBoundary.tsx:27`** usa `<button className="ui-btn">` cru — **defensável** (boundary fica acima dos providers; evita componente que possa lançar). Documentar como exceção consciente. (E/I)
- **CSS morto** — `index.css:504-506` `.drawer-tabs button` ficou órfão: o drawer da câmera agora é `<Tabs>` (`.ui-tab`). → Remover regra. (E)

✅ **Sem resíduos** de `<select>` nativo (só o wrapper `Select`) e de `window.confirm` (substituído por `AlertDialog` + `ConfirmProvider`, `UsersPage.tsx:130`, `main.tsx:21`). (E)

### 3.2 Going-gray / tokens — sistema bifurcado

- **Dois conjuntos de tokens convivem.** Legado `--ok/--idle/--empty/--alert` (`index.css:11-14`) **continua definido e em uso** junto de `--state-*` (`index.css:77-118`). **69 usos** de `var(--ok|--idle|--alert|--empty)` (index.css 42, ui.css 10, ReportPage 15, FadigaView 1, UsersPage 1). É exatamente a pendência registrada em `implementacao-changelog.md:58` (Onda A, "A confirmar"), ainda **aberta**. ⚠️
- **Classes legadas em tokens-base antigos:** `index.css` `.badge.*` (`:224-227`), `.zone.OK/.OCIOSA/.VAZIA/.ALERTA` (`:217-219`), `.tile.alerting` (`:268`), `.tl .dot.*` (`:240-242`), `.dot-status*` (`:291-294`, **tela `/camera`**), `.wa-dot` (`:433`), `.flow-chip` (`:559-561`), `.ponto-rate` (`:591`), `.delta` (`:316`), `.privacy` (`:162`). → Mapear para `--state-*`. (E)
- **Tints hex hardcoded que duplicam tokens existentes:** `#0c1f15`(=`--state-ok-bg`), `#211c08`(=`--state-warn-bg`), `#161c24`(=`--state-neutral-bg`), `#2a1113`(=`--state-critical-bg`) repetidos em `.badge.*`, `.tile-badges .tb.*` (`index.css:598-601`), banners. → Substituir literais pelos `var(--state-*-bg)`. (E)
- **Layering inconsistente em `ui.css`:** `.ui-badge--ok` (`:108-110`) usa `color: var(--ok)` (legado) **+** `background: var(--state-ok-bg)` (novo) no mesmo seletor. → Unificar para `--state-*`. (E)
- **Inconsistência central × câmera:** o **novo** código da central (`alarms.css`, `views.css`) usa `--state-*` de forma limpa (referência de boa prática); o **nó `/camera`** e os cards de zona do `CameraWorkspace` (via index.css) seguem no legado. Hoje o hex é idêntico (os `--state-*` reaproveitam os hues legados), então **visualmente coerente** — mas o contrato de token está partido, e qualquer re-tematização (ex.: tema claro do `05-responsividade-css.md` §3.5) divergiria entre telas. ⚠️ (I)

### 3.3 Responsividade

- **Grid do Dashboard — redundância + código morto.** `index.css:262` declara `.dash-grid { grid-template-columns: repeat(var(--dash-cols,3), …) }`, mas **`--dash-cols` nunca é atribuído** (o JS define `data-cols`, `DashboardPage.tsx:581` + `colsFor()` `:23`). As colunas reais vêm de `views.css:14-17` (`[data-cols="N"]` em `@min-width:901`) + media queries md/sm do index.css. Logo o `var(--dash-cols)` é **dead code** e o comentário `index.css:257` ("--dash-cols (definida pela Fase 1)") é **enganoso**. ⚠️ Três mecanismos para uma coisa só. → Unificar: ou o JS escreve `style={{'--dash-cols':n}}` e some o `[data-cols]`, ou descarta o `var()` e mantém só `[data-cols]` + media. (E) — é o follow-up de `implementacao-changelog.md:118`.
- **Tabelas/heatmap densos sem scroll horizontal no mobile.** `.rtable` ganhou `min-width:560px` (`index.css:352`) ✅, mas **`.obj-matrix` não tem `min-width`** (`:660`) e o **heatmap `.hm-row`** segue `grid-template-columns: 84px repeat(24,1fr)` (`:328`) sem `min-width` nem affordance de overflow → ilegível/esmagado em tablet/mobile. Era item explícito do `05-responsividade-css.md §1.3.5`; **não endereçado**. ⚠️ → `min-width` + wrapper rolável (idealmente `ScrollArea horizontal`). (E)
- **`overflow:auto` nativo ainda em ~13 regiões** (`index.css` `.side .section.scroll`, `.dash-body`, `.rep-tabpanel`, `.rtable-wrap`, `.users-body`, `.dash-scroll`, `.read-flow`, `.ponto-console`, `.ws-zones`, `.obj-matrix-wrap`; `alarm-health.css:8`). A `ScrollArea` foi aplicada **seletivamente** (drawer da câmera, fila de alarmes, editor de views) — adoção **parcial** vs. a meta do plano (§2.1 do `05`). Não é bug; é polimento/consistência cross-browser pendente. (E)
- **Container queries conservadoras.** `index.css:199-202`: só `.side/.cam-drawer` com `container-type` e regra única em `@container (max-width:300px)`. Cobre o caso do KPI espremido, mas não os cards `.zone`/`.tile` sugeridos no `05 §3.3`. Aceitável p/ MVP. (E)
- **Alvos de toque ≥44px só no `sm`.** `index.css:550-553` e `ui.css:247-251` aplicam ≥44px em `≤640px`. No **md (641–900, tablet touch)** os mesmos `.del`/`.ui-btn--sm`/`.ui-seg-item` seguem 28–34px. ⚠️ menor. (E)
- **Breakpoints — dispersão residual aceita.** Canônicos sm640/md900/lg1200 documentados (`index.css:29-51`), mas exceções retidas e **declaradas**: `1000px` (`:319`, kpi-row/rep-2col), `980px` (`cine.css`), `860px` (`alarm-health.css`). Dívida menor e consciente. (E)

✅ **Bem feito:** `100vh`→`100dvh` com fallback nas 5 telas (`index.css:146-147,285,412,475`; `ui.css:223`); `viewport-fit=cover` (`index.html:5`) + tokens `--safe-*` aplicados no Toast (`ui.css:195`), bottom-nav (`index.css:541`) e bottom-sheets (`:533`, `alarms.css:44`); colapso de painéis laterais no md (`index.css:512-528`, vídeo soberano) — resolvia o ponto fraco nº 1 do `05`. (E)

### 3.4 Acessibilidade

- ✅ skip-link (`ui.css:234-235`), `:focus-visible` em todos os controles via `--ui-focus` (`ui.css:8-12`), `prefers-reduced-motion` global (`ui.css:237-239`). (E)
- ✅ Casca fullscreen: trap manual correto e **cede** ao Radix quando o Dialog de config abre (`CameraWorkspace.tsx:402`). Coberto por e2e (`app.spec.ts:99-115`). (E)
- ✅ Tabs Radix dão `role=tablist/tab/tabpanel` + setas (ReportPage, UsersPage, drawer da câmera); Toggle dá `aria-pressed`. (E)
- 🟡 Badges informativos só com `title=` (§3.1) não expõem texto a leitor de tela de forma confiável. (I)

### 3.5 Estados de UI

- ✅ `ErrorBoundary` global montado na raiz (`main.tsx:37`), `NotFoundPage` catch-all (`main.tsx:29`), ambos `role="alert"` com identidade do produto. (E)
- ✅ Toast Radix (provider em `main.tsx:38`); relatório distingue erro de vazio + retry + toast (`implementacao-changelog.md:22`; `ReportPage` usa Skeleton/EmptyState). (E)
- ✅ Confirmações destrutivas via `AlertDialog`/`useConfirm` (`AlertDialog.tsx`, `ConfirmProvider` em `main.tsx:21`). (E)

### 3.6 Cobertura de teste da migração

- `e2e/app.spec.ts` (5 testes): login+navegação, Select-em-Dialog (zona e dashboard), camadas ESC/clique-fora, casca fullscreen preservada. **Não exercita Tabs nem AlertDialog** — gap apontado em `implementacao-changelog.md:120` (Onda G) ainda **aberto**. ⚠️ (E)

---

## 4. Plano de retrofit (P0/P1/P2 com esforço)

### P0 — corrigir incoerência/efeito visível (baixo esforço, alto valor)
1. **Heatmap e `.obj-matrix` roláveis no mobile** — `min-width` + wrapper com scroll horizontal (`index.css:328,660`). Resolve ilegibilidade real em tablet/mobile. **Esforço: baixo.** ⚠️
2. **Desfazer o código morto do grid do Dashboard** — eliminar a redundância `--dash-cols` (dead) × `data-cols` × media queries: padronizar **um** mecanismo e corrigir o comentário enganoso (`index.css:257-262`, `views.css:13-17`, `DashboardPage.tsx:581`). **Esforço: baixo.**
3. **Remover CSS órfão** `.drawer-tabs button` (`index.css:504-506`). **Esforço: trivial.**

### P1 — alinhar tokens e completar migração (médio esforço)
4. **Convergir going-gray para `--state-*`** — substituir os 69 usos de `--ok/--idle/--empty/--alert` e os tints hex (`#0c1f15`/`#211c08`/`#161c24`/`#2a1113`) por `var(--state-*[-bg])` nas classes de `index.css` (`.badge.*`, `.zone.*`, `.tile.alerting`, `.tl .dot.*`, `.dot-status*` da `/camera`, `.flow-chip`, `.ponto-rate`, `.delta`) e corrigir o layering misto de `ui.css:108-110`. Encerrar a divergência central × câmera. Deprecar (não remover de imediato) os tokens-base legados. **Esforço: médio.** ⚠️
5. **Concluir `title=`→`Tooltip` e icon-buttons→`IconButton`** na toolbar/badges do `CameraWorkspace` (`:1073,1089,1090,1133,1134,1147,1190,1222,1223,1277` e `.del` em `:1150-1235`). **Esforço: baixo/médio.**
6. **Ampliar e2e** para Tabs (troca de aba por clique + setas, foco no painel) e AlertDialog (abrir/confirmar/cancelar; ESC) — fechar o gap da Onda G. **Esforço: baixo/médio.**

### P2 — polimento de consistência (oportunista)
7. **`ScrollArea` nas regiões `overflow:auto` restantes** (~13) para scrollbar cross-browser consistente, começando pelas listas longas (`.users-body`, `.ponto-console`, `.read-flow`, `.rtable-wrap`). **Esforço: médio.**
8. **Alvos ≥44px também no md (tablet touch)** e/ou tornar a regra de toque dependente de `(pointer:coarse)` em vez de só largura. **Esforço: baixo.**
9. **Expandir container queries** a `.zone`/`.tile` (densidade pelo próprio card) conforme `05 §3.3`; consolidar as exceções 1000/980/860px. **Esforço: médio.**
10. **`Button asChild`** no logout do AppShell e nos `.linkbtn`/resumo-cards do relatório, se quiser zerar `<button>` nativos (opcional — hoje têm a11y adequada). **Esforço: baixo.**

---

## 5. Conclusão

A Onda G entregou uma camada de UI Radix **consistente e correta nas invariantes** (`src/ui/` com `forwardRef`+`asChild`+tokens; casca fullscreen preservada como `div role="dialog"` com trap manual; going-gray com contrato `--state-*`). O que resta é **dívida de acabamento**, não de arquitetura: o sistema de tokens está **bifurcado** (legado ainda vivo ao lado de `--state-*`), o grid do Dashboard carrega **redundância/código morto** (`--dash-cols` nunca atribuído) e a migração de `title=`/icon-buttons e o tratamento de tabelas densas no mobile ficaram **incompletos**. Nada bloqueia produção; os P0 são correções de baixo esforço com efeito visível.
