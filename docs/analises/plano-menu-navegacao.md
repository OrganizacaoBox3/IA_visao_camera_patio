# Plano — Menu/Navegação (AppShell): benchmark, auditoria e melhoria

> **Escopo:** rail lateral / bottom-nav do `AppShell` (shell da SPA). Fora de escopo: rotas,
> páginas, átomos de `src/ui/`, emojis fora do shell.
> **Status:** onda 1 (Lucide) e onda 2 (colapsável + busca + grupos, §6) IMPLEMENTADAS
> (2026-07-02) · `verify` verde · e2e 8/8.

## 1. Benchmark de mercado (o que se aplica aqui)

Produtos analisados: Frigate NVR, Ubiquiti UniFi Protect, Milestone XProtect, Genetec
Security Center, Grafana, Datadog. Padrões consolidados que se aplicam a esta central
(aplicação operacional dark, uso em TV/desktop/mobile):

1. **Rail lateral estreito com poucos destinos (5–8), ícone+label no nível 1.** Padrão
   dominante (UniFi, Datadog, Grafana). A regra do Grafana (Saga design system) é explícita:
   ícone só no 1º nível; ícone puro exige tooltip — o Frigate icon-only gerou reclamação
   documentada da comunidade ("Why no labels? Tooltips?"). → Aqui: mantemos **ícone+label**
   no desktop; no rail compacto (md) e bottom-nav (sm) o label vira tooltip/label pequeno.
2. **Navegação neutra; cor reservada a estado.** Datadog dessatura cores no dark ("saturado
   vibra"); Milestone System Monitor usa tiles cinza→coloridos só na degradação. Item ativo =
   indicador discreto com accent único, nunca cor semântica de alarme. → Coincide 1:1 com o
   going-gray (ADR-003): base neutra, barra fina `--accent` só no ativo.
3. **Mobile = bottom-nav dedicada, não sidebar espremida** (UniFi Protect, Frigate mobile).
   3–5 tabs no polegar, alvo ≥44px. → Já era a arquitetura do shell (F5); mantida e reforçada
   (alvo de toque no md também).
4. **Zonear o rail por frequência: meio = domínios; base = conta/admin** (Datadog; UniFi
   ancora settings no rail). Menu do usuário no extremo com perfil + sair, fora do caminho
   operacional. → Já era o desenho (DropdownMenu no rodapé); mantido.
5. **Iconografia de biblioteca única, stroke consistente, currentColor.** Emojis coloridos
   quebram a disciplina de cor (o glifo 🔔/📊 tem cor própria que o CSS não controla) e têm
   métrica inconsistente entre SOs. → Migrado para **Lucide** (ver §3).
6. **Teclado/paleta como camada paralela** (Grafana `g h`, Datadog `Cmd+K`). → Válido, mas
   é feature nova, não polimento do menu — fica para onda futura (§5).

## 2. Auditoria do menu (antes) — evidências

| # | Achado | Evidência |
|---|--------|-----------|
| A1 | Ícones eram **emoji/unicode** (▦ 📊 🔔 👤 ⚙ ▾ ⎋ ● ▣): cor própria (viola going-gray), baseline e largura variam por fonte/SO, peso visual desigual | `AppShell.tsx` (itens do nav, brand, caret, rodapé — versão anterior a 2026-07-02) |
| A2 | Alinhamento do ícone por `text-align: center` em caixa de texto — sem garantia de coluna alinhada entre glifos de larguras diferentes | `src/index.css:1221-1224` (`.rail-item .ri-ic`) |
| A3 | Estado ativo legado **azul saturado hardcoded** (`#0b3a4a`/`#bae6fd`) no CSS base (já sobreposto pelo appshell.css, mas o override era só de cor; ícone emoji continuava colorido) | `src/index.css:1217-1220` vs `appshell.css` (`.rail-item.on`) |
| A4 | **Sem transição** em hover/ativo (mudança de fundo "seca"); única transição era o caret | `src/index.css:1213-1216`; `appshell.css` (`.ri-caret`) |
| A5 | Rail compacto md (≤900px): item com `padding: var(--sp-2)` + glifo → altura ~34px, **alvo de toque <44px** em tablet | `src/index.css:1700-1710` |
| A6 | Sem altura mínima nos itens no desktop → ritmo vertical dependia da métrica do emoji | `src/index.css:1203-1212` |
| ✓ | Já estava certo: `aria-current` automático (NavLink), skip-link, `<nav>` rotulado, foco no `main` por rota, Tooltip no modo compacto, RBAC por papel, bottom-nav mobile com ≥44px, tokens `--sp-*` nos espaçamentos, foco visível `--ui-focus` | `AppShell.tsx`; `src/index.css:1754-1792`; `appshell.css` |

## 3. O que foi implementado agora (onda 1)

**Dependência nova: `lucide-react`** (única). Justificativa: padrão de mercado de fato para
React (usada por shadcn/ui e afins), tree-shakeable (importa só os 9 ícones usados; impacto
de bundle ~desprezível), stroke em `currentColor` → o ícone obedece automaticamente a cor de
estado do item (going-gray), licença ISC, zero dependências transitivas.

Arquivos: `src/components/AppShell.tsx` + `src/components/appshell.css` (propriedade
exclusiva; `index.css` intocado — overrides via `.rail--app`).

| Onde | Antes | Depois |
|------|-------|--------|
| Central | `▦` | `<LayoutDashboard>` |
| Relatório | `📊` (emoji colorido) | `<BarChart3>` |
| Saúde alarmes | `🔔` (emoji colorido) | `<BellRing>` |
| Usuários | `👤` (emoji colorido) | `<Users>` |
| Meu perfil | `⚙` | `<CircleUser>` (semântica de conta; `Users` fica p/ admin) |
| Brand | `▣` | `<Cctv>` 20px (identidade: central de câmeras) |
| Caret do menu do usuário | `▾` | `<ChevronDown>` 14px (rotação 180° mantida) |
| Menu do usuário: Meu perfil / Sair | `⚙` / `⎋` | `<CircleUser>` / `<LogOut>` 16px |
| Rodapé LGPD | `●` | `<ShieldCheck>` 16px em `--state-ok` (semântica real: processamento local protegido) |
| Tamanho/peso | métrica de fonte, inconsistente | **1 tamanho por contexto** (nav 18px, menu 16px, caret 14px) e **1 strokeWidth (1.75)** via constantes `NAV_ICON`/`MENU_ICON` |
| Alinhamento | `text-align` em span de texto | caixa flex fixa 20px (`.ri-ic`) → coluna de ícones e rótulos alinhados por grid, não por fonte |
| Transição | nenhuma | `background-color/color 0.12s` (padrão da casa) em hover/ativo |
| Ritmo vertical | variável | `min-height: 36px` desktop; **44px no md** (alvo de toque tablet); sm já tinha 44px |
| Estado ativo | barra accent (mantida), mas emoji não tingia | barra accent + ícone stroke tinge `--accent` de verdade (currentColor) |

**Preservado (invariantes):** rótulos de texto visíveis + `aria-label` idênticos → nomes
acessíveis que o e2e usa (`Relatório`, `Usuários`, `Meu perfil`) intactos; RBAC idêntico
(Saúde alarmes só `canConfigure`; Usuários só `superadmin`); Tooltip no modo compacto;
Radix DropdownMenu no usuário; going-gray (nenhuma cor nova; accent só no ativo, state-ok
só no selo LGPD); zero mudança em `src/ui/`, `index.css`, rotas.

## 4. Validação (evidência)

- `npm run verify` → **verde** (ESLint 0 erros, `tsc --noEmit` ok, build Vite ok, **72 unit tests passed**).
- `npx playwright test --trace off` → **8 passed (33.4s)** — inclui "login + navegação das
  telas principais", que percorre os links do rail pelos nomes acessíveis.
- **Honestidade técnica:** os testes garantem contrato/semântica, não estética. O acabamento
  visual (alinhamento óptico dos ícones, peso do stroke no dark, bottom-nav no aparelho real)
  precisa de **smoke visual do usuário** em desktop/tablet/celular antes de considerar pronto.

## 5. Fica para depois (backlog priorizado)

1. **Badge de contagem de alarmes ativos** no item "Saúde alarmes" (padrão Frigate/UniFi;
   átomo `Badge` de `src/ui` já existe) — cor semântica só quando houver anormalidade,
   coerente com going-gray. Exige contrato de contagem via socket (aditivo).
2. **Emojis fora do shell** (onda futura de iconografia, mesmo mapa Lucide): ex. botões
   "⚙ Câmeras", "⚙ Configurar zona", "+ Câmera IP" e afins nas páginas/dialogs — atenção:
   o e2e referencia alguns por nome com o glifo (`'⚙ Câmeras'`), então essa onda ajusta
   página + teste juntos.
3. ~~Atalhos de teclado / paleta `Ctrl+K`~~ → **entregue na onda 2** (§6): busca com
   `Ctrl+K` e `/`; colapso com `Ctrl+B`. Resta o go-to `g`+letra (Grafana) se houver demanda.
4. **Tap na tab ativa = scroll-to-top** no bottom-nav (detalhe UniFi Protect).
5. ~~Rail docked/persistente por usuário~~ → **entregue na onda 2** (§6): colapso persistido
   em `localStorage`.
6. **Deep-link de câmera aberta** (`/?cam=<id>`): hoje o resultado de câmera na busca navega
   p/ a Central e o operador clica no tile; com deep-link a busca abriria a câmera direto
   (trocar só o `to` do `SearchHit` em `AppShell.tsx`).
7. **Busca de câmeras para papéis não-superadmin**: `GET /api/cameras` é superadmin-only;
   um endpoint aditivo só com `{id,label}` (sem `url` sensível) ampliaria a busca aos demais
   papéis sem tocar no contrato existente.

## 6. Onda 2 (2026-07-02) — colapsável + busca + grupos ("padrão de mercado")

### 6.1 Benchmark (medidas adotadas)

| Referência | O que foi extraído | Adotado aqui |
|---|---|---|
| [shadcn/ui Sidebar](https://ui.shadcn.com/docs/components/radix/sidebar) (padrão de fato em React) | `SIDEBAR_WIDTH` 16rem (256px); `SIDEBAR_WIDTH_ICON` 3rem (48px); atalho `⌘/Ctrl+B`; estado persistido (cookie `sidebar_state`, 7 dias); modo `collapsible="icon"` com tooltip no item | Expandida **240px** ↔ rail **60px** (48px de ícone + folga p/ alvo ≥44px); `Ctrl+B`; persistência em `localStorage("shell.nav.collapsed")`; tooltip revela o rótulo no modo só-ícones |
| [Grafana mega menu/dock](https://grafana.com/developers/saga/patterns/navigation/) + [issue #72446](https://github.com/grafana/grafana/issues/72446) | 3 estados (aberto/fechado/docked); PoC reduziu largura de 350px → **~250px**; usuário colapsa quando focado numa tarefa; colapsado por default < 1440px | Confirma 240px; colapso manual persistido (não automático por viewport — nossa TV/desktop operacional prefere previsibilidade) |
| [Linear](https://linear.app/changelog/unpublished-collapsible-sidebar) / Notion / Datadog | Sidebar colapsável com toggle no header; paleta/busca global por `Ctrl/Cmd+K`; "/" foca busca (padrão GitHub/Slack) | Toggle `PanelLeftClose/Open` no header; `Ctrl+K` **e** `/` focam a busca |
| Doutrina Grafana Saga (onda 1) | Ícone puro exige tooltip; micro-headers de seção | Tooltip no rail colapsado; headers "OPERAÇÃO / ADMINISTRAÇÃO / CONTA" uppercase 11px `--text-muted` |

### 6.2 Antes → depois

| Aspecto | Antes (onda 1) | Depois (onda 2) |
|---|---|---|
| Largura | fixa 148px (`--rail-w`) | **240px expandida ↔ 60px rail**, transição 180ms ease (desligada em `prefers-reduced-motion`) via `grid-template-columns` no `.shell--nav` |
| Abrir/fechar | não existia | toggle no header (`PanelLeftClose/Open`, tooltip "Recolher/Expandir menu (Ctrl+B)", `aria-expanded`/`aria-keyshortcuts`) + atalho `Ctrl/Cmd+B`; persistido em `localStorage`; **default expandida** (e2e roda no default) |
| Busca | não existia | campo no topo (ícone `Search`, placeholder "Buscar… (Ctrl+K)") com popover `role="listbox"` (setas + Enter navegam, Esc fecha/limpa); ver §6.3 |
| Agrupamento | lista plana | micro-headers **OPERAÇÃO** (Central, Relatório) / **ADMINISTRAÇÃO** (Saúde alarmes, Usuários) / **CONTA** (Meu perfil); grupo vazio p/ o papel não renderiza nem o header (RBAC intacto); colapsado/md os headers viram separadores `--border-soft` |
| Grid de espaçamento | item 36px, gap `--sp-2` | item **36px** (44px md/sm), **padding lateral 12px**, **gap ícone-rótulo 12px**, ícone em caixa 20px; brand com nome "Visão de Pátio" no header, separado por `--border-soft`; zona da conta segue ancorada na base |
| Nome acessível colapsado | n/a | `aria-label` em todo link (já existia) → `getByRole('link', {name})` do e2e funciona em qualquer estado |
| Mobile (≤640px) | bottom-nav | **inalterada** (grupos usam `display: contents` p/ voltar ao flex row); md (641–900px) segue o compacto automático de 52px do `index.css` — colapso/busca são desktop-only (>900px) |

### 6.3 Busca — escopo e decisões

- **Escopo:** itens do menu (sempre; respeita RBAC porque filtra sobre os grupos já
  filtrados por papel) + **câmeras** via `listCameras()` de `src/api.ts`, carregadas **1×
  no primeiro foco** do campo (lazy). `GET /api/cameras` é superadmin-only → p/ os demais
  papéis o `catch` degrada silenciosamente p/ lista vazia (busca só de menu). Filtro
  acento-insensível (NFD, "camera" acha "Câmera"). Resultado de câmera exibe **só o label**
  (nunca a `url`, que pode conter credenciais — LGPD/segredos) e navega p/ a Central (`/`);
  não há deep-link de câmera hoje (backlog §5.6).
- **Atalhos:** `Ctrl/Cmd+K` e `/` focam a busca de qualquer lugar; `/` é ignorado quando o
  foco já está em input/textarea/select/contenteditable (não rouba digitação). Listeners
  globais só existem no desktop (>900px) e **não tocam Esc/setas** fora do campo — zero
  interferência nos fluxos do e2e (default: busca fechada).
- **Colapsada:** o campo vira **botão-ícone** `Search` que **expande a sidebar e foca a
  busca** (o mais simples dos dois padrões shadcn; sem estado "temporário" a desfazer —
  quem quiser recolher usa `Ctrl+B`/toggle).
- **A11y:** input `role="combobox"` + `aria-expanded`/`aria-controls`/`aria-activedescendant`;
  lista `role="listbox"`/`option` com `aria-selected`; `mousedown` no popover não rouba o
  foco do input.

### 6.4 Decisões de colapso

1. **Estado no `.shell` (classe `nav-min`) + `grid-template-columns`** — anima o layout
   inteiro (rail e conteúdo juntos), sem tocar `index.css` (overrides por especificidade
   `.shell.shell--nav`, escopados a `min-width: 901px` p/ não brigar com os breakpoints
   md/sm existentes).
2. **`localStorage` em vez de cookie** (shadcn usa cookie por causa de SSR; SPA pura não
   precisa) — chave `shell.nav.collapsed`, `try/catch` p/ ambientes sem storage.
3. **Colapso é desktop-only**: md (641–900px) já tem o compacto automático do `index.css`
   e sm tem bottom-nav — regras preservadas (o TSX nem renderiza toggle/busca fora do
   desktop).
4. **Rótulo some via `display:none` no fim da transição de largura** (mesmo comportamento
   do shadcn); `white-space: nowrap` + ellipsis evita quebra durante a animação.

### 6.5 Validação (evidência)

- `npm run verify` → **verde** (ESLint 0 erros, `tsc --noEmit` ok, build Vite ok, **72 unit
  tests passed**).
- `npx playwright test --trace off` → **8 passed (55.9s)** — inclui "login + navegação das
  telas principais" (percorre os links por nome acessível) e os fluxos com Esc/setas/inputs
  (nenhuma colisão com os atalhos globais novos).
- **Honestidade técnica:** os testes garantem contrato/semântica, não estética. Transição
  de largura, alinhamento óptico no rail de 60px, popover da busca e comportamento do
  atalho em teclados ABNT precisam de **smoke visual do usuário** (desktop + resize p/
  tablet/mobile) antes de considerar pronto.
