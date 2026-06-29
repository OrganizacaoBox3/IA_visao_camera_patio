# Auditoria Radix — ReportPage, UsersPage, AlarmHealthPage

> Auditoria de leitura (nenhum código foi alterado). Objetivo: maximizar o uso de **primitivas Radix**
> nas três telas densas (abas, filtros, tabelas, formulários, cards).
> Data: 2026-06-28.

## 0. Estado atual do design system (`src/ui/`)

O projeto **já tem uma camada sólida de wrappers Radix**. As três telas consomem esses átomos,
então grande parte do trabalho de migração já está feito. Wrappers existentes:

| Átomo (`src/ui/`) | Primitiva Radix | Usado nas telas? |
|---|---|---|
| `Select` (`Select.tsx`) | `@radix-ui/react-select` | Sim (todos os filtros/papéis/duração) |
| `SegmentedControl` (`SegmentedControl.tsx`) | `@radix-ui/react-toggle-group` (single) | Sim (modos, abas internas, seções) |
| `Switch`, `Checkbox`, `CheckboxRow`, `Slider` (`controls.tsx`) | `react-switch` / `react-checkbox` / `react-slider` / `react-label` | Sim (toggles de notificação/destinatário/status) |
| `Field`, `FieldLabel`, `Input`, `Textarea` (`form.tsx`) | `@radix-ui/react-label` (Input/Textarea são nativos — Radix não tem primitiva de input) | Parcial |
| `Tooltip`, `TooltipProvider` (`Tooltip.tsx`) | `@radix-ui/react-tooltip` | Não usado nestas telas (há muito `title=` nativo) |
| `Dialog` (`Dialog.tsx`) | `@radix-ui/react-dialog` | Não usado nestas telas |
| `Toast` / `useToast` (`Toast.tsx`) | `@radix-ui/react-toast` | Sim (feedback de ações) |

### Primitivas instaladas mas **NÃO usadas** (oportunidade direta)

- **`@radix-ui/react-scroll-area` (1.2.12)** — instalada, **sem wrapper e sem nenhum uso** no `src/`.
  Todas as listas/tabelas roláveis usam `div.rtable-wrap`/`div.alarm-list`/`div.ah-shelves` com
  `overflow:auto` nativo. Maior oportunidade não explorada.
- **`@radix-ui/react-tabs` (1.1.15)** — instalada, **sem wrapper e sem uso**. As "abas" hoje são
  `SegmentedControl` (toggle-group) + renderização condicional manual (`{tab === "..."}`) ou
  atributo `hidden={secao !== "..."}`. Funciona, mas perde a semântica ARIA de tablist/tabpanel.
- **`@radix-ui/react-dropdown-menu` (2.1.18)** — instalada, sem uso. Candidata para os menus de
  "Ações" das tabelas (overflow de botões por linha).

### Lacuna de dependência

- **`@radix-ui/react-alert-dialog` NÃO está instalado** (não está no `package.json`). O enunciado
  pede `window.confirm → AlertDialog`, então é preciso **instalar a primitiva** OU reaproveitar o
  `Dialog` existente como modal de confirmação (`@radix-ui/react-dialog` já está instalado).
  Recomendação: instalar `react-alert-dialog` (semântica `alertdialog` correta para destrutivos).

---

## 1. Inventário por tela

Esforço: **Baixo** (troca mecânica/wrapper já existe) · **Médio** (refatorar estrutura + CSS) · **Alto** (nova primitiva/wrapper + reescrita).
Ganho: acessibilidade, consistência cross-browser, responsividade.

### 1.1 ReportPage.tsx

| Controle (arquivo:linha) | Atual | Radix alvo | Esforço | Ganho |
|---|---|---|---|---|
| Modo do relatório (`ReportPage.tsx:319`) | `SegmentedControl` (toggle-group) | OK — manter (`ToggleGroup`); ou `Tabs` se quiser semântica de aba | — | já Radix |
| Período (`:328`) | `SegmentedControl` | OK — já Radix | — | já Radix |
| Turno (`:329`) | `Select` | OK — já Radix | — | já Radix |
| Prioridade / Estado alarmes (`:331`,`:332`) | `Select` | OK — já Radix | — | já Radix |
| Ponto / Setor / Posto / Área (`:334`,`:336`,`:338`,`:340`) | `Select` | OK — já Radix | — | já Radix |
| **Abas internas Quando/Onde/Tendência/Eventos** (`:434`,`:505`,`:576`,`:652`) | `SegmentedControl` + render condicional `{tab === ...}` (`:435`+) | **`Tabs`** (`Tabs.Root`/`List`/`Trigger`/`Content`) | Médio | ARIA tablist/tabpanel, `aria-controls`, navegação por setas nativa |
| **Tabela de eventos/leituras/ocorrências** (`:480`,`:551`,`:627`,`:678`) | `div.rtable-wrap` + `overflow:auto` nativo | **`ScrollArea`** envolvendo a `<table>` | Médio | scrollbar estilizada cross-browser; rolagem horizontal previsível no mobile |
| **Matriz Setor × Classe** (`:597`) | `div.obj-matrix-wrap` + `overflow:auto` | **`ScrollArea`** (horizontal) | Médio | matriz larga → scroll horizontal consistente |
| **Lista de cards de alarme** (`:750`, `alarm-list`) | `div` flex coluna, lista longa (até 500) | **`ScrollArea`** com altura máxima | Médio | lista longa rolável; vê-se o cabeçalho "Eventos (N)" fixo |
| Cards de alarme clicáveis (`:752`) | `<button>` nativo (filtro bidirecional) | Manter `<button>` (interação custom de seleção) | — | adequado |
| Heatmap / barras de evolução / tendência clicável (`:441`,`:469`,`:713`,`:727`) | `div`/`<button>` + SVG-like via CSS | Manter (visualização); só os **controles ao redor** viram Radix | — | conforme escopo |
| **"limpar histórico"** (`:492`,`:563`,`:639`,`:690` → `onClear` `:103`) | `<button class=linkbtn>` **sem confirmação**, apaga TODO o histórico | **`AlertDialog`** (instalar) | Médio | evita perda de dados acidental (hoje é destrutivo sem aviso) |
| Botões Apresentação / CSV / PDF / ↻ (`:343`-`:346`) | `Button`/`IconButton` (custom) | Manter (Radix não tem primitiva de botão) | — | adequado |
| `title=` nativo em células/cards (heatmap, evo, etc.) | atributo `title` | Opcional: `Tooltip` Radix | Baixo/Médio | tooltip acessível e estilizado (porém volume alto de células — avaliar custo) |

### 1.2 UsersPage.tsx

| Controle (arquivo:linha) | Atual | Radix alvo | Esforço | Ganho |
|---|---|---|---|---|
| **Seções Usuários/Notificações/Câmeras** (`UsersPage.tsx:148`) + `hidden={secao!==...}` (`:151`,`:164`,`:188`,`:226`,`:254`,`:267`) | `SegmentedControl` + `hidden` | **`Tabs`** (Root/List/Trigger/Content) | Médio | painéis associados por ARIA; remove o controle manual de `hidden` |
| Select de papel — novo usuário (`:262`) | `Select` | OK — já Radix | — | já Radix |
| Select de papel — linha da tabela (`:276`) | `Select` | OK — já Radix | — | já Radix |
| Switch ativo do usuário (`:277`) | `Switch` | OK — já Radix | — | já Radix |
| Switch "só críticos" / "ativo" do destinatário (`:243`,`:244`) | `Switch` | OK — já Radix | — | já Radix |
| Switch ativo por tipo de notificação (`:204`) | `Switch` | OK — já Radix | — | já Radix |
| Checkboxes local/hora/rodapé (`:195`-`:197`) e "só críticos" (`:232`) | `CheckboxRow` | OK — já Radix | — | já Radix |
| **`confirm("Remover o usuário…")`** (`:125`, em `onDelete`) | **`window.confirm` nativo** | **`AlertDialog`** (instalar) | Médio | confirmação acessível/estilizada; destaque destrutivo |
| **Tabela de usuários** (`:269` `rtable-wrap`) | `div` + `overflow:auto` | **`ScrollArea`** | Médio | scroll horizontal no mobile (4–5 colunas + selects/switches) |
| **Tabela de destinatários** (`:235` `rtable-wrap`) | `div` + `overflow:auto` | **`ScrollArea`** | Médio | idem (5 colunas) |
| **Form "Novo usuário"** (`:256`-`:264`) | `Input` só com `placeholder` (sem `<label>`); Select tem `ariaLabel` | **`Field`/`FieldLabel`** (Radix Label) em cada input | Baixo | rótulos associados (acessibilidade) |
| **Form "Destinatários"** (`:229`-`:234`) | `Input` só com `placeholder` | **`Field`/`FieldLabel`** | Baixo | rótulos associados |
| Input de teste WhatsApp (`:172`) | `Input` só com `placeholder` | `Field`/`FieldLabel` | Baixo | acessibilidade |
| Campo "Marca/assinatura" (`:192`-`:194`) | já em `Field`+`Input` | OK | — | já Radix |
| Ações por linha "Resetar/Remover" (`:279`,`:280`) | dois `Button` lado a lado | Opcional: **`DropdownMenu`** (overflow "⋯") | Médio | economiza largura em telas estreitas |
| Banner de senha revelada (`:140`-`:145`) | `div.users-reveal` + `Button` | Opcional: `Dialog` (modal one-time) | Médio | foco/affordance maior para copiar a senha |

### 1.3 AlarmHealthPage.tsx

| Controle (arquivo:linha) | Atual | Radix alvo | Esforço | Ganho |
|---|---|---|---|---|
| Select de duração do shelve (`AlarmHealthPage.tsx:227`) | `Select` | OK — já Radix | — | já Radix |
| Campos Chave / Motivo (`:223`-`:231`) | `Field` + `Input` (Radix Label) | OK — já Radix | — | já Radix |
| Botões Criar / Remover shelve (`:204`,`:233`) | `Button` | Manter | — | adequado |
| **Lista de shelves ativos** (`:190` `ah-shelves`) | `div` flex coluna | **`ScrollArea`** (altura máx.) quando a lista cresce | Baixo/Médio | lista longa rolável dentro do card |
| Remover shelve (`:204` → `onRemove` `:106`) | sem confirmação (otimista, reversível: pode recriar) | Opcional: `AlertDialog` | Baixo | confirmação leve (prioridade baixa — ação reversível) |
| KPIs de saúde (`:133`-`:167`) | `div.ah-kpi` + `Sparkline` (SVG) | Manter (visualização) | — | fora de escopo Radix |
| Barra de distribuição por prioridade `PriorityDist` (`:254`+) | `div` proporcional (analógico) | Manter (SVG/visual); opcional `Tooltip` por segmento | Baixo | tooltip acessível nos segmentos |
| Sem abas nesta tela | — | — | — | não aplicável |

---

## 2. Lacunas de responsividade

### 2.1 Tabelas em mobile (principal lacuna)
- **`.rtable-wrap`** (`index.css:304`): `max-height:320px; overflow:auto` — rola vertical, mas a
  `.rtable` (`:305`) **não tem `min-width`**. Em telas estreitas as 4–5 colunas comprimem em vez de
  oferecer scroll horizontal limpo. Com `ScrollArea` + `min-width` na `<table>` o comportamento fica
  previsível (scrollbar horizontal estilizada).
- Em **UsersPage** as tabelas contêm `Select` (papel) e `Switch` (status) dentro das células
  (`UsersPage.tsx:276`,`:277`,`:243`,`:244`): no mobile esses controles + colunas de ações
  (`:278`-`:281`) ficam apertados. `ScrollArea` horizontal é o mínimo; idealmente um layout "card por
  linha" abaixo de ~640px.
- **`panel-events .rtable-wrap`** (`index.css:261`) força `max-height:none; overflow:visible` — nessas
  tabelas quem rola é `.rep-tabpanel` (`:259`). Migrar para `ScrollArea` unifica a estratégia (hoje
  há dois mecanismos de scroll diferentes).
- **Matriz objeto** `.obj-matrix-wrap` (`index.css:591`): `overflow:auto` — muitas colunas de classe;
  `ScrollArea` horizontal melhora a leitura.

### 2.2 Filtros
- **`.rep-filters`** (`index.css:254`) é `display:flex` sticky; `ui.css:183` adiciona `flex-wrap:wrap`
  a partir de 640px. Mas a barra tem muitos controles (período + turno + filtro contextual + ↻ +
  Apresentação + CSV + PDF). Ao quebrar em várias linhas, ocupa muita altura no mobile e compete com
  o `position:sticky`. Sugestão: agrupar ações secundárias (CSV/PDF/Apresentação) em um
  **`DropdownMenu`** "⋯" no mobile.

### 2.3 Formulários
- **`.users-new`** (`index.css:378`, `ui.css:184`) é `flex-wrap:wrap` — inputs encolhem ao envolver;
  sem `min-width` por campo podem ficar estreitos demais. Em mobile, empilhar (coluna) seria melhor.
- Os forms de **Novo usuário** e **Destinatários** usam `placeholder` como rótulo (sem `<label>`):
  além da lacuna de acessibilidade, ao focar/preencher o usuário perde a referência do campo —
  agravado no mobile. Migrar para `Field`/`FieldLabel` resolve.
- **AlarmHealthPage** já usa `Field` corretamente e `.ah-cols` colapsa para 1 coluna em ≤860px
  (`alarm-health.css:99`) — bom padrão de referência para as outras telas.

### 2.4 KPIs
- `.kpi-row` (`index.css:266`): 5 colunas → 2 colunas em ≤1000px (`:274`). Abaixo de ~480px, 2 colunas
  ainda apertam números mono de 26px; considerar 1 coluna. Baixa prioridade.

---

## 3. Prioridades

### P0 — Alto impacto, corrige risco/acessibilidade
1. **Confirmações nativas → `AlertDialog`** (instalar `@radix-ui/react-alert-dialog`):
   - `UsersPage.tsx:125` `window.confirm` ao remover usuário.
   - `ReportPage.tsx` **"limpar histórico"** (`onClear`, `:103`) — hoje apaga **todo** o histórico
     **sem nenhuma confirmação**: maior risco funcional encontrado.
2. **`ScrollArea` nas tabelas e listas longas** (primitiva instalada e ociosa): tabelas de eventos do
   Report (`:480`/`:551`/`:627`/`:678`), matriz (`:597`), `alarm-list` (`:750`), tabelas de
   UsersPage (`:235`/`:269`). Unifica scroll e resolve a lacuna mobile (2.1).

### P1 — Consistência semântica
3. **Abas via `Tabs`** (primitiva instalada e ociosa): abas internas do Report
   (`:434`/`:505`/`:576`/`:652`) e seções de UsersPage (`:148` + `hidden`). Ganho de ARIA
   (tablist/tabpanel/`aria-controls`) e navegação por teclado; remove `hidden` manual.
4. **Rótulos de formulário com `Field`/`FieldLabel`**: forms "Novo usuário" e "Destinatários"
   (`UsersPage.tsx:256`-`264`, `229`-`234`) e input de teste WhatsApp (`:172`).

### P2 — Refinos opcionais
5. `DropdownMenu` (instalado, ocioso) para ações por linha (UsersPage `:278`-`281`) e para condensar
   a toolbar de filtros do Report no mobile.
6. `Tooltip` Radix substituindo `title=` em pontos-chave (heatmap, segmentos do `PriorityDist`).
7. `AlertDialog` leve na remoção de shelve (`AlarmHealth :106`) — baixa prioridade (ação reversível).
8. Layout "card por linha" para tabelas de UsersPage abaixo de 640px.

---

## Resumo

As três telas já consomem amplamente a camada de átomos Radix (Select, SegmentedControl/ToggleGroup,
Switch/Checkbox, Label/Field, Toast). As maiores lacunas são primitivas **instaladas porém nunca
usadas** (`ScrollArea`, `Tabs`) e **confirmações destrutivas nativas/ausentes**. A migração é
incremental e de baixo/médio esforço por já existir o design system.
