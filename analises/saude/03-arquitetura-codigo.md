# Auditoria de Saúde — 03 · Arquitetura, Contratos e Qualidade de Código

> **Dimensão:** Arquitetura, Contratos e Qualidade de Código + "como chegou até aqui".
> **Lente:** `CLAUDE.md` §2 (princípios), §3 (invariantes/contratos), §4 (padrão da casa), §5 (anti-overengineering) ·
> `../agentes/exploracao/PRATICAS_ENGENHARIA.md` e `ANALISE_MERCADO_DEV.md` (régua do Akita: arquivos **<500 linhas**, baixa duplicação, verificação automatizada como gargalo) · contexto: `docs-regenerada/`.
> **Convenções:** `(E)` = evidência direta (li o código) · `(I)` = inferência · `⚠️` = risco/dívida.
> **Escopo:** auditoria de leitura. **Nenhum código foi alterado.** Data: 2026-06-28.

---

## 1. Scorecard

| Eixo | Nota | Veredito de uma linha |
|------|:----:|-----------------------|
| Tamanho/complexidade dos arquivos | 🔴 | 4 arquivos passam de 500 linhas; `CameraWorkspace.tsx` está em **1366** (2,7× a régua). |
| Organização por domínio vs tipo | 🟡 | Núcleo (`vision/`, `camera/`, `report/`, `fadiga/`…) é por domínio; rotas/UI/`index.css` ainda por tipo. |
| Contratos socket/endpoints | 🟢 | Eventos e rotas estáveis, aditivos e documentados (CLAUDE §3 × `api.ts` × `docs-regenerada` batem). |
| Duplicação / DRY | 🟡 | Dups reais e contidas: tipo `AlarmEvent` ×2, 2 mecanismos de grid, tokens CSS legados. |
| Código morto / valores mágicos | 🟡 | `--dash-cols` morto, migração legada de tripwires, thresholds "A CONFIRMAR" hardcoded. |
| Acoplamento / gargalos | 🟡 | Scheduler limpo (🟢); `CameraWorkspace` concentra holders/refs/lifecycle (🔴 local). |
| Verificação (lint/CI/unit) | 🔴 | Sem ESLint/Prettier/CI; lógica pura crítica sem teste unitário (lacuna "Onda 0"). |
| Persistência (JSON × PG) | 🟢 | Fallback espelhado por design (ADR-005); custo é caminho duplo a manter. |

**Veredito global: 🟡 (sólido com dívida estrutural concentrada).** A arquitetura é coerente com o "padrão da casa" e os contratos são exemplares. A dívida está **concentrada em poucos hotspots** (sobretudo `CameraWorkspace.tsx`) e na **ausência de verificação automatizada** — exatamente o ponto que a régua do Akita / pesquisa de mercado aponta como o de maior risco e maior alavancagem.

---

## 2. Mapa de hotspots

### 2.1 Tamanho — quem passa da régua Akita (<500 linhas)

| Arquivo | Linhas | Risco | Ação |
|---------|:-----:|-------|------|
| `src/CameraWorkspace.tsx` | **1366** ⚠️ | **Crítico** — gargalo estrutural conhecido; tocado por quase toda onda A–G | Quebrar em hooks + módulos (ver §6 P0) |
| `src/routes/ReportPage.tsx` | **792** ⚠️ | Alto — view + composição de gráficos numa página só | Extrair seções (KPIs/heatmap/lista) em componentes |
| `src/routes/DashboardPage.tsx` | **709** ⚠️ | Alto — orquestra socket, views, mosaico, fila de alarmes | Extrair `useDashboardSocket`/`useViews` |
| `server/alarmPolicy.js` | **594** ⚠️ | Alto — política ISA-18.2 (rate/shelve/dedup) num módulo só | Separar métricas × shelving × dedup |
| `src/index.css` | **720** ⚠️ | Médio — folha global monolítica (por tipo, não domínio) | Fatiar por domínio + matar legado |
| `src/report/mock.ts` | 469 | Médio (perto do teto) — dados mock + **funções puras** de agregação juntos | Separar mock de lógica pura (testável) |
| `server/index.js` | 377 | Médio — roteador HTTP manual de ~220 linhas inline (linhas 53–277) | Tabela de rotas / split por recurso |
| `src/vision/counting.ts` | 396 | Médio — lógica pura **sem teste** (CLAUDE §6) | Cobrir com unit antes de mexer |

`(E)` Contagens via `wc -l`. Régua "<500" vem de `ANALISE_MERCADO_DEV.md` §5 (checklist do Akita como régua externa).

### 2.2 `CameraWorkspace.tsx` — anatomia do gargalo `(E)`

Um único componente acumula **28 `useState` + 49 `useRef` + 23 `useEffect`** e ~40 funções internas, misturando responsabilidades que deveriam ser unidades separadas (viola CLAUDE §2.2 "uma responsabilidade por unidade"):

- Editor de **zonas** (`onDown/onMove/onUp/paintAt/commitPaint`, ~linhas 950–995).
- Editor de **tripwires** (`commitTripwire/persistTw/invertTripwire/resetCounts`, ~996–1029).
- **Cine-loop / congelar / review** (`enterReview/exitReview/scrubBy/drawReviewFrame`, ~269–862).
- **Telemetria** "nunca número cru" (`stateToMetric/riskToMetric/...`, ~137–167).
- **Desenho no canvas** (`drawScene` ~635–798, `drawFadigaZone` ~183).
- **Máscara/blueprint** (`getMask/ensureMaskForPaint`, ~932–948).
- **Snapshot / export de clipe** (`downloadSnapshot` ~866).
- **Holders** por zona (instâncias de processador) geridos por ref e ciclo de vida do componente (`holderFor` ~424, `removeZone` ~1039).
- Render do **tile** e do **full workspace** (~1070–1366).

⚠️ Como cada onda paralelizou **por propriedade de arquivo** (ADR-001), e quase toda feature toca a câmera, este arquivo virou o ponto de convergência — daí o inchaço. É o caso mais claro de dívida acumulada pelo processo de ondas.

---

## 3. Organização por domínio vs tipo `(E)/(I)`

- **A favor (🟢):** o núcleo segue domínio — `src/vision/`, `src/camera/`, `src/report/`, `src/fadiga/`, `src/objects/`, `src/reading/`, `src/processors/`. CSS de feature mora junto (`routes/alarms.css`, `report/alarms.css`, `camera/cine.css`). Coerente com CLAUDE §2.3.
- **Contra (🟡):** `src/routes/` é organização **por tipo** (todas as páginas juntas); `CameraWorkspace.tsx` e `FadigaView.tsx` ficam soltos na **raiz de `src/`** (sem pasta de domínio `camera/`/`fadiga/` correspondente, embora essas pastas existam para a lógica). `src/index.css` (720 linhas) é o catch-all global por tipo, contendo estilos de dashboard, KPIs, perfil, login, zonas, fadiga, leitura, objetos — tudo num arquivo `(E)`.

---

## 4. Contratos — estáveis e documentados (🟢) `(E)`

- **Eventos socket** emitidos no servidor batem 1:1 com os invariantes de CLAUDE §3 e com `analises/contrato-eventos-alarme.md` / `contrato-multicamera.md`:
  `frame`, `cameras`, `set-capture`/`capture`, `alert`, `camera-status`, `alarm-event`/`alarm-update`, `camcfg-updated` (server/index.js:308–356, rtsp.js:98–141). São **aditivos** (CLAUDE §3) — nenhum quebra detectado.
- **Endpoints HTTP** em `server/index.js` casam com o cliente `src/api.ts` (alarms, ack/forward, metrics, shelves, me, users, views, tripwires). Tipos do cliente espelham o backend à mão (padrão da casa: sem codegen — `PRATICAS_ENGENHARIA.md`).
- ⚠️ **Fragilidade do roteador:** `server/index.js` é um `if`-chain manual de ~220 linhas dentro do callback de `createServer` (53–277), **dependente de ordem** — o próprio código avisa que `/api/alarms/metrics` e `/shelves` precisam vir **antes** das rotas `:id` (comentário linha 117). Funciona, mas é o tipo de acoplamento implícito que regride em silêncio sob edição paralela.

---

## 5. Duplicação, código morto e valores mágicos `(E)`

### 5.1 Duplicações reais
1. ⚠️ **Tipo `AlarmEvent` (+ `AlarmPriority`, `AlarmState`) definido duas vezes:**
   - `src/api.ts:107–123` (contrato canônico; consumido por `DashboardPage.tsx:12` e `AlarmHealthPage.tsx` via `../api`).
   - `src/report/mock.ts:368–384` (cópia independente; consumida por `report/csv.ts:5` e `report/store.ts:12` via `./mock`).
   - As frentes "alarmes ao vivo" e "relatório" foram desenvolvidas em paralelo e cada uma criou seu próprio tipo. **Risco de drift** entre duas definições do mesmo contrato. (Viola CLAUDE §3.4 "contratos estáveis entre camadas".)
2. ⚠️ **Dois mecanismos de grid no Dashboard:**
   - **Vivo:** atributo `data-cols` — `DashboardPage.tsx:581` (`data-cols={colsFor(...)}`) + seletores `views.css:14–17`.
   - **Legado/morto:** variável CSS `--dash-cols` — `index.css:262` (`repeat(var(--dash-cols,3), …)`). O próprio comentário em `index.css:257–260` diz que a "Fase 1" removeu o `gridTemplateColumns` inline, mas a regra `--dash-cols` ficou. Caminho duplo, um deles não exercitado.
3. ⚠️ **Tokens CSS legados convivem com os canônicos:** `--ok/--idle/--alert` (`index.css:11–14`) coexistem com `--state-ok/--state-warn/--state-critical` (`index.css:80–102`, que são aliases dos primeiros). Há **~40 usos** ainda apontando para os legados (`var(--ok)`, `var(--alert)`…) em vez dos tokens `--state-*`. Contraria a invariante "going gray"/tokens (CLAUDE §3, ADR-003) e mantém duas fontes de verdade de cor.

### 5.2 Código morto / legado
- Regra `--dash-cols` (acima) — efetivamente morta. `(E)`
- Migração legada de tripwires de `localStorage`: `loadLegacyTripwires`/`clearLegacyTripwires` (`CameraWorkspace.tsx:47–62`) — ponte de transição que pode ser aposentada após a Onda E (persistência no backend). `(E)`

### 5.3 Valores mágicos / "A confirmar"
- `OCC_HI = 8`, `NOREAD_CRIT = 3`, `EAR_HI = 0.45`, `HIST_LEN = 32`, `HEAT_COLS/ROWS = 32/18` hardcoded em `CameraWorkspace.tsx:37,154–157`. ⚠️ `OCC_HI` está **explicitamente marcado "A CONFIRMAR"** (linhas 146, 155) — heurística sem ocupação-alvo por zona. São thresholds de **negócio embutidos no componente de UI** (deveriam ser config/`config.ts`).
- **Nota de honestidade técnica:** a auditoria buscou o "TODO do `clipExport`" citado no briefing e **não o encontrou** — `src/camera/clipExport.ts` está completo (webm + fallback montage + download). Não há `TODO/FIXME/HACK` reais no código-fonte `src/` (os matches de "TODO" são a palavra portuguesa "todo/todos" em comentários). `(E)`

---

## 6. Acoplamento e gargalos `(E)/(I)`

- 🟢 **Scheduler de inferência** (`src/vision/scheduler.ts`, 113 linhas): bem desenhado — fila única com prioridade, coalescência por `key`, `maxConcurrent` configurável. Resolveu o problema real (N filas paralelas competindo pela GPU) sem overengineering. **Ponto alto.** Ressalva (I): é um **singleton de módulo** (estado global oculto) — difícil isolar em teste unitário; aceitável na escala atual.
- 🟡 **Holders por zona** (instâncias de processador) vivem em `refs` dentro de `CameraWorkspace` e são criados/descartados no ciclo de vida do componente (`holderFor`, `removeZone`). Acopla lógica de visão ao lifecycle do React — parte do inchaço do §2.2.
- 🟢/🟡 **Persistência JSON × Postgres** (ADR-005): fallback por design (resiliência). Custo: **caminho de código duplo** (`pgstore.js` × espelho JSON via `recipients.js`/`settings.js`) que precisa ficar em sincronia manual.
- 🔴 **Verificação automatizada ausente** (lacuna "Onda 0", CLAUDE §6 + `PRATICAS_ENGENHARIA.md` "Dívidas"): **sem ESLint, sem Prettier, sem CI** (`.github/workflows` inexistente) `(E)`. As lógicas puras críticas — `vision/counting.ts` (396), `report/predict.ts`, `report/mock.ts` (agregações), `server/alarmPolicy.js` (594) — **não têm teste unitário**; a validação por onda foi `tsc + vite build + playwright` (verde *estrutural*, não cobre os heurísticos "A confirmar"). Pela `ANALISE_MERCADO_DEV.md`, esta é a lacuna de **maior alavancagem** de todo o projeto.

---

## 7. Como chegou aqui — dívida do processo de ondas `(I)` (com base em `analises/implementacao-changelog.md` + ADR-001)

O projeto evoluiu por **ondas A–G** (changelog: Onda A quick-wins → B/B2/C diferenciais + RBAC → D saúde de alarmes/clipe → E persistência de views/tripwires → F live-sync/shelves → G migração Radix), **paralelizadas por propriedade exclusiva de arquivo** (ADR-001), validadas por `tsc + build + e2e`.

Esse processo entregou muito com pouca cerimônia, mas deixou três marcas de dívida previsíveis:
1. **`CameraWorkspace.tsx` virou o sumidouro compartilhado** — como quase toda onda mexe na câmera e a partição é por arquivo, o componente cresceu até 1366 linhas (gargalo nº 1).
2. **Redundância entre frentes paralelas** — frentes que não podiam editar o mesmo arquivo recriaram contratos/estilos: `AlarmEvent` duplicado (frente relatório × frente alarmes), dois mecanismos de grid (Fase 1 × ondas seguintes), tokens CSS legados nunca recolhidos após a refatoração de tokens.
3. **Backlog "A confirmar" acumulado** — cada onda fechou com itens "A confirmar" (heurísticos como `OCC_HI`); sem teste unitário sobre a lógica pura, essas premissas seguem **não validadas** (gera "ilusão de controle" no sentido da `ANALISE_MERCADO_DEV.md`).

---

## 8. Retrofit priorizado (P0/P1/P2)

> Esforço em escala grosseira: **S** ≤ meio dia · **M** 1–2 dias · **L** 3–5 dias. Filtro anti-overengineering (CLAUDE §5): só itens que reduzem carga de manutenção real ou fecham risco de regressão.

### P0 — fazer primeiro (risco/alavancagem altos)
- **[P0·M] Onda 0 de verificação:** adicionar **ESLint + Prettier** + **CI mínimo** (GitHub Actions ou pre-push) rodando `verify` (tsc + build + playwright + `node --check`). Trava a entropia antes de qualquer refactor maior. *(É a recomendação convergente de CLAUDE §6, Akita e mercado.)*
- **[P0·M] Unit tests da lógica pura** antes de tocá-la: `vision/counting.ts`, `report/predict.ts` e agregações de `report/mock.ts`, `server/alarmPolicy.js`. Vira a rede de segurança para os refactors P1.
- **[P0·S] Unificar o tipo `AlarmEvent`:** eleger `src/api.ts` como dono do contrato; `report/mock.ts`/`csv.ts`/`store.ts` passam a importar dele (remove a 2ª definição e o risco de drift).

### P1 — em seguida (estrutura)
- **[P1·L] Quebrar `CameraWorkspace.tsx`** em hooks + módulos de responsabilidade única (sob a rede de testes do P0). Sugestão de fatiamento:
  - `useCineLoop` (congelar/review/scrub/buffer) · `useZoneEditor` · `useTripwireEditor` · `useZoneHolders` (holders/inferência por zona).
  - Mover **desenho** (`drawScene`, `drawFadigaZone`, `drawReviewFrame`) para um módulo `camera/draw.ts` (funções puras testáveis).
  - Mover **telemetria** (`*ToMetric`) e **thresholds** (`OCC_HI`/`NOREAD_CRIT`/`EAR_HI`) para `config.ts` / `processors/`.
  - Alvo: componente de orquestração **< 400 linhas**.
- **[P1·M] Extrair seções de `ReportPage.tsx` e `DashboardPage.tsx`** em subcomponentes/hooks (`useDashboardSocket`, `useViews`); separar `mock.ts` em *dados mock* × *funções puras*.
- **[P1·S] Unificar grid do Dashboard:** remover a regra morta `--dash-cols` (`index.css:262`), ficando só com `data-cols`.

### P2 — higiene / evolução
- **[P2·M] Recolher tokens CSS legados:** migrar os ~40 usos de `--ok/--idle/--alert` para `--state-*` e remover os aliases legados (fecha a invariante "going gray"/ADR-003). Fatiar `index.css` por domínio.
- **[P2·M] `server/alarmPolicy.js`** → separar métricas × shelving × dedup; substituir o `if`-chain de `server/index.js` por uma **tabela de rotas** (mata a fragilidade de ordem).
- **[P2·S] Aposentar** a migração legada de tripwires (`loadLegacyTripwires`/`clearLegacyTripwires`) após confirmar adoção da persistência backend (Onda E).

---

## 9. Limitações desta auditoria
Análise estática de leitura; **nada foi executado nem alterado**. Contagens de hooks/linhas por `grep`/`wc` (boa aproximação, não AST). As notas de drift de contrato (`AlarmEvent`) e código morto (`--dash-cols`) são `(E)` confirmadas; os esforços de retrofit (§8) são estimativas `(I)`.
