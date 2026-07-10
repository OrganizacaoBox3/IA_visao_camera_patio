# 02 — Doutrina visual da casa (o que a simplificação NÃO pode violar)

> Consolidação de leitura interna para a revisão de UI (jul/2026). Fontes: `../agentes/exploracao/PADRAO_FRONTEND.md`,
> ADR-003/007/008 (`docs/analises/decisoes/`), `docs/analises/benchmark-interfaces/*`, `docs/analises/plano-padronizacao-visual.md`,
> `docs/analises/auditoria-padroes-ui.md`, `docs/analises/implementacao-changelog.md`, `src/index.css`, `src/tailwind.css`,
> `src/ui/*`, `src/components/AppShell.tsx`, `docs/arquitetura/04-frontend-ui-telas.md`, `e2e/app.spec.ts`, `e2e/mobile.spec.ts`.
> Regra-mãe (CLAUDE.md): **o básico bem feito; em conflito entre guia e código, o guia decide.**

---

## (a) Regras visuais vigentes — com fonte

| # | Regra | Enunciado operacional | Fonte |
|---|-------|----------------------|-------|
| 1 | **"Going gray" — cor é informação, não decoração** | Base neutra/cinza por padrão; **cor saturada SÓ para anormalidade que exige ação**. Mapa fixo estado→token: ATIVA→`--state-neutral` · LENTA/OCIOSA→`--state-warn` · VAZIA→`--state-neutral-dim` · ALERTA→`--state-critical` · advisory→`--state-info` · OK (verde) só p/ **confirmação pontual, com parcimônia**. Mesma cor = mesmo significado em TODAS as telas. | ADR-003; `src/index.css:88-154` (bloco de contrato); `benchmark-interfaces/00`:§north-star; CLAUDE.md §3 |
| 2 | **Tokens `--state-*` são a fonte única de cor de estado** | Cada estado tem 3 papéis: `-fg` (texto/ícone, contraste AA sobre `--panel`), `-bg` (tint escuro), `-border`. Hex proibido fora do bloco de tokens do `index.css`; os legados `--ok/--idle/--empty/--alert` são só **aliases** (a aposentar). | `src/index.css:35-44,113-141`; `plano-padronizacao-visual.md` §Cor; `auditoria-padroes-ui.md` dívida #7 |
| 3 | **"A imagem é soberana" (superfície de câmera)** | Palco de vídeo em dark profundo (`--cam-surface-bg #05080c`); **sobre o vídeo só geometria** + chips legíveis via `--cam-overlay-scrim`; **números vão para o painel lateral** (`--cam-panel-*`). UI nas bordas, nunca cobrindo o centro. | ADR-003; `src/index.css:143-154`; `benchmark-interfaces/03` §3.1/3.6 |
| 4 | **Radix é a camada de UI — sempre via wrappers de `src/ui/`** | Todo controle interativo pergunta "o Radix já resolve?"; se sim, usa o átomo da casa. Nada de UI kit pesado, nada de reimplementar dropdown/dialog/select/tooltip à mão. `title=` de UI → `<Tooltip>` (exceção documentada: célula de dado). | ADR-007; `PADRAO_FRONTEND.md` §Convenções/Não-fazer; CLAUDE.md §3 |
| 5 | **Tipografia: 7 papéis, `text-[Npx]` PROIBIDO em página** | `micro 10` (legenda técnica, mono se numérico) · `label 11` (título de seção **uppercase**, metadado) · `sec 12` · `body 13` (base) · `title 14` (título de página/dialog) · `hero 18` · `kpi 24` (**único** tamanho de KPI). | `plano-padronizacao-visual.md` §Padrão; `src/index.css:25-34`; `src/tailwind.css:34-43` |
| 6 | **Espaçamento por escala** | `--sp-1..5` (4/8/12/16/24). Page-padding = section-gap = card-padding = `--sp-4` (16); denso interno `--sp-2`. Px cru proibido em CSS de rota (6/10px tolerados só em `src/ui`). Raios: `--radius-sm 6` / `--radius 10`. | `plano-padronizacao-visual.md`; `src/index.css:47-54` |
| 7 | **Headings semânticos** | 1 `<h1>`/página SEMPRE via `PageHeader` (title 14/600 + subtítulo 12 muted); título de seção = `<h2>` via `SectionTitle` (label 11 uppercase, tracking 0.12em, `--text-muted`). | `plano-padronizacao-visual.md` §Headings; `src/ui/PageHeader.tsx`, `src/ui/SectionTitle.tsx` |
| 8 | **Layout SaaS: tela inteira útil, sem scroll de body** | Lista cresce com a viewport (`flex:1 + min-height:0 + ScrollArea`); **nunca** `max-h-[Npx]` em conteúdo (só popover). Conteúdo largo (tabela/heatmap) rola DENTRO do próprio container — **zero scroll horizontal da página** (gate e2e mobile). Texto longo limita a LINHA (~70ch), não a página. | `plano-padronizacao-visual.md` §Layout; `e2e/mobile.spec.ts` |
| 9 | **Breakpoints canônicos + toque** | Desktop-first: `sm ≤640` (bottom-nav, 1 col, alvos ≥44px, safe-area) · `md ≤900` (rail vira ícones, 2 col) · `lg ≤1200`. Painel que reage à própria largura usa container query. `100dvh`, `viewport-fit=cover`. | `src/index.css:64-86`; ADR-007 §Responsividade |
| 10 | **Tailwind v4 incremental, sem preflight; tokens no `@theme`** | Utilities referenciam as MESMAS variáveis do going-gray (`bg-panel`, `text-critical`, `text-label`…). Achado sistêmico: CSS de página é *unlayered* e **vence** utilities → regra da casa: *utility nunca compete com classe de página na mesma propriedade*. | ADR-008; `src/tailwind.css`; `auditoria-padroes-ui.md` §2 |
| 11 | **Iconografia Lucide, 1 tamanho, 1 stroke** | Padrão do shell: `size 18 / strokeWidth 1.75 / currentColor` (menu 16). Cor do ícone vem do estado do item (obedece going-gray). Ícone-só SEMPRE com Tooltip revelando o rótulo + `aria-label` estável. | `src/components/AppShell.tsx:31-34,451-458`; `src/ui/Button.tsx` (IconButton força `aria-label`+`title`) |
| 12 | **"Nunca número cru"** | Métrica = valor + tendência (sparkline) + faixa-alvo com realce fora da banda. | `benchmark-interfaces/00` §north-star; changelog Onda C item 10 (`src/components/Sparkline.tsx`, `telemetry.css`) |
| 13 | **Accent sólido só para a ação primária ÚNICA da tela** | Precedente: botão "Entrar" do login (`--accent` sólido + `--accent-contrast`). Ação primária comum = tint `--accent-bg` (Button variant primary). | `src/index.css:1528-1542` (comentário de decisão) |
| 14 | **Alarme bom é alarme acionável** | Dedup, supressão de inundação, 3 prioridades (crítico ≤5%), shelving com expiração, ack. Se não exige ação, não é alarme (vira log/relatório). | ADR-004; `benchmark-interfaces/04` §3.2 |
| 15 | **A11y é contrato** | Foco visível em anel accent em tudo; skip-link; foco movido ao trocar rota; nome acessível estável (o e2e seleciona por `getByRole(name)`); alvos ≥44px no mobile. | `src/ui/*`; `AppShell.tsx:38-40`; `auditoria-padroes-ui.md` §1 |

> Nota de contexto: o `PADRAO_FRONTEND.md` do workspace (app Laudo de Baixas) pede paleta `slate` clara e TanStack Query/RHF+Zod;
> **este MVP tem tokens dark próprios e socket/estado próprio — o que vale aqui é o espírito** (Radix sempre, token semântico,
> Atomic `ui/`×domínio, minimalismo, DRY via `cx()`), não a paleta daquele projeto.

---

## (b) Inventário de átomos de `src/ui/` (reusar antes de criar QUALQUER coisa)

Barrel: `src/ui/index.ts` ("importe daqui"). Tudo Radix + Tailwind/tokens, `forwardRef` + `asChild` onde faz sentido.

| Átomo | API/variantes relevantes | Uso canônico |
|---|---|---|
| `Button` | `variant: default·primary·danger·ghost` · `size: sm·md(34px)` · `active` (outline accent) · `block` · `asChild` | Toda ação. Danger = destrutivo; ghost = terciário |
| `IconButton` | 34×34, **força `label`** (`aria-label`+`title`); `active`, `asChild` | Botão só-ícone — já resolve "ícone com significado" |
| `Input`, `Textarea`, `Field`, `FieldLabel` | `Field` = rótulo+controle+dica/erro com associação acessível | Formulários |
| `Select` | API por array `options`; Portal+Popper (z-index blindado; coberto por e2e) | Todo dropdown de valor |
| `Switch`, `Checkbox`, `CheckboxRow`, `Slider` | — | Toggles/valores |
| `ToggleRow` | linha "rótulo (+hint) · Switch" com divisor | Listas de preferências/camadas |
| `Toggle`, `ToggleGroup`, `ToggleGroupItem` | `aria-pressed` | Chips liga/desliga (classes, detectores) |
| `SegmentedControl<T>` | ToggleGroup single, 30px, tint accent no ativo | **Reservado a filtro/modo SEM painel** (ADR-007) |
| `Tabs`, `TabsContent` | ARIA tab/tabpanel; só painel ativo no DOM | **Abas que trocam painel** (Relatório, drawers) |
| `ScrollArea` | — | Toda região rolável |
| `DropdownMenu` | items: `label`/`separator`/`danger`/ícone | Menus (ex.: menu do usuário no rail) |
| `Dialog` | controlado, `trigger`/`footer`, Fechar embutido; marcador `.ui-dialog`/`.ui-overlay` (e2e!) | Modais de config |
| `AlertDialog`, `ConfirmProvider`, `useConfirm` | variante destrutiva; `w-[min(440px,92vw)]` | Confirmação destrutiva (fim do `window.confirm`) |
| `Tooltip`, `TooltipProvider` | provider na raiz, delay 300 | Substituto de `title=`; revela rótulo de ícone-só |
| `Toast` (`useToast`) | tons `default·alert·ok`, 5s | Feedback de ação |
| `Badge` | `tone: ok·warn·alert·info·default` (pill 11px) | Estado curto — em vez de frase |
| `Alert` | `tone: info·ok·warn·alert`; `role=alert/status` | Mensagem inline |
| `Spinner`, `Skeleton`, `SkeletonText` | — | Loading |
| `EmptyState` | — | Vazios |
| `SectionTitle` | `<h2>` label 11 uppercase; `flush` | Título de seção (funde os antigos `.panel h3`/`.side h3`) |
| `PageHeader` | `<h1>` 14/600 + subtítulo + ações à direita | Cabeçalho de toda página |
| util | `cx()` (compose), `clipboard.ts` (copiar c/ fallback) | — |

**Fora do barrel mas "da casa":** KPI = `Kpi`/`KpiRow` de `src/routes/report/KpiRow.tsx` (nota no barrel: o antigo KpiCard era duplicata);
sparkline = `src/components/Sparkline.tsx`. **Não criar um segundo KPI/sparkline.**

---

## (c) O que os benchmarks já recomendaram — aplicado × NÃO aplicado

### Já aplicado (não "re-simplificar" por engano — é conquista, está no changelog)
Going-gray/tokens · dedup+supressão de inundação + 3 prioridades (`alarmPolicy.js`) · slider de sensibilidade **com estimativa de alertas/dia** · slider global de confiança + toggles de camadas · palco dark + números no painel · cine-loop (freeze+scrubber+export clipe local) · fila de alarmes com ack/forward + drawer · relatório↔eventos bidirecional (aba Alarmes) · modo-como-preset (`MODE_PRESETS`) · RBAC Setup×Live (papel engenheiro/`canConfigure`; operador só-leitura) · shelving/métricas EEMUA + tela `/alarmes-saude` · tripwires com direção + heatmap de ocupação · telemetria com sparkline+faixa-alvo · migração Radix (Onda G) · sidebar colapsável com busca Ctrl+K, Lucide, menu do usuário.

### Implementado e depois REMOVIDO de propósito (decisão de simplificação vigente — não reintroduzir sem pedido)
**Views salvas por setor + auto-surface das câmeras ativas** — commit `e0d6963` (jul/2026): "Central simplificada, sem views/auto-destaque/limite-curto/demo" (`implementacao-changelog.md`, Onda B2/C). A direção do produto já é **menos cromo na Central**.

### Recomendado e NÃO aplicado (backlog legítimo; a revisão de UI pode puxar os baratos)
| Recomendação | Fonte | Nota |
|---|---|---|
| Overlay: **cor por classe + ícone pareado**, label-pill translúcida `classe·ID·conf`, corner-box em cena densa | `05` §A | Alto impacto/baixo esforço — casa com "ícones com significado" |
| **Legenda clicável como filtro de classe** | `05` §A.1 | Legenda existe (`legend` no Workspace); clique-filtro não |
| **Foco+contexto**: mural visível com câmera aberta (mini-grid/hotspot tile) | `01` P1; `02` §3.1 | Hoje `.cam-overlay` cobre a grade |
| **Planta do CD com câmeras / Smart Presence** | `02` §3.1 | Grande; fora de uma passada de simplificação |
| Rotação de páginas com título+dwell | `02` (Verkada) | Só há paginação simples |
| Histograma de confiança; fila "baixa confiança p/ revisão" | `05` §C | — |
| Agenda de notificação; regras compostas; escalonamento por tempo | `02` §3.4; `04` §3.2.7 | Backend |
| Teach por baseline; validação de faixa entre thresholds; ajuste por arraste na imagem | `04` §3.3; `03` §3.3 | — |
| Handover de turno | `01` P12 | — |
| Alerta auto-contido **com snapshot** | `02`/Ambient | **Conflita com ADR-002 (LGPD)** — cards são "sem thumbnail" por design; não é dívida, é invariante |
| Busca forense NL / appearance search | `02` §3.5 | Fora do MVP |

### Dívidas visuais registradas e ainda abertas (as que a queixa do usuário provavelmente enxerga)
- **`title=`→Tooltip em massa no `CameraWorkspace`** — adiado explicitamente para o retrofit R2 (`plano-padronizacao-visual.md` §Fora desta onda); ~30 ocorrências de `title=`/Tooltip misturadas hoje.
- **Glifos de emoji como ícones** nas telas antigas (⚙ 🖌 🧽 ⏸ ✎ ↻ ⬇ ⎙ 🎲 ▣) convivendo com Lucide no shell — inconsistência de gerações; o padrão vigente é Lucide (regra 11).
- CSS legado `.dot-status`/`.badge.*` e aliases `--ok/--idle/--alert` (ADR-003 "consequências"; dívida #7 da auditoria).
- Heatmap com células `<span onClick>` sem teclado (dívida #4); `AlarmesPanel` duplica tendência clicável (dívida #5); seletores órfãos `.ui-dialog-body`/`.cine-bar .ui-toggle` (#2/#3).
- R2 do retrofit pendente: **quebrar `CameraWorkspace.tsx` (~630+ linhas) e unificar duplicações** (CLAUDE.md §6).
- Fusão `users/CamerasTab` × `/cameras` (dívida anotada no plano de padronização).
- ~18 warnings de lint (CLAUDE.md §6).

---

## (d) Invariantes que a simplificação NÃO pode tocar

1. **Casca fullscreen da câmera NÃO vira Radix Dialog** (`CameraWorkspace`/`FadigaView`: `<div role="dialog">`+`<canvas>`+rAF). Portal/scroll-lock remontaria o canvas e mataria o rAF e o editor de zonas/tripwires. Trap de foco manual permanece (e cede ao Radix quando o Dialog de config abre). — ADR-007 §Exceção; CLAUDE.md §3.
2. **Contratos socket aditivos**: `frame`, `cameras`, `set-capture`/`capture`, `alert`, `camera-status`, `alarm-event`/`alarm-update`, `camcfg-updated`, `analysis-status`, `analysis-tracks`. UI nova não renomeia/remove eventos. — CLAUDE.md §3.
3. **LGPD**: nenhuma imagem persistida; cards de alarme SEM thumbnail; cine-loop efêmero em memória; relatório só agregados. Qualquer "melhoria" de UI que peça snapshot no card viola ADR-002.
4. **Radix-only + tokens**: nenhum controle novo fora de `src/ui/`; nenhuma cor nova fora da paleta de estados (decisão registrada: até o laranja `#fb923c` foi banido e mapeado p/ `--state-warn` — `index.css:1139-1149`).
5. **RBAC na UI**: Usuários só superadmin; Saúde de alarmes/edição de zonas/tripwires só `canConfigure`; operador em só-leitura. Simplificar ≠ expor config na tela do operador (Setup ≠ operação).
6. **Sidebar default EXPANDIDA** (o e2e roda no default; chave `shell.nav.collapsed`); atalhos Ctrl+B/Ctrl+K//" e `aria-label` de todo link do rail (o e2e navega por `getByRole('link', { name })`).

### Textos/seletores **load-bearing** do e2e (mudar o texto visível ⇒ manter o nome acessível OU atualizar o spec no MESMO PR)

De `e2e/app.spec.ts`:

- **IDs/classes:** `#login-user`, `#login-pass`, `.cam-stage`, `.tile[title='Abrir câmera']`, `.cam`, `.ui-overlay`, `.ui-dialog` (marcadores sem regra CSS própria — preservar no `className`).
- **Login:** botão **"Entrar"**.
- **Headings (h1/h2):** /Central de câmeras/i · /Relatório Operacional/i · **"Câmeras"** (exact; convive com o h2 "Câmeras IP / RTSP").
- **Links do rail:** "Central" · "Câmeras" · /Relatório/i · /Usuários/i · /Meu perfil/i.
- **Central:** link **"+ Câmera"** no header; **asserções negativas**: NÃO pode voltar a existir botão "+ Câmera IP" nem link "+ Nó de câmera" no header.
- **Workspace:** empty-state contendo **"Use “✎ Zona” para desenhar"** · botão **"✎ Zona"** · botão **"Configurar zona"** · Select **"Modo da zona"** com options **"Leitura"** e **"Exclusão"**.
- **/cameras:** Select **"Tipo da câmera"** + option /Operador \(fadiga\)/i · botão **"+ Adicionar câmera IP"** · Select **"Transporte RTSP"** · campo **"URL da câmera"** · botão **"Adicionar câmera"** · erro /URL inválida/i · texto **"Nenhuma câmera IP cadastrada ainda."** · link **"Abrir nó neste dispositivo"**.
- **Relatório:** botão de modo **"Atividade"** (SegmentedControl) · `tablist` com `aria-label` **"Seção"** e **5 tabs**: **"Quando para"**, **"Onde para"**, **"Tendência"**, **"Fluxo de pessoas"** (+ Eventos) · conteúdos de painel: "horários críticos", "Por área", "Tendência (14 dias)".
- **Usuários:** placeholder **"Usuário"** · botões **"Criar"**, **"Remover"**, **"Cancelar"** · alertdialog contendo **"Remover usuário?"**.

De `e2e/mobile.spec.ts` (gate 390px): headings por rota (/Central de câmeras/i, /Câmeras/i, /Relatório/i, /Usuários/i, /perfil/i) e **zero scroll horizontal da página** em `/`, `/cameras`, `/relatorio`, `/usuarios`, `/perfil`, `/alarmes-saude`.

> Regra prática: **ícone no lugar de texto é permitido**, desde que o nome acessível (`aria-label`) continue sendo a string acima —
> `getByRole("button", { name: "Entrar" })` casa com `<button aria-label="Entrar"><LogIn/></button>`. Exceções que casam por
> **texto visível** (`getByText`): "Use “✎ Zona” para desenhar", "Nenhuma câmera IP cadastrada ainda.", "Remover usuário?",
> os conteúdos de tabpanel do Relatório — esses exigem atualizar o spec junto.

---

## (e) Onde a doutrina PERMITE (e até pede) ir mais fundo

1. **Texto → ícone + Tooltip é 100% compatível — já é a direção da casa.** Evidências: ADR-007 manda `title=`→`<Tooltip>`; `IconButton` força `aria-label`; o rail colapsado revela rótulos por Tooltip; a pill de privacidade do topbar já virou `ShieldCheck` + tooltip ("Processamento local · sem identificação individual") no rail. Condições: par **cor+ícone+texto acessível** (benchmark 05 §A.1 — nunca cor sozinha), tooltip com o rótulo, e nome acessível preservado (seção d).
2. **Aposentar os emoji-glyphs por Lucide** (⚙→Settings, 🖌→Brush, ✕→X, ⏸→Pause, ↻→RefreshCw, ⬇→Download, ⎙→Printer, 🎲→Dices…): coberto pela regra 11 (1 tamanho, 1 stroke, currentColor). Atenção: **"✎ Zona"** é nome acessível no e2e — trocar o glifo exige atualizar o spec no mesmo PR.
3. **Menos texto por padrão semântico, não por corte cego:** estado curto = `Badge` com tom (não frase); explicação = `hint` do `Field`/`ToggleRow` ou Tooltip (não parágrafo); título de seção = `SectionTitle` 11px uppercase (não sentença); vazio = `EmptyState` de 1 linha + 1 ação. O plano de padronização já manda limitar microcopy críptica e texto longo a ~70ch.
4. **Sensibilidade em níveis nomeados** ("Baixa/Moderada/Alta") no lugar de números crus — recomendação Verkada (`02` §2.5) ainda não aplicada; reduz texto E paralisia de decisão, mantendo o Slider para engenheiro.
5. **Consolidar gerações antigas de CSS**: migrar `.dot-status`/`.badge.*`/aliases `--ok/--idle/--alert` para `--state-*` (dívida declarada em ADR-003/auditoria) — é limpeza, não mudança de identidade.
6. **Reduzir cromo da Central é coerente com o rumo** (o produto JÁ removeu views/auto-surface/demo em `e0d6963`). Overview glanceable: tile = vídeo + dot de estado + nome + badge de alerta; detalhe sob demanda (hierarquia N1→N2→N3 do benchmark NASA).
7. **Modos/abas**: `Tabs` quando troca painel, `SegmentedControl` para filtro sem painel (ADR-007) — unificar onde ainda houver abas bespoke.
8. **Limites do "ir fundo"** (o que a doutrina NÃO cobre): tema claro (registrado como fora de onda), novo UI kit/biblioteca de ícones além de Lucide, cor nova de estado, snapshot em alerta (LGPD), mexer na casca fullscreen, e qualquer quebra dos contratos socket ou dos nomes acessíveis do e2e sem atualizar teste no mesmo PR ("sem evidência, não há pronto").
