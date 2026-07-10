# Auditoria Radix — DashboardPage, CameraPage, ProfilePage

> Escopo: `src/routes/DashboardPage.tsx`, `src/routes/CameraPage.tsx`, `src/routes/ProfilePage.tsx` e os componentes de `src/ui/` que elas consomem.
> Objetivo: maximizar o uso de **primitivas Radix** já instaladas (checkbox, dialog, dropdown-menu, label, scroll-area, select, slider, switch, tabs, toast, toggle-group, tooltip).
> Esta auditoria **não altera código** — apenas inventaria e prioriza.

## Resumo do estado atual

A base de UI (`src/ui/`) já é fortemente Radix: `Select`, `Switch`, `Checkbox`, `CheckboxRow`, `Slider`, `Dialog`, `Tooltip`, `Toast`, `SegmentedControl` (toggle-group **single**) e `Input/Field/Label` são wrappers finos sobre Radix. As três telas consomem esses wrappers na maior parte. As lacunas estão concentradas em **3 componentes bespoke** (drawer de alarmes, overlay de câmera aberta, chips de tipos no perfil) e em **listas roláveis nativas** (ainda não usam `ScrollArea`, apesar de instalado).

Observação importante: **nenhuma das três telas usa `window.confirm`**. A única confirmação nativa do projeto está em `src/routes/UsersPage.tsx:125` (fora do escopo deste tema, mas sinalizada ao final).

---

## 1. DashboardPage.tsx

### Tabela de controles

| Controle (arquivo:linha) | Atual | Radix alvo | Esforço |
|---|---|---|---|
| Seletor de view por setor (`DashboardPage.tsx:533`) | Radix `Select` (wrapper) | **OK** — manter `Select` | — |
| Botão "▤ Views" abre gerenciador (`DashboardPage.tsx:536`) | `Button` nativo + estado | **OK** (abre `Dialog`) | — |
| Toggle "Auto-destaque" (`DashboardPage.tsx:538`) | Radix `Switch` (em `Tooltip`) | **OK** — `Switch` | — |
| Toggle "Limite curto (10s)" (`DashboardPage.tsx:541`) | Radix `Switch` (em `Tooltip`) | **OK** — `Switch` | — |
| Botão "⚙ Câmeras" (`DashboardPage.tsx:543`) | `Button` nativo | **OK** (abre `Dialog`) | — |
| Link "+ Nó de câmera" (`DashboardPage.tsx:544`) | `<a class="ui-btn">` | OK (link real, `target=_blank`) — manter `<a>` | — |
| Paginação ‹ 1/2 › (`DashboardPage.tsx:545-551`) | `Button` nativo (prev/next) | Manter (Radix não tem primitiva de paginação) | — |
| Botão "▦ Alarmes" + badge (`DashboardPage.tsx:552-555`) | `Button active` + `<span>` badge | OK como gatilho; ver drawer abaixo | — |
| Pílulas de status hub/câmeras/online (`DashboardPage.tsx:556-560`) | `<span>` display (não interativo) | Sem Radix (display puro); `aria-live` já presente | — |
| **Modal "Configuração de câmeras"** (`DashboardPage.tsx:593-603`) | Radix `Dialog` | **OK** — `Dialog` | — |
| Select tipo de câmera (área/operador) (`DashboardPage.tsx:599`) | Radix `Select` | **OK** — `Select` | — |
| **Modal "Views por setor"** (`DashboardPage.tsx:606-667`) | Radix `Dialog` | **OK** — `Dialog` | — |
| Input "Nome da view" (`DashboardPage.tsx:631`) | `Input` (com `<label>` cru envolvendo) | Trocar `<label>`+`<span class=ui-label>` por `Field`/`FieldLabel` (Radix Label, associação `htmlFor`) | Baixo |
| Botões editar/excluir view (`DashboardPage.tsx:619-620`) | `Button` / `Button variant=danger` | OK; **excluir sem confirmação** → ver alerta abaixo | Médio |
| Reordenar câmeras ↑/↓/✕ (`DashboardPage.tsx:642-644`) | `IconButton` nativo | OK (sem primitiva de DnD no Radix) | — |
| Listas roláveis do editor (`.views-editor__col`, `views.css:52-61`) | `overflow-y:auto` nativo | **`ScrollArea`** (instalado, não usado) | Baixo |
| **Drawer "Fila de alarmes"** (`DashboardPage.tsx:670-691`) | `<aside>` bespoke + CSS `position:fixed` (`alarms.css:7`) | **`Dialog`** como drawer (foco preso, ESC, ARIA) — `modal={false}` se precisar interagir com a grade | Médio |
| Botão fechar drawer ✕ (`DashboardPage.tsx:676`) | `IconButton` | Vira `Dialog.Close` ao migrar o drawer | Baixo |
| Filtro prioridade (`DashboardPage.tsx:679`) | Radix `Select` | **OK** | — |
| Filtro estado (`DashboardPage.tsx:681`) | Radix `Select` | **OK** | — |
| "Limpar reconhecidos" (`DashboardPage.tsx:683`) | Radix `Checkbox` + `<label>` cru | Usar `CheckboxRow` (Radix Label) p/ consistência | Baixo |
| Lista de cards de alarme (`.alarm-drawer__list`, `alarms.css:51`) | `overflow-y:auto` nativo | **`ScrollArea`** | Baixo |
| Botões Reconhecer/Encaminhar no card (`DashboardPage.tsx:496-497`) | `Button` | **OK** | — |
| **Overlay "câmera aberta"** (`DashboardPage.tsx:584-590`, `.cam-overlay` `index.css:501`) | `<div>` bespoke full-bleed | `Dialog` (modal) para ESC/foco/`aria-modal` — **avaliar custo**: contém canvas/inferência ativa, fechar via ESC já não existe hoje | Médio/Alto |
| Tooltip "Auto-destaque"/"Limite curto" (`DashboardPage.tsx:537,540`) | Radix `Tooltip` | **OK** | — |
| `title=lastError` na pílula de status do tile (`DashboardPage.tsx:515`) | atributo `title` nativo | `Tooltip` (melhor consistência/acessível) | Baixo |

### Destaques

- **Excluir view sem confirmação** (`DashboardPage.tsx:426-431` / botão `:620`): a exclusão é otimista (com rollback em erro), porém **não há diálogo de confirmação**. Ação destrutiva de estado compartilhado → recomenda-se **`AlertDialog`**. ⚠️ `@radix-ui/react-alert-dialog` **não consta na lista de instalados** — exigiria adicionar a dependência (alternativa pobre: reusar `Dialog` como confirmação).
- **`ScrollArea` instalado mas não usado** em nenhuma das listas roláveis (editor de views e lista de alarmes). Ganho de consistência visual de scrollbar + comportamento cross-browser.

---

## 2. CameraPage.tsx

Tela deliberadamente **sem controles** ("Nó de câmera · processamento e controles ficam na central", `CameraPage.tsx:115`). A aquisição de stream é automática (`acquireCameraStream`, escada de constraints), não há seletor de dispositivo nem controles de captura na UI.

| Controle (arquivo:linha) | Atual | Radix alvo | Esforço |
|---|---|---|---|
| Badge de status (dot + estado) (`CameraPage.tsx:105-114`) | `<span class="dot-status">` display | Sem Radix (display puro); poderia ganhar `Tooltip` no perfil de captura | Baixo |
| Aviso "Sem HTTPS" (`CameraPage.tsx:116`) | `<div class="cam-node-err">` | `Alert` do design system (`misc.tsx`, `role=alert`) — não é Radix, mas padroniza | Baixo |
| Mensagem de erro (`CameraPage.tsx:117`) | `<div class="cam-node-err">` | `Alert tone="alert"` | Baixo |
| (inexistente) Seletor de dispositivo de câmera | — | **Se** vier a existir: `Select` (enumerar `MediaDevices`) | Médio (feature nova) |
| (inexistente) Controles de captura (fps/resolução) | controlados pelo hub via socket `capture` | — (intencional; manter no painel) | — |

**Conclusão:** quase nada a "radixificar" aqui — a tela é minimalista por design. As únicas melhorias são padronizar os avisos via `Alert` e, se um seletor de dispositivos for introduzido no futuro, usar `Select`.

---

## 3. ProfilePage.tsx

| Controle (arquivo:linha) | Atual | Radix alvo | Esforço |
|---|---|---|---|
| Campo "Número (com DDD)" (`ProfilePage.tsx:62-64`) | `Field` + `Input` (Radix `Label`) | **OK** | — |
| Opt-in LGPD (`ProfilePage.tsx:66`) | `CheckboxRow` (Radix Checkbox + Label) | **OK** — manter **Checkbox** (consentimento explícito, não Switch) | — |
| "Receber alertas" (`ProfilePage.tsx:67`) | `CheckboxRow` | OK; debatível trocar por `Switch` (preferência de ligar/desligar) | Baixo (opcional) |
| "Apenas alertas críticos" (`ProfilePage.tsx:68`) | `CheckboxRow` | OK; mesmo caso acima | Baixo (opcional) |
| **Chips "Tipos (vazio = todos)"** (`ProfilePage.tsx:70-77`) | `<button class="cfg-chip">` nativos com toggle manual de `on` | **`ToggleGroup` `type="multiple"`** (Radix toggle-group) — roving tabindex, `aria-pressed`, teclado | Médio |
| Botão "Salvar" (`ProfilePage.tsx:80`) | `Button type=submit` | **OK** | — |
| Indicador "● receberá alertas" (`ProfilePage.tsx:81`) | `<span>` display | Sem Radix (display) | — |
| Mensagens de status/erro (`ProfilePage.tsx:83-84`) | `Alert` (design system) | **OK** | — |
| Formulário (`ProfilePage.tsx:59`) | `<form onSubmit>` nativo + validação manual (`willReceive`) | Manter `<form>` nativo — `@radix-ui/react-form` **não está instalado** | — |

### Destaque

- **Chips de tipos (`cfg-chip`)** são o único controle realmente bespoke do perfil: um multi-select implementado com `<button>`+classe `.on`. O `SegmentedControl` existente é **single** (`type="single"`); aqui é necessário um wrapper **`ToggleGroup type="multiple"`** (toggle-group já instalado). Ganho real de acessibilidade (navegação por teclado, `aria-pressed`) com esforço médio.

---

## 4. Lacunas de responsividade por tela

### Dashboard
- **Inline style anula o media query da grade (bug):** `DashboardPage.tsx:578` aplica `style={{ gridTemplateColumns: repeat(colsFor(n),1fr) }}` direto na `.dash-grid`. Estilo inline **vence** as regras responsivas de `index.css:467` (`@900px → 1fr 1fr`) e `:470` (`@640px → 1fr`), que ficam **inertes**. Em telas estreitas a grade pode insistir em 3–4 colunas espremidas. Recomendação: mover a decisão de colunas para CSS responsivo (ou clampar `colsFor` por largura via `matchMedia`/container queries).
- **Cabeçalho sobrecarregado em mobile:** `.page-head` tem ~9 controles (view-picker, Views, 2 switches, Câmeras, Nó, paginação, Alarmes, stats). Em `@640px` só faz `flex-wrap` (`index.css:483`), virando uma barra alta. Oportunidade: colapsar ações secundárias num **`DropdownMenu`** ("Mais ações") — primitiva instalada, não usada em nenhum lugar.
- **Drawer de alarmes não tem variante mobile:** `.alarm-drawer` é `width: min(380px,92vw)` em altura cheia (`alarms.css:7-19`). Note que `.cam-drawer` (CameraWorkspace) já vira bottom-sheet em `@640px` (`index.css:471`), mas o drawer de alarmes **não** tem esse tratamento — em celular ele cobre quase toda a tela lateralmente. Migrar para `Dialog`-drawer facilitaria também o layout bottom-sheet em mobile.

### Camera
- Tela essencialmente fluida (`video` + badge). `.cam-head` ganha `flex-wrap` em `@640px` (`index.css:484`). Sem lacuna relevante de responsividade — não há formulário nem grade.

### Profile
- `.profile-form` é `max-width:520px`, coluna única (`index.css:416`) — adapta bem a mobile.
- Chips de tipos usam `flex-wrap` (`.cfg-classes`, `index.css:600`) — ok; ao migrar para `ToggleGroup`, preservar o `flex-wrap` para não estourar em telas estreitas.

---

## 5. Prioridades

**P1 — Alto impacto, esforço médio**
1. **Chips de tipos → `ToggleGroup type="multiple"`** (`ProfilePage.tsx:70-77`). Único controle bespoke do perfil; ganho direto de acessibilidade com primitiva já instalada.
2. **Corrigir grade responsiva do Dashboard** (`DashboardPage.tsx:578`): o estilo inline neutraliza os media queries. É um bug de responsividade real, não só estético.
3. **Drawer de alarmes → `Dialog` (drawer)** (`DashboardPage.tsx:670-691`): hoje é `<aside>` bespoke sem foco preso/ESC; ganha acessibilidade e abre caminho para variante bottom-sheet mobile.

**P2 — Consistência, esforço baixo**
4. **Usar `ScrollArea`** (instalado, hoje ocioso) nas listas roláveis: lista de alarmes (`alarms.css:51`) e colunas do editor de views (`views.css:52`).
5. **Padronizar checkboxes/labels avulsos:** "Limpar reconhecidos" (`DashboardPage.tsx:683`) → `CheckboxRow`; "Nome da view" (`DashboardPage.tsx:629-632`) → `Field`/`FieldLabel`.
6. **Avisos do CameraPage → `Alert`** (`CameraPage.tsx:116-117`).

**P3 — Melhoria de UX/robustez**
7. **`DropdownMenu` de overflow no cabeçalho do Dashboard** para mobile (primitiva instalada, não usada).
8. **Confirmação de exclusão de view** (`DashboardPage.tsx:426`/`:620`): ação destrutiva sem confirmação → idealmente `AlertDialog` (⚠️ **não instalado**; requer `@radix-ui/react-alert-dialog`).
9. **Overlay de câmera aberta → `Dialog`** (`DashboardPage.tsx:584`): avaliar custo, pois embute canvas/inferência ativa; ganho seria ESC/foco/`aria-modal`.

**Fora do escopo (sinalizado):**
- `window.confirm` em `src/routes/UsersPage.tsx:125` ("Remover o usuário…") deveria virar **`AlertDialog`** — única confirmação nativa do projeto.
