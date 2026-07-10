# Auditoria de Frontend — Biblioteca de Componentes UI (`src/ui/*`)

> Objetivo do produto: usar **primitivas Radix** no máximo possível (melhor integração com browser, acessibilidade e responsividade).
> Escopo desta auditoria: todos os arquivos de `src/ui/` + `src/components/AppShell.tsx`.
> Esta é uma auditoria de **leitura**. Nenhum código foi alterado.

---

## Sumário executivo

A biblioteca já está **bem encaminhada**: 7 dos componentes interativos críticos (Switch, Checkbox, Slider, Select, SegmentedControl, Tooltip, Dialog, Toast) já são wrappers finos sobre Radix, com tokens CSS próprios (`--*`) e foco visível padronizado (`ui.css:8-11`). Os pontos fracos concentram-se em:

1. **Padrões fora do design system** — `confirm()` nativo em `UsersPage.tsx:125` (deveria ser `AlertDialog`), e o `SegmentedControl` (Radix ToggleGroup) sendo usado como **abas com painel de conteúdo** em vários lugares (`ReportPage.tsx`, `CameraWorkspace.tsx:1129`), onde o correto semanticamente é `Tabs`.
2. **Primitivas instaladas e ociosas** — `@radix-ui/react-tabs`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-scroll-area` constam no `package.json` mas **não têm wrapper nem uso** no código.
3. **Inconsistência de `forwardRef`/`asChild`** — os wrappers Radix (`Switch`, `Select`, `Slider`, `Dialog`, etc.) não fazem `forwardRef` nem expõem `asChild`, diferente de `Button`/`Input`/`Textarea` que já usam `forwardRef`. Isso impede compor com `Tooltip`/`Dialog.Trigger` (que dependem de `asChild` + ref encaminhada).

---

## (1) Tabela: componente → estado atual → primitiva Radix alvo → esforço → ganho

| Componente | Arquivo:linha | Estado atual (renderiza) | Já usa Radix? | Primitiva Radix alvo | Esforço | Ganho |
|---|---|---|---|---|---|---|
| `Button` | `Button.tsx:8-14` | `<button>` nativo + classes | Não | Manter nativo; **adicionar `asChild` via `Slot`** (`@radix-ui/react-slot`) | Baixo | Permite `<Button asChild><a>` (links estilizados) e uso como `Trigger` de Dialog/Tooltip sem `<button>` aninhado |
| `IconButton` | `Button.tsx:17-23` | `<button>` nativo, `aria-label`+`title` | Não | Idem `Button` (`Slot`) | Baixo | Mesma composição; já tem A11y correta (`aria-label`) |
| `Input` | `form.tsx:6-8` | `<input>` nativo + `forwardRef` | Não (não precisa) | Manter nativo | — | Nativo é o ideal; ok |
| `Textarea` | `form.tsx:10-12` | `<textarea>` nativo + `forwardRef` | Não (não precisa) | Manter nativo | — | Ok |
| `FieldLabel` | `form.tsx:14-16` | `Label.Root` | **Sim** (`react-label`) | — | — | Correto; clique no label foca o controle |
| `Field` | `form.tsx:19-29` | `<div>` molécula (label+controle+hint/erro) | Parcial (usa FieldLabel) | Manter; **ligar `aria-describedby`** do erro/hint ao controle | Baixo | Erro/hint passam a ser anunciados pelo leitor de tela vinculados ao input |
| `Switch` | `controls.tsx:7-13` | `RSwitch.Root/Thumb` | **Sim** | — (já ideal) | — | Falta `forwardRef`/`asChild` para compor |
| `Checkbox` | `controls.tsx:15-21` | `RCheckbox.Root/Indicator` | **Sim** | — | — | Não trata estado `indeterminate` (Radix suporta `"indeterminate"`) |
| `CheckboxRow` | `controls.tsx:24-31` | `<div>` + Checkbox + `Label.Root` | **Sim** | — | — | Ok; associação acessível via `htmlFor`↔`id` |
| `Slider` | `controls.tsx:33-40` | `RSlider.Root/Track/Range/Thumb` | **Sim** | — | — | Single-thumb; A11y nativa do Radix. Falta `forwardRef` |
| `SegmentedControl` | `SegmentedControl.tsx:7-17` | `Toggle.Root type="single"` | **Sim** (ToggleGroup) | Manter p/ "filtro/modo"; **migrar p/ `Tabs` quando há painel** | Médio | Ver seção (2); ToggleGroup não anuncia relação aba↔painel |
| `Select` | `Select.tsx:7-31` | `RSelect.*` (Trigger/Portal/Content/Item) | **Sim** | — | — | Excelente; portal + `position="popper"`. Falta `forwardRef` |
| `Dialog` | `Dialog.tsx:6-27` | `RDialog.*` (Portal/Overlay/Content) | **Sim** | — (mas ver `AlertDialog`) | — | Foco preso, ESC, scroll-lock, ARIA — tudo via Radix |
| `Toast`/`ToastProvider` | `Toast.tsx:16-33` | `RToast.*` + Context | **Sim** | — | — | `swipeDirection`, `duration`, viewport regionalizada. Ótimo |
| `Tooltip`/`TooltipProvider` | `Tooltip.tsx:5-21` | `RTooltip.*` (Portal/Arrow) | **Sim** | — | — | Ok; depende de `asChild` no Trigger (filho precisa encaminhar ref) |
| `Badge` | `misc.tsx:4-6` | `<span>` decorativo | Não (não precisa) | Manter | — | Ok |
| `Spinner` | `misc.tsx:8` | `<span aria-hidden>` | Não | Manter | — | Decorativo correto |
| `Skeleton`/`SkeletonText` | `misc.tsx:11-16` | `<span aria-hidden>` shimmer | Não | Manter | — | Ok; respeita `prefers-reduced-motion` (`ui.css:176`) |
| `Alert` | `misc.tsx:19-21` | `<div role=alert/status>` | Não | Manter (alternativa: Radix não tem primitiva p/ isso) | — | A11y correta (live region por tom) |
| `EmptyState` | `misc.tsx:23` | `<div>` | Não | Manter | — | Ok |
| `KpiCard` | `misc.tsx:25-28` | `<div>` | Não | Manter | — | Ok |
| `PageHeader` | `PageHeader.tsx:4-15` | `<header>`+`<h1>` | Não | Manter; opcional **`Separator`** no rodapé do header | Baixo | Hierarquia de cabeçalho correta |
| `AppShell` (rail nav) | `AppShell.tsx:8-32` | `<nav>`+`NavLink` + skip-link + foco em rota | Não | Manter nav; ver `DropdownMenu` p/ "Sair"/perfil | Baixo | A11y já forte (skip-link, foco em `main` ao trocar rota, `aria-label`) |

---

## (2) Componentes que DEVERIAM existir como wrapper Radix e não existem

### 2.1 `AlertDialog` — confirmações (ALTA prioridade)
Hoje há `confirm()` **nativo do browser** em `UsersPage.tsx:125`:
```
if (!confirm(`Remover o usuário "${u.usuario}"?`)) return;
```
`window.confirm` bloqueia a thread, não é estilizável, não respeita o tema escuro e tem A11y limitada.
- **Alvo:** `@radix-ui/react-alert-dialog` (a **instalar**).
- **Ganho:** foco preso, ESC, botões "Cancelar/Confirmar" estilizados com os tokens, e o foco inicial recai sobre o botão seguro. É a primitiva canônica para destruição de dados.
- **Esforço:** Médio (criar wrapper `ConfirmDialog` + substituir o `confirm()`).

### 2.2 `Tabs` — abas com painel (ALTA prioridade)
`@radix-ui/react-tabs` **está instalado mas nunca é usado**. Em vez disso, o `SegmentedControl` (ToggleGroup) controla a troca de **painéis de conteúdo** em:
- `ReportPage.tsx:434, 505, 576, 652` (abas "Quando/Onde/Tendência/Eventos")
- `CameraWorkspace.tsx:1129` (`drawerTab`: zonas/linhas/timeline/presença/camadas)

ToggleGroup não cria a relação ARIA `role="tab"`↔`role="tabpanel"` (`aria-controls`/`aria-labelledby`), nem o gerenciamento de foco roving entre abas com `Tab`/setas que `Tabs` provê.
- **Alvo:** `@radix-ui/react-tabs` (já instalado).
- **Ganho:** semântica de abas correta, navegação por teclado padrão, lazy-mount de painéis.
- **Esforço:** Médio (criar `Tabs` wrapper; manter `SegmentedControl` só para "modo/filtro" sem painel, p.ex. `ReportPage.tsx:319/328`).

### 2.3 `DropdownMenu` — menus de ação (MÉDIA)
`@radix-ui/react-dropdown-menu` **instalado, sem uso**. Não há menu kebab/ações no código hoje, mas ações como logout/perfil no rail (`AppShell.tsx:24-26`) e ações por linha em `UsersPage` são candidatas naturais.
- **Alvo:** `@radix-ui/react-dropdown-menu` (já instalado).
- **Ganho:** menu acessível com portal, teclado e foco — evita reinventar.
- **Esforço:** Baixo/Médio (criar wrapper quando houver a primeira ação composta).

### 2.4 `ScrollArea` — áreas roláveis (MÉDIA)
`@radix-ui/react-scroll-area` **instalado, sem uso**. Há regiões com `overflow:auto` (ex.: `ui-dialog-body` em `ui.css:129`, listas em `views.css`/`alarms.css`).
- **Alvo:** `@radix-ui/react-scroll-area` (já instalado).
- **Ganho:** scrollbar estilizada e consistente cross-browser, sem perder rolagem nativa por teclado/touch.
- **Esforço:** Baixo (wrapper), porém **opcional** — `overflow:auto` nativo já é acessível; ganho é mais visual.

### 2.5 `RadioGroup` — escolha exclusiva (MÉDIA)
Não existe wrapper. Onde a escolha é exclusiva e visualmente "rádio" (não segmentada), hoje usa-se `SegmentedControl` (ToggleGroup) ou `Select`. Para grupos de opções com descrição, `RadioGroup` é o correto.
- **Alvo:** `@radix-ui/react-radio-group` (a **instalar**).
- **Ganho:** roving focus + semântica `radiogroup` nativa.
- **Esforço:** Baixo (quando surgir o caso de uso).

### 2.6 `Separator` — divisores (BAIXA)
Divisores hoje são `border-top`/`border-bottom` em CSS (`ui.css:127, 22`).
- **Alvo:** `@radix-ui/react-separator` (a **instalar**).
- **Ganho:** `role="separator"` + `aria-orientation` (separador semântico vs. decorativo).
- **Esforço:** Baixo, baixo retorno — cosmético.

### 2.7 `Accordion` / `Collapsible` — seções expansíveis (BAIXA)
Sem uso atual. O drawer da câmera com várias seções (`CameraWorkspace.tsx`) poderia usar `Collapsible` se virar acordeão.
- **Alvo:** `@radix-ui/react-accordion` / `react-collapsible` (a **instalar**) — **somente se** surgir o padrão.
- **Esforço:** Baixo (sob demanda).

### 2.8 `Popover` — conteúdo flutuante rico (BAIXA/MÉDIA)
Sem wrapper. Para conteúdo flutuante mais rico que um tooltip (mini-formulários, color pickers de zona), `Popover` é o alvo.
- **Alvo:** `@radix-ui/react-popover` (a **instalar**, sob demanda).
- **Esforço:** Baixo.

---

## (3) Recomendação: primitivas Radix a ADICIONAR ao projeto

Priorização por impacto real no código existente:

| Prioridade | Pacote | Justificativa (uso concreto) |
|---|---|---|
| **1 — Alta** | `@radix-ui/react-alert-dialog` | Substituir `confirm()` em `UsersPage.tsx:125` (confirmação de exclusão) |
| **1 — Alta** | `@radix-ui/react-slot` | Habilitar `asChild` em `Button`/`IconButton` — base p/ compor com Tooltip/Dialog/DropdownMenu |
| **2 — Já instalado, ativar** | `@radix-ui/react-tabs` | Migrar abas-com-painel de `ReportPage`/`CameraWorkspace` que hoje usam ToggleGroup |
| **2 — Já instalado, ativar** | `@radix-ui/react-dropdown-menu` | Menus de ação (rail, ações por linha) |
| **3 — Já instalado, ativar** | `@radix-ui/react-scroll-area` | Scrollbars consistentes em diálogos/listas (opcional) |
| **3 — A instalar, sob demanda** | `@radix-ui/react-radio-group` | Escolha exclusiva tipo rádio |
| **4 — A instalar, sob demanda** | `@radix-ui/react-popover` | Conteúdo flutuante rico |
| **4 — A instalar, cosmético** | `@radix-ui/react-separator` | Divisores semânticos |
| **5 — A instalar, se surgir** | `@radix-ui/react-accordion` / `react-collapsible` | Seções expansíveis no drawer |

> Observação: as primitivas já instaladas que **estão ociosas** (`tabs`, `dropdown-menu`, `scroll-area`) representam custo já pago — ativá-las é o melhor custo/benefício antes de instalar novas.

---

## (4) Padrão de wrapper recomendado

A biblioteca já tem um bom padrão implícito; falta uniformizar três pontos: **`forwardRef`**, **`asChild`** e **estilização exclusiva via tokens**.

### 4.1 `forwardRef` em TODOS os wrappers interativos
`Button`/`Input`/`Textarea` já fazem (`Button.tsx:8`, `form.tsx:6,10`). Os wrappers Radix (`Switch`, `Checkbox`, `Slider`, `Select`, `Dialog`) **não fazem** — isso quebra a composição com `Tooltip`/`Dialog.Trigger`, que precisam encaminhar a ref ao filho via `asChild`. Recomendação: encaminhar ref para o `*.Root`/`*.Trigger` correspondente.

### 4.2 `asChild` para composição (via `Slot`)
Expor `asChild` (ou aceitar ser usado como filho de um `Trigger asChild`) em `Button`/`IconButton` permite:
```tsx
<Tooltip content="Sair"><IconButton label="Sair">⎋</IconButton></Tooltip>
<Dialog trigger={<Button asChild><a href="...">Abrir</a></Button>} .../>
```
O `Dialog` (`Dialog.tsx:12`), `Tooltip` (`Tooltip.tsx:12`) e `Select` já consomem `asChild` do Radix internamente; o gargalo é o **filho** encaminhar a ref. `@radix-ui/react-slot` resolve no lado dos átomos.

### 4.3 Estilização SOMENTE via tokens existentes
Manter o padrão de `ui.css`: classes `ui-*` consumindo variáveis de tema. Atenção: hoje há **hex hardcoded** dentro de `ui.css` (ex.: `#0b3a4a`, `#155e75`, `#bae6fd`, `#1a2430` em `ui.css:23,84,89,94,122`) em vez dos tokens semânticos `--state-*`/`--cam-*` que existem no projeto (usados em `CameraWorkspace.tsx`, `views.css`, `index.css`, etc.). Recomendação: mapear esses literais para tokens (`--state-*` para estados ok/warn/alert/info; `--cam-*` para superfícies do workspace de câmera), garantindo tematização única.

### 4.4 Esqueleto de wrapper recomendado
```tsx
import { forwardRef } from "react";
import * as RPrimitive from "@radix-ui/react-...";

type Props = React.ComponentPropsWithoutRef<typeof RPrimitive.Root> & {
  /* props de conveniência do design system */
};

export const Componente = forwardRef<
  React.ElementRef<typeof RPrimitive.Root>,
  Props
>(function Componente({ className, ...rest }, ref) {
  return (
    <RPrimitive.Root
      ref={ref}
      className={cx("ui-componente", className)} // estilo via token, nunca inline
      {...rest}
    />
  );
});
```
Princípios:
- **Radix faz a A11y** (foco, teclado, ARIA, portal, scroll-lock); o wrapper só adiciona classe + API ergonômica.
- **`className` sempre encaminhado** (já feito em `Button`/`form`; faltam os demais).
- **Tokens, nunca hex** — usar `--state-*`/`--cam-*`/`--accent`/`--border` etc.
- **`forwardRef` + `asChild`** para composição entre primitivas.

---

## Apêndice — Estado de A11y / browser já presente (pontos fortes a preservar)

- Foco visível unificado por `:focus-visible` com `box-shadow` (`ui.css:8-11`).
- `prefers-reduced-motion` respeitado globalmente (`ui.css:176-178`).
- Skip-link + foco programático no `<main>` ao trocar rota (`AppShell.tsx:12, 17, 29`).
- `Dialog`/`Select`/`Tooltip`/`Toast` usam **Portal** (`Dialog.tsx:13`, `Select.tsx:17`, `Tooltip.tsx:13`, viewport em `Toast.tsx:29`), com `z-index` e `pointer-events:auto` ajustados p/ funcionar dentro de Dialog modal (`ui.css:77`).
- `Alert` com live region por tom (`misc.tsx:20`).
- Alvos de toque ≥ ~32px (`--ui-ctrl-h: 34px`, `ui.css:6`) e ajustes responsivos `@media (max-width:640px)` (`ui.css:181-186`).
</content>
</invoke>
