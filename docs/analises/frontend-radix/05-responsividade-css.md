# Auditoria Frontend · Radix — 05 · Responsividade, layout e fundação CSS

> Tema (cross-cutting): **estratégia de responsividade, layout e fundação de design system**.
> Escopo lido: `index.html`, `vite.config.ts`, `src/main.tsx`, `src/components/AppShell.tsx`,
> `src/index.css`, `src/ui/ui.css`, e os CSS de feature (`src/routes/views.css`,
> `src/routes/alarms.css`, `src/routes/alarm-health.css`, `src/report/alarms.css`,
> `src/components/telemetry.css`, `src/camera/cine.css`).
> **Nada de código foi alterado** — este é um artefato de diagnóstico/recomendação.
> Data: 2026-06-28.

---

## 0. Mapa rápido do que existe hoje

| Camada | Arquivo | Papel |
|---|---|---|
| Shell SPA | `AppShell.tsx` + `.shell`/`.rail`/`.shell-main` (`index.css`) | Rail lateral fixo (148px) → bottom-nav no mobile |
| Fundação de tokens | `:root` em `index.css` | Cores, `--state-*`, `--cam-*`, espaçamento `--sp-1..5`, raio, `--rail-w` |
| Átomos/moléculas | `ui.css` + `src/ui/*.tsx` | Radix: Select, Dialog, Tooltip, Toast, Switch/Checkbox/Slider, ToggleGroup (SegmentedControl), Label |
| Features pesadas | `CameraWorkspace.tsx`, `DashboardPage`, `ReportPage` | Câmera full (overlay manual), drawers, grades de tiles, relatório |

**Radix instalado mas NÃO usado:** `react-scroll-area`, `react-tabs`, `react-dropdown-menu`.
Estes três são exatamente os que mais elevariam a responsividade e a integração com o browser (ver §2).

---

## 1. Diagnóstico da responsividade atual

### 1.1 Estratégia geral

- **Desktop-first** com `@media (max-width: …)`. Não há abordagem mobile-first nem
  breakpoints tokenizados.
- **Breakpoints dispersos e não padronizados**: `1000px`, `980px`, `900px`, `860px`,
  `720px`, `640px`. Cada feature inventou o seu. Não há um conjunto canônico
  (`--bp-sm/md/lg`) documentado. Isso fragmenta o comportamento — um tablet de 768px
  cai em regras diferentes dependendo da tela.
- **Unidades**: quase tudo em `px` (base `body { font-size: 13px }`, tipografia de 9px a
  30px hardcoded). Pontos positivos: `min(560px, 92vw)` em Dialog, `min(420px, 94vw)` em
  Toast, `min(380px, 92vw)` em alarm-drawer — bom uso de `min()` para conter em telas
  estreitas. **Não há** `rem`, `clamp()` (tipografia fluida), nem container queries.
- **Layout**: CSS Grid para os shells (`.shell`, `.app`, `.main`, `.full-body`, `.cam`,
  `.full-cam`) e Flexbox para o miolo dos componentes. Uso correto do par
  `min-height: 0` + `overflow` para criar regiões roláveis dentro de grids/flex
  (`.shell-main`, `.side .scroll`, `.rep-tabpanel`, `.drawer-body`).
- **Viewport**: `<meta name="viewport" content="width=device-width, initial-scale=1.0">`.
  **Falta `viewport-fit=cover`** (necessário para usar `env(safe-area-inset-*)` em
  aparelhos com notch/home-indicator).

### 1.2 Comportamento por breakpoint

**Desktop (> 1000px) — forte.**
- Shell rail (148px) + conteúdo; painéis laterais fixos (`.main` = `1fr 360px`,
  `.full-body` = `1fr 340px`, `.cam-drawer` = 320px). Layout estável e legível.
- Grades fluidas com `repeat(auto-fit, minmax(…, 1fr))` em vários blocos
  (`.notif-types`, `.rep-resumo`, `.ah-kpis`, `.pc-kpis`) — escalam bem sozinhas.

**Tablet (641–1000px) — ponto fraco principal.**
- `@media (max-width: 1000px)` só ajusta `.kpi-row` (5→2 col) e `.rep-2col` (2→1).
- **`.main` (`1fr 360px`) e `.full-body` (`1fr 340px`) NÃO têm regra de colapso até
  640px.** Entre 641 e 900px o painel lateral fixo de 340–360px engole o palco de vídeo;
  num tablet retrato (768px) sobra pouco para a imagem ("a imagem é soberana" fica
  comprometida).
- `@media (max-width: 900px)`: rail vira faixa de ícones (52px) e `.dash-grid` vira 2
  colunas. Razoável, mas o painel lateral da câmera continua fixo.
- O **heatmap** (`.hm-row { grid-template-columns: 84px repeat(24, 1fr) }`) tem 24 colunas
  fixas — em tablet/mobile estoura ou fica ilegível (não há scroll horizontal próprio
  nem colapso).

**Mobile (≤ 640px) — bom esqueleto, lacunas pontuais.**
- Conversão rail → **bottom-nav** (`.shell` vira `1fr / auto`, `.rail` vira linha
  inferior com ícone+label). Padrão correto e bem executado.
- `.cam-drawer` vira **bottom sheet** (58% de altura). Bom.
- `.dash-grid` vira 1 coluna; `.ui-seg` ganha scroll horizontal; `.rep-filters` quebra
  linha; `.ui-dialog` vira 96vw. Tudo coerente.
- **Lacunas:**
  - `.alarm-drawer` (fixed, `min(380px,92vw)`) **não** tem regra mobile para virar bottom
    sheet — fica como overlay lateral que cobre quase a tela toda em 380px.
  - `.cam` (câmera full) é overlay com `role="dialog"`/`aria-modal` **manual** (não Radix);
    sem scroll-lock real do body nem trap de foco garantido.
  - Sem `env(safe-area-inset-bottom)` no bottom-nav: em iPhone com home-indicator a barra
    inferior fica sob o gesto do sistema.

### 1.3 Onde quebra (resumo acionável)

1. **`height: 100vh`** em `.app`, `.shell`, `.cam-node`, `.login-screen`, `.error-screen`
   (5 ocorrências). No mobile (Safari/Chrome com barra de URL dinâmica) `100vh` é maior
   que a área visível → conteúdo/bottom-nav fica cortado ou sob a barra. **Trocar por
   `100dvh`** (com fallback `100vh`).
2. **Painéis laterais fixos sem colapso em tablet** (`.main`, `.full-body`,
   `.cam-drawer`): faixa 641–900px espreme o vídeo.
3. **Alvos de toque < 44px**: `.ui-btn` (34px), `.ui-btn--sm` (28px), `.ui-seg-item`
   (30px), `select` global (30px), e principalmente os **icon-buttons `.del`/`.zone .del`**
   (font 11–13px, sem área mínima). Falham na WCAG 2.5.5 (alvo ≥ 44×44).
4. **Sem safe-area** (notch / home-indicator) — falta `viewport-fit=cover` + `env()`.
5. **Heatmap e tabelas largas** (`.rtable`, `.obj-matrix`, `.hm-row`) sem affordance de
   scroll horizontal consistente no mobile.
6. **Tipografia em `px` fixo** (base 13px): não respeita a preferência de tamanho de fonte
   do usuário (acessibilidade/zoom) e dificulta escala fluida.

---

## 2. Onde Radix + Popper elevam a responsividade e a integração com o browser

> Princípio: usar **as 3 primitivas instaladas e ociosas** (ScrollArea, Tabs,
> DropdownMenu) e fortalecer as já usadas (Dialog, Tooltip, Toast).

### 2.1 ScrollArea — **maior oportunidade** (instalada, 0 usos)

Hoje há **muitas regiões com `overflow: auto/y` manual**, cada uma com a barra de rolagem
nativa do SO (inconsistente entre Windows/macOS/Linux, e "pulando" o layout no Windows):

- `.shell-main`, `.side .section.scroll`, `.dash-body`, `.dash-scroll`
- `.drawer-body`, `.ws-zones`, `.obj-matrix-wrap`, `.rtable-wrap`
- `.rep-tabpanel`, `.read-flow`, `.ponto-console`, `.users-body`, `.ah-body`
- `.alarm-drawer__list`, `.views-editor__col`

Trocar por **`@radix-ui/react-scroll-area`** dá: barra custom estilizável e idêntica em
todos os navegadores, sem "layout shift" da scrollbar nativa do Windows, suporte a
teclado/touch, e gancho para sombras de overflow (indicar que há mais conteúdo). Ganho
direto de consistência cross-browser e de polimento mobile.

### 2.2 Dialog — formalizar overlays manuais

- `Dialog` Radix já é usado nos modais de config (bom: foco preso, ESC, portal, ARIA).
- **`.cam` (câmera full)** é um overlay com `role="dialog"`/`aria-modal` **feito à mão** —
  não tem scroll-lock do body nem trap de foco garantido pelo browser. Migrar para Radix
  Dialog (ou um Sheet baseado em Dialog) entrega scroll-lock, `inert` no fundo e gestão de
  foco corretos.
- **Bottom sheets** (`.cam-drawer`, `.alarm-drawer`): hoje são `position: absolute/fixed`
  manuais. Como Dialog não-modal ou modal do Radix, ganham portal + foco + ESC e ficam
  triviais de tornar bottom-sheet responsivo via data-attributes.

### 2.3 Tabs — abas com teclado (instalada, 0 usos)

- `.drawer-tabs button` (CameraWorkspace) são `<button>` simples, **sem `role="tablist"`,
  sem navegação por setas, sem `aria-selected`**.
- As abas do relatório usam `SegmentedControl` (ToggleGroup) como se fossem abas —
  semanticamente deveriam ser **Tabs** (associação `tab`↔`tabpanel`, roving tabindex,
  setas ←/→). Migrar para `@radix-ui/react-tabs` dá acessibilidade de teclado e ARIA
  corretos "de graça".

### 2.4 Tooltip / DropdownMenu — posicionamento via Popper (colisão com viewport)

- `Tooltip` Radix já existe (bom: Popper resolve colisão com a borda da tela, `sideOffset`,
  Arrow). Porém há **muitos `title="…"`** nativos (rail-item, `.zone .del`, ferramentas de
  zona): tooltips nativos não posicionam, não colidem e **não funcionam em touch**.
  Padronizar nos `Tooltip` Radix.
- **DropdownMenu** (instalada, 0 usos): no mobile, várias ações em linha (ferramentas de
  zona/tripwire, ações de alarme) deveriam **colapsar em um menu "⋯"**. O DropdownMenu usa
  Popper → reposiciona sozinho quando não cabe, evitando overflow horizontal das toolbars
  em telas estreitas.

### 2.5 Toast — viewport responsiva (já bom, ajuste fino)

- `.ui-toast-vp` = `min(420px, 94vw)`, bottom-center, `swipeDirection="down"`. Já
  responsivo. **Ajuste:** somar `env(safe-area-inset-bottom)` ao `bottom` para não colar no
  home-indicator.

### 2.6 Select — já migrado (bom)

`Select` Radix substitui o `<select>` nativo com conteúdo portado, `--radix-select-trigger-width`
e clique garantido dentro de Dialog modal. Manter.

---

## 3. Recomendações de fundação (tokens, breakpoints, container queries)

> A fundação atual (`--state-*`, `--cam-*`, `--sp-*`) é boa e madura. As recomendações
> abaixo **estendem** sem quebrar o contrato existente.

### 3.1 Breakpoints canônicos (documentar e usar 3, no máximo 4)

Padronizar para encerrar a dispersão (1000/980/900/860/720/640). Sugestão:

| Token (doc) | Valor | Uso |
|---|---|---|
| `sm` | `≤ 640px` | Mobile: bottom-nav, sheets, 1 coluna |
| `md` | `≤ 900px` | Tablet: rail-ícones, painéis laterais colapsam/stack |
| `lg` | `≤ 1200px` | Desktop estreito: grades densas reduzem colunas |

Obs.: CSS não permite `var()` na *condição* de `@media`. Documente os valores e, onde o
layout for **dirigido pelo componente** (e não pela viewport), prefira **container queries**
(§3.3). Para breakpoints de viewport, considere centralizar via SCSS/PostCSS ou um
arquivo único de `@media`.

### 3.2 Tipografia fluida + escala em `rem`

- Definir `html { font-size: 100% }` e migrar tamanhos para `rem` para respeitar a
  preferência do usuário (acessibilidade/zoom).
- Criar escala tipográfica em tokens com `clamp()` (fluida):

```css
:root {
  --fs-2xs: clamp(.625rem, .6rem + .2vw, .75rem);   /* 10→12 */
  --fs-xs:  clamp(.6875rem, .65rem + .25vw, .8125rem);
  --fs-sm:  clamp(.8125rem, .78rem + .3vw, .875rem);
  --fs-md:  clamp(.875rem, .82rem + .4vw, 1rem);
  --fs-lg:  clamp(1rem, .9rem + .6vw, 1.25rem);
  --fs-xl:  clamp(1.25rem, 1.05rem + 1vw, 1.75rem);  /* KPIs grandes */
}
```

Substitui a profusão de `font-size: 9px…30px` espalhados.

### 3.3 Container queries — o maior ganho estrutural para este app

Este produto é **multi-painel** (tiles de câmera, cards de zona, painéis laterais que mudam
de largura independentemente da viewport). O ponto de quebra real é a **largura do
container**, não da tela. Adotar `@container`:

- `.dash-grid` / `.tile` / `.ponto-tiles`: ajustar densidade pela largura da grade.
- `.zone` / `.ws-zone` / `.kpi`: empilhar KPIs internos quando o card é estreito (resolve
  o caso do painel lateral espremido em tablet sem inventar mais breakpoints de viewport).
- `.side` / `.cam-drawer` / `.full-body`: comportar-se igual seja em desktop estreito ou em
  tablet, porque reagem ao próprio tamanho.

```css
.side, .cam-drawer, .dash-body { container-type: inline-size; }
@container (max-width: 320px) { .kpis { grid-template-columns: 1fr 1fr; } }
```

### 3.4 Espaçamento, z-index, elevação e safe-area como tokens

- Estender espaçamento: `--sp-6: 32px; --sp-7: 48px`.
- **Escala de z-index** (hoje há números mágicos: 5, 6, 10, 40, 100/101, 150, 200, 300):
  `--z-sticky, --z-overlay, --z-drawer, --z-dialog, --z-popper, --z-toast`.
- **Tokens de elevação**: as sombras `0 …px rgba(0,0,0,.4/.5)` se repetem — `--shadow-1/2/3`.
- **Safe-area**: `--safe-b: env(safe-area-inset-bottom)` etc. (requer `viewport-fit=cover`).

### 3.5 Dark/Light e prefers-* 

- `prefers-reduced-motion` **já tratado** em `ui.css` (ótimo) — manter e garantir que
  novas animações fiquem sob ele.
- Hoje só há tema escuro com cores no `:root` global. Para escalar temas, mover as cores
  para um seletor de tema (`:root`/`[data-theme="dark"]` e `[data-theme="light"]`) e/ou
  `@media (prefers-color-scheme: light)`. O contrato `--state-*`/`--cam-*` permanece; só os
  valores trocam por tema. (Atenção: a tela de câmera é deliberadamente dark — "a imagem é
  soberana" — pode permanecer dark mesmo em tema claro.)

---

## 4. Checklist de responsividade (app inteira)

### Fundação / global
- [ ] Trocar `height: 100vh` por `100dvh` (fallback `100vh`) em `.app`, `.shell`,
      `.cam-node`, `.login-screen`, `.error-screen`.
- [ ] `<meta viewport>` com `viewport-fit=cover`.
- [ ] Tokens de safe-area + aplicar no bottom-nav e no Toast viewport.
- [ ] Migrar base tipográfica para `rem` + escala `--fs-*` com `clamp()`.
- [ ] Consolidar breakpoints em 3 (sm/md/lg) e remover os dispersos (980/860/720/1000).
- [ ] Adicionar escala de z-index e de elevação (shadow) como tokens.

### Layout / breakpoints
- [ ] `.main` (`1fr 360px`) e `.full-body` (`1fr 340px`): regra de colapso/stack em `md`
      (≤900px) — vídeo soberano, painel vira sheet/abaixo.
- [ ] `.cam-drawer`: já vira sheet em 640 — validar em 641–900 (tablet).
- [ ] `.alarm-drawer`: adicionar regra mobile → bottom sheet (hoje não tem).
- [ ] Heatmap (`.hm-row` 24 col) e tabelas largas: container com scroll horizontal +
      affordance (sombra de overflow via ScrollArea).
- [ ] Adotar `container-type` nos painéis/cards e migrar densidade interna para
      `@container`.

### Primitivas Radix (responsividade + browser)
- [ ] **ScrollArea** em todas as regiões `overflow:auto` (lista em §2.1).
- [ ] **Tabs** para `.drawer-tabs` e para as abas do relatório (hoje ToggleGroup/botões).
- [ ] **Dialog/Sheet** para `.cam` full e para os drawers (scroll-lock + foco + portal).
- [ ] **DropdownMenu** para colapsar toolbars de ação no mobile (Popper anti-colisão).
- [ ] **Tooltip** Radix no lugar dos `title="…"` nativos (touch + posicionamento).
- [ ] **Toast**: somar safe-area-inset-bottom.

### Acessibilidade / toque
- [ ] Alvos de toque ≥ 44×44 no mobile: `.del`, `.zone .del`, `.ui-iconbtn`,
      `.ui-btn--sm`, `.ui-seg-item`, `select` (aumentar área/`min-height` em `sm`).
- [ ] Navegação por teclado em abas (resolve com Radix Tabs: setas + roving tabindex).
- [ ] Manter `:focus-visible`/`--ui-focus` e `skip-link` (já bons) ao migrar para Radix.
- [ ] Garantir `prefers-reduced-motion` cobrindo as animações de drawer/toast/pulse.
- [ ] Testar zoom de fonte do SO (depende da migração para `rem`).

### Validação por dispositivo (matriz mínima)
- [ ] Mobile retrato 360–414px (Android/iOS) — bottom-nav, sheets, safe-area, 100dvh.
- [ ] Tablet retrato 768px e paisagem 1024px — colapso dos painéis laterais.
- [ ] Desktop 1280/1440/1920 — densidade das grades de KPI/heatmap.
- [ ] Windows + macOS — consistência de scrollbar (antes/depois de ScrollArea).
- [ ] Impressão do relatório (`@media print` já existe — revalidar após mudanças).

---

## 5. Síntese — 3 maiores oportunidades

1. **Adotar Radix ScrollArea em todas as regiões roláveis** (15+ blocos com `overflow:auto`
   manual): scrollbar consistente cross-browser, sem layout-shift no Windows, com
   affordance de overflow — maior salto de polimento com baixo risco.
2. **Resolver o colapso dos painéis laterais em tablet com container queries** (`.main`,
   `.full-body`, `.cam-drawer`, cards/KPIs): hoje os 340–360px fixos espremem o vídeo entre
   641–900px; `@container` torna os painéis responsivos ao próprio tamanho e encerra a
   dispersão de breakpoints.
3. **Corrigir a fundação mobile**: `100vh → 100dvh`, `viewport-fit=cover` + safe-area no
   bottom-nav/Toast, alvos de toque ≥ 44px, e formalizar a câmera full / drawers como
   Dialog/Sheet do Radix (scroll-lock + foco) — além de migrar abas para Radix Tabs.
