# SPEC — Padronização de interface (enforcement da constituição + gaps de fundação)

> Status: **proposta aguardando aval do dono** · Data: 2026-07-12
> Insumos: auditoria read-only em 3 frentes (doutrina+kit / telas operacionais / telas admin),
> 17 telas percorridas, lente = doutrina de `/agentes` + atomic design + Radix + a11y/semântica.

## 0. O achado que muda o tamanho do plano

**A casa JÁ tem a constituição escrita e o kit atômico maduro.** `docs/analises/ui-review/
02-doutrina-casa.md` traz 15 regras verificadas (going-gray, mapa fixo estado→token, 7 papéis
tipográficos, escala `--sp-*`, headings via `PageHeader`/`SectionTitle`, layout sem scroll de body,
Lucide único, a11y como contrato com nome acessível load-bearing no e2e). `src/ui/` tem ~20 átomos/
moléculas sobre Radix (Button/IconButton com aria forçado, Field, Select blindado com Portal,
Tabs, AlertDialog/useConfirm, Toast, EmptyState, Skeleton…), e `PageHeader` já é adotado em 10 das
13 telas de rota.

**Logo o trabalho NÃO é criar um design system — é (a) fechar 9 gaps de fundação e (b) fazer
enforcement tela a tela**, priorizado por impacto no operador. Isso também blinda o futuro: as
telas novas (Turnos, BtTags, TagsMap, Replay) são exatamente as que mais violam (33 `text-[Npx]`
em 10 arquivos — as 4 novas lideram), sinal de que sem gate a constituição erode.

## 1. Os gaps de FUNDAÇÃO (F0 — arquivos que nenhuma frente de produto toca)

| # | gap | conserto |
|---|---|---|
| G1 | **`Field` é mudo para leitor de tela** (o achado que contamina TODO formulário): erro é `<span>` sem `role`, sem `aria-describedby`, e NADA seta `aria-invalid` (o estilo `aria-[invalid=true]` existe e nunca dispara) | `Field` liga label/hint/erro por `aria-describedby`, seta `aria-invalid` no controle, erro com `role="alert"` — 1 arquivo conserta o app inteiro |
| G2 | **Átomo `Table` inexistente** — 4 telas improvisam `<table>` cru (metade sem `scope="col"`), cada uma reinventa scroll/zebra/densidade | `src/ui/Table.tsx`: semântica correta (`th scope`), rolagem interna (regra A12), densidade padrão |
| G3 | **Sem `:focus-visible` global** — cada átomo carrega o seu; elemento fora dos wrappers fica sem anel | reset global no `index.css` com o token `--ui-focus` existente |
| G4 | **Sem escala `--z-*`** — z-index mágicos dispersos (300/60/10/6/5…) | família `--z-{base,overlay,popover,toast}` tokenizada; Portal Radix e overlays de canvas na mesma escala |
| G5 | **Cascata: CSS de página unlayered VENCE utilities** (armadilha sistêmica p/ tela nova) | mover CSS de rota para `@layer components` (ou regra documentada + lint) |
| G6 | **Seletores órfãos já quebrando layout** (`.ui-dialog-body`, `.cine-bar .ui-toggle`) | consertar os 2 (dívidas #2/#3 já catalogadas) |
| G7 | **Aliases de estado legados** (`--ok/--idle/--empty/--alert`) vivos em 3 telas | migrar consumidores → aposentar aliases (dívida #7) |
| G8 | **Cor hex crua em CSS de página** (cine 11, telemetry 6, alarms 3, report 2) + `rgba()` fora das exceções documentadas | migrar para tokens; exceções (rampa de Heatmap, contraste de canvas) permanecem documentadas |
| G9 | **Átomo `Card/Panel` informal** (classes legadas `.panel/.card/.side`) | formalizar `PageSection`/`Panel` em `src/ui` (mantendo as classes como implementação) |

**+ Gate novo no CI:** e2e ganha **axe-core** (Playwright) nas rotas principais — a11y deixa de ser
revisão manual e vira sensor (mesmo espírito do gate mobile-390 que já existe). E um lint barato:
proibir `text-[` e `#hex` em `src/routes/**` (grep no CI ou regra ESLint).

## 2. Enforcement tela a tela (os TOP achados, rankeados por impacto no operador)

**Operacionais (Auditor 2):**
1. **FadigaView fullscreen SEM focus-trap/ESC/role=dialog** — o CameraWorkspace tem (trap manual,
   ADR-007); a outra tela fullscreen do MESMO fluxo não. Foco vaza atrás do overlay. **O pior
   achado de a11y do app.**
2. **Dois consoles divergentes**: CameraWorkspace (Lucide+Badge+Toggle) vs FadigaView (emoji+
   `.badge` legado) — as duas telas que o operador mais vive.
3. **Terminologia incoerente**: "Monitoramento" (nav) vs "Central de câmeras" (título) vs 404
   apontando "Central" para o Mapa.
4. Dashboard/NotFound com cabeçalho/empty-state bespoke (fora do PageHeader/EmptyState).
5. Estado só-por-ícone sem texto (FadigaView kpibar); mapa sem alternativa textual no mobile;
   seções internas como `<div>` sem heading; **login sem h1**; glyphs `✕◀▶` como botões no Replay;
   canvases sem aria.

**Administrativas (Auditor 3):**
1. **Double-submit desprotegido em UsersPage** (criar usuário/salvar/adicionar sem `busy` —
   clique duplo cria dois usuários). Integridade, não só estética.
2. **Elevar papel a superadmin é 1 clique sem confirmação** (remoção confirma; promoção não —
   assimetria de risco).
3. Tabelas sem `scope="col"` (users/notificações) vs com (relatório); 4 mecanismos de feedback
   diferentes (toast, Alert, span inline, banner bespoke); Heatmap sem teclado (dívida #4);
   ProfilePage sem `aria-live` no estado do form; erro inline de campo usado em SÓ 1 lugar.

## 3. Critérios de aceite — a "Definition of Done POR TELA" (o checklist do enforcement)

Cada tela varrida só fecha quando:
- **Semântica**: 1 `h1` (PageHeader), headings sem salto, landmarks, tabela real com `scope`,
  `button` de verdade, labels ligadas (`Field` pós-G1).
- **Teclado**: operável ponta a ponta sem mouse; foco visível (G3); dialog devolve o foco; ESC
  fecha overlays (trap manual onde canvas — ADR-007, NUNCA Radix Dialog na casca fullscreen).
- **Estados**: loading (`aria-busy`+Skeleton) / erro (`role="alert"`+ação de retry) / vazio
  (EmptyState fórmula status+causa+ação) — os TRÊS, no padrão único (o ReportPage é a referência).
- **Feedback**: UM padrão (toast para sucesso de ação; Alert inline para erro de página; erro de
  campo via Field) — fim dos 4 mecanismos.
- **Tokens**: zero `text-[Npx]`, zero hex/rgba cru, espaçamento por `--sp-*`, estado por
  `--state-*` (going-gray: informação nunca só-por-cor — sempre cor+texto/ícone).
- **Ícones**: Lucide único (glyphs/emoji migrados) — **preservando o nome acessível do e2e ou
  atualizando o spec no MESMO PR** (regra A18: nome é load-bearing).
- **Gates verdes**: verify + Playwright (incl. mobile-390 + axe novo).

## 4. Fases (paralelas SEM colidir com as frentes de produto)

**F0 — Fundação [P, dispara já]:** G1-G9 + gate axe + lint de token. Arquivos: `src/ui/**`,
`index.css`, `tailwind.css`, CSS de página órfãos, `e2e` (axe) — **nenhuma frente de produto os
toca**. G1 (Field acessível) é o de maior alavancagem: 1 arquivo, app inteiro.

**F1 — Varredura A (alto impacto, arquivos LIVRES) [P após F0]:**
FadigaView (trap/ESC/Lucide/badges — o pior) · Login/auth (h1, aria-live) · UsersPage
(double-submit, confirmação de papel, scope, feedback único) · Dashboard+NotFound (PageHeader/
EmptyState/terminologia — decidir UM nome: "Central" OU "Monitoramento") · Heatmap (teclado) ·
ProfilePage (aria-live) · ReportPage (FilterBar extraída, restos).

**F2 — Varredura B (telas novas/em fluxo) [S — espera a frente de produto que as toca pousar]:**
TagsMapPage (lista mobile + tokens) · ReplayPlayerPage (Lucide, canvas aria, tokens) ·
BtTagsPage e TurnosPage (tokens — DEPOIS da multi-antena F2 e turnos F2) · CalibrationPanel
(depois da multi-antena F3).

**F3 — Consoles [S — por último, são os arquivos mais disputados]:** CameraWorkspace + tabs +
ConfigZonaDialog (depois de polígonos/proibida pousarem) — unificação final dos dois consoles.

Cada tela = **um PR pequeno com dono exclusivo** (a mesma regra das outras frentes); a DoD do §3 é
o critério de aceite de cada um.

## 5. Fora de escopo

Redesign visual (a identidade atual fica — o trabalho é CONSISTÊNCIA); tema claro; libs novas de
UI (Radix + Lucide + Tailwind bastam — anti-dependência da casa); refazer o layout da Central
("menos cromo na Central" é decisão registrada, não bug); telas do app Android.

## 6. Riscos

| risco | mitigação |
|---|---|
| Quebrar nome acessível que o e2e usa | regra A18: mudar visual + spec no MESMO PR; grep antes |
| Colidir com frentes de produto | F2/F3 sequenciadas atrás delas; F0/F1 só em arquivos livres |
| Cascata (G5) quebrar estilo em telas não tocadas | migração por arquivo com Playwright completo por PR |
| Enforcement erodir de novo | o lint de token + axe no CI são o freio permanente |
