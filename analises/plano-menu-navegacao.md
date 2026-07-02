# Plano — Menu/Navegação (AppShell): benchmark, auditoria e melhoria

> **Escopo:** rail lateral / bottom-nav do `AppShell` (shell da SPA). Fora de escopo: rotas,
> páginas, átomos de `src/ui/`, emojis fora do shell.
> **Status:** onda 1 IMPLEMENTADA (2026-07-02) · `verify` verde · e2e 8/8.

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
3. **Atalhos de teclado go-to** (`g` + letra, estilo Grafana) e/ou paleta `Ctrl+K` — camada
   paralela de navegação p/ operação sem mouse/TV.
4. **Tap na tab ativa = scroll-to-top** no bottom-nav (detalhe UniFi Protect).
5. **Rail docked/overlay persistente por usuário** (Grafana) — só se surgir demanda real de
   mais área de vídeo em TV; hoje o rail de 148px é barato. (YAGNI por enquanto.)
