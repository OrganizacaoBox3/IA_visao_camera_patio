# Laudo — Padronização de layout do SPA (revisão de aderência)

> Data: 2026-07-13 · Gatilho: o dono viu layouts diferentes por aba na tela BLE e pediu revisão de
> consistência para TODO o SPA. Insumo: auditoria read-only em 4 frentes (contrato canônico · shells
> de página · telas com abas/painéis · estados transversais). Este laudo é a régua da correção.

## 0. Veredito: a base é forte, os desvios são concentrados e mecânicos

Não há anarquia. **As 11 telas de rota usam `PageHeader` (um `<h1>` só)**; o design system de `src/ui/`
está completo (Panel, Table, Tabs, EmptyState, Alert, Badge, Spinner, SectionTitle, form). Cinco telas
são exemplares (Central, Câmeras, Perfil, 404, Relatório). O que diverge são **detalhes de paridade
entre telas/abas irmãs** e **estados** (vazio/carregando/erro) reimplementados fora do átomo — coisa que
o olho pega, como o dono pegou na BLE.

## 1. O contrato canônico (o padrão da casa — a régua)

- **Esqueleto de página:** `<div class="page">` (flex-col, height 100%, min-h 0, **não rola**) → `PageHeader`
  (o único `<h1>`) → **corpo rolável** (o único com `overflow:auto` + `flex:1 min-h-0`, padding `--sp-4`).
- **Regra de ouro:** a página **nunca rola na horizontal**; conteúdo largo rola dentro da própria caixa.
- **Heading:** `h1` só via `PageHeader`; `h2` de seção só via `SectionTitle`. Nunca `<h3>` cru.
- **Superfície:** `Panel` (cartão de seção) · `Table` (dados tabulares, com scope + scroll interno) ·
  lista `ul/li` (streams/timelines) · Tabs (visões exclusivas do mesmo domínio, sob o PageHeader).
- **Os três estados são obrigatórios, cada um com seu átomo:** vazio → `<EmptyState>` (ou `<TableEmpty>`
  em tabela); carregando → `<Spinner>`+`aria-busy` ou `<Skeleton>`; erro → `<Alert tone="alert">`.
- **Feedback, um canal cada:** sucesso → `toast`; erro de página → `Alert`; erro de campo → prop `error`
  do `Field`; confirmação destrutiva → `useConfirm()`/`AlertDialog` (nunca `window.confirm`).
- **Tokens, nunca valor cru em página:** espaçamento `--sp-1..5` (4/8/12/16/24); tipografia `--fs-*`
  (`text-[Npx]` é proibido no lint); cor de estado só via `--state-*` (going-gray), nunca só-por-cor.

## 2. As correções desta rodada (por dono-de-arquivo — paralelizável sem colisão)

**Onda 1 — paridade BLE (a queixa):** `ble/EstacoesTab.tsx` converge para o irmão `TagsTab` (referência):
loader `text-body` (não `text-sec`), `Alert` de erro com botão "Tentar novamente", faixa de status
sempre visível (não some quando a lista está vazia).

**Onda 2 — domínio Relatório** (`routes/report/*` + `ReportPage.tsx`): Leitura e Alarmes ganham
`<KpiRow fit>` como os outros três modos; Resumo/Alarmes passam a usar `<RepLens>` e `<HistoryFooter>`
compartilhados (em vez de reescrever `.rep-lens`/`.rep-foot`); o erro do `ReportPage` vira `<Alert>` (era
`.dash-empty`, casca de vazio); os 4 headings crus de `AlarmHealthStrip`/`ReportTools` viram `SectionTitle`;
vazios de `AlarmesPanel`/`EmptyHistory` viram `<EmptyState>`; badges de alarme viram `<Badge tone>`.

**Onda 3 — domínio Usuários** (`UsersPage.tsx` + `users/*`): o tabpanel de Câmeras ganha o mesmo
container flex-col/gap/min-h dos irmãos; a tabela de Destinatários ganha skeleton de carregamento como a
de Usuários; `panel-events` fica consistente entre as listas; um só sinal de loading no `UsersTab`.

**Onda 4 — estados diversos** (arquivos disjuntos): `cameras/IpCamerasSection.tsx` (loading `Spinner`,
vazio `EmptyState`); `TurnosPage.tsx` (padding/gap 12→16px, o padrão da casa); `TagsMapPage.tsx` (padding
da faixa de erro por token); `CameraPage.tsx` (erro inline vira `Alert`); `dashboard/AlarmDrawer.tsx`
(badges → `Badge`, vazio → `EmptyState`).

**Onda 5 — estrutural** (`ReplayPlayerPage.tsx`): adota `.page` + `PageHeader` + corpo rolável — o scroll
sai do fluxo do documento para o corpo (o único desvio de estrutura grave).

### Contrato compartilhado entre as ondas (para os badges convergirem igual)
`alarm-badge b-${priority}`/`s-${state}` → `<Badge tone>` com o mapa: prioridade alta/crítica → `alert`,
média → `warn`, baixa/normal → `default`; estado OK → `ok`, advisory → `info`. Mesma regra em
`AlarmesPanel` e `AlarmDrawer`.

## 3. Deferido de propósito (não é regressão — é escopo)
- **Grafia de espaçamento** (`gap-2` ↔ `var(--sp-2)`): coincidem em pixels (exceto `sp-5`=24 vs `gap-5`=20,
  uma armadilha pontual). Unificar a grafia é churn de ~7 telas **sem mudança visual** — baixo ROI, risco
  de e2e. Fica como higiene futura (candidato a regra de lint, não a edição manual agora).
- **Primitivos novos** que a auditoria sugeriu como lacunas reais mas são projeto à parte: `<PageBody>`
  (o corpo rolável, reimplementado em ~8 classes), `<Kpi>` (subir de `report/` para `src/ui/`), `<Card>`
  interativo, `<StatusDot>`, `<Toolbar>/<FilterBar>`, `<Chip/ToggleChip>`, `<Meter>`. Criar+migrar cada um
  é uma rodada dedicada; fazê-los no meio de uma passada de aderência misturaria "abstração nova" com
  "conserto", contra a regra de uma responsabilidade por commit.
- **Exceções conscientes** (legítimas, registradas): `CameraPage` (`.cam-node` fullscreen kiosk, sem shell,
  ADR-007) e `TagsMapPage` (split mapa+lista full-bleed) — não seguem o esqueleto de shell de propósito.
