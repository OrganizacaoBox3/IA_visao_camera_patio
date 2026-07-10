# Retrofit-2 · Frente 05 — Front-app (routes, ui, report, api/auth/config, components)

> Escopo lido: `src/routes/**`, `src/ui/**`, `src/report/**`, `src/api.ts`, `src/auth.tsx`,
> `src/config.ts`, `src/components/**`. Leitura integral dos arquivos grandes; medição de densidade
> de comentário por grep. READ-ONLY: nenhuma linha de código foi tocada.
>
> **Nota de separação-de-responsabilidade do domínio hoje: 7/10.** O retrofit R2 já quebrou os dois
> god-components históricos (DashboardPage → 4 hooks por domínio; ReportPage → painéis + csv builders
> + calc/). O que sobrou de dívida é localizado: ReportPage ainda é uma god-page de orquestração
> (1017 linhas, 6 modos simultâneos), CameraPage carrega o pipeline inteiro do nó de captura inline,
> e há 3 duplicações pequenas porém reais entre camadas. O ruído dominante não é estrutura — é
> **arqueologia de plano nos comentários** ("Onda X", "Fase Y", "plano 1.3", "antes era…").

---

## 1. COMENTÁRIOS — inventário do ruído

Padrão dominante: comentários-changelog que citam ondas/planos/auditorias como se o leitor tivesse o
histórico na cabeça (`Onda B · item 7`, `F1-C (ADR-009)`, `2.2 —`, `0.2 —`, `plano 1.3`, `auditoria
§S1`, `R2.2`, `jul/2026`, `antes era…/era 960/0.75→0.85→0.9`). O conteúdo técnico embutido muitas
vezes É bom (invariante/contrato); a tag de processo e a narrativa do "antes" são removíveis sem
perda. Comentário-lápide ("o bloco X foi REMOVIDO…") aparece em pelo menos 4 arquivos.

**Piores 10** (densidade medida em linhas-comentário `//`+`*`; JSX `{/* */}` não entra na contagem,
então os `.tsx` estão subestimados):

| Arquivo | Coment. | Removível (est.) | O que cortar / o que preservar |
|---|---|---|---|
| `src/routes/dashboard/CameraTile.tsx` | 71/290 (24%+JSX) | ~50% | Tags "Fase 1/Fase 2/0.2/1.6" em toda prop e ramo (ex.: 13–24, 175–205, 237–247). Preservar: invariante da ordem `config antes de src` (82), semântica do fail-timer (87–103). |
| `src/routes/DashboardPage.tsx` | 56/339 (16%+JSX) | ~50% | Narrativa 0.2/0.6/1.6/2.1/A1 (27–31, 104–110, 149–158, 304–317) e lápides JSX (230–232, 325–326). Preservar: contrato do conjunto ativo + `watch` (111–137). |
| `src/routes/dashboard/useDashboardSocket.ts` | 50/208 (24%) | ~45% | Prefixos F1-C/F2/A1/2.1/ADR-006 repetidos por handler (62–71, 112–125, 193–199). Preservar: payload defensivo, `ts` local imune a skew (123–125), reconexão perde rooms/foco (86–91). |
| `src/routes/dashboard/useFrameRelay.ts` | 56/216 (26%) | ~40% | Tags 2.2/1.7/F2 (64–67, 79–95, 146–149). Preservar: INVARIANTE w/h=bitmap (14–17), as 4 exceções do resize (83–89), corrida do decode em voo (102–105). |
| `src/config.ts` | 109/356 (31%) | ~35% | Histórias de calibração revertida (223–235: "era 960… revertida", 249–259: Onda 1 do WHIP), lápide de zonas-semente (276–277). Preservar: TODOS os racionais de knob (é a doc dos limiares — ex.: 58–64, 72–77) e o porquê da não-circularidade `ModeKey` (292–294). |
| `src/routes/CameraPage.tsx` | 55/373 (15%) | ~35% | Fase 5/Onda 1 (8–14, 107–114). Preservar: keep-alive de 2º plano e limitações de plataforma (204–207, 234–238, 263–265) — é invariante de runtime real. |
| `src/report/store.ts` | 48/500 (10%) | ~40% | "(plano 1.2/1.3/2.6)", "antes era engolido" (1–4, 50–52, 71–72, 120–121, 149, 236–239, 489, 494–499). Preservar: contrato do kind "flow" (199–201), erro propaga vs. fire-and-forget (56, 71–72). |
| `src/routes/ReportPage.tsx` | 30/1017 (3%+JSX) | ~50% dos existentes | "(plano 2.6)", "(Onda B, item 8)", "Descoberta dos modos (jul/2026)… Antes dizia" (149, 168, 239, 720–722, 747–748). Preservar: falha ISOLADA do status/flow (179–185), aba fluxo só em Atividade (533). |
| `src/api.ts` | 74/356 (21%) | ~25% | Tags de onda (98, 176, 179–181, 208) e a justificativa histórica do re-export (179–182). Preservar: docs de rota/auth por endpoint (são o contrato) e avisos LGPD da url sensível (306–307). |
| `src/routes/dashboard/useVideoTransport.ts` | 35/105 (33%) | ~30% | Tag "Onda 2"/"smell do tick" (1–5, 23–25). Preservar: o bug registrado≠com-frames (28–31) e o porquê do re-render só na transição (99–101). |

Menções honrosas: `routes/report/chrome.tsx` (24% — três comentários "antes duplicado em cada
painel"), `routes/report/aggregate.ts` (35% — idem), `AlarmHealthPage.tsx:356-358` (lápide),
`ui/index.ts:25` ("adicionados na Fase 0"), `LocalNodeSection.tsx:7-8` ("Antes duplicada… dívida
anotada"). Contra-exemplo a imitar: `report/predict.ts` (40% de comentário, mas 100% premissas do
modelo — comentário BOM) e `Heatmap.tsx:78-82` (exceção de a11y documentada com "Não converter").

---

## 2. RESPONSABILIDADE — misturas de concern

**god-page remanescente**
- `src/routes/ReportPage.tsx` (1017): a página segura estado+pipeline de **6 modos ao mesmo tempo**
  — ~25 `useState` (139–174) e ~40 `useMemo` (231–405) sempre computados (todos os modos recalculam
  a cada mudança de filtro, mesmo os invisíveis, por ordem de hooks). Lógica de domínio na página:
  agregação `byAtiv` inline (250–264) enquanto todas as irmãs vivem em `report/calc/`; ternários de
  4 níveis para `lens`/`filtroLabel`/`noData` (413–455). O JSX dos filtros repete o mesmo `<Select>`
  por modo (584–649).
- `src/routes/CameraPage.tsx` (373): a rota do nó de câmera contém o **pipeline de captura inteiro**
  num único efeito de ~260 linhas (59–320): probe WHIP (115–145), encoder JPEG (165–200), loop
  rVFC↔timer (209–292), keep-alive de áudio (239–257), perfil `capture` (295–303). Página = domínio
  de captura embutido. (`camera/acquire.ts` e `camera/whip.ts` já foram extraídos; faltou o relé.)

**domínio no lugar errado**
- `src/report/mock.ts`: nome mente — não é mock, é o **barrel dos cálculos reais** (`calc/*`).
  Todos os consumidores (ReportPage, store, csv, predict) importam "de ./mock".
- `src/report/store.ts:236-339`: cálculos PUROS de fluxo (`flowWindow/flowKpis/flowByHour/flowByLine`)
  vivem na camada de persistência (o comentário 237 admite: "calc/ é de outra frente" — a frente
  acabou; hoje é só dívida). `PERIOD_DAYS` espelhado 2× (`store.ts:252`, `routes/report/aggregate.ts:10`).
- `src/routes/report/ObjetosPanel.tsx:19-22`: `classLabel` (mapeamento de domínio objetos) exportado
  de um painel de UI e importado pelo builder de CSV (`routes/report/csv.ts:22`) e pelo ReportPage.
- `src/routes/dashboard/useDashboardSocket.ts:8-12` (+ `useFrameRelay.ts:8`, `TrackOverlay.tsx:3`):
  tipos do contrato de análise do hub (`HubAnalysis/HubTrack/HubZone`) são importados **de
  `CameraWorkspace.tsx`** — a camada de página/hook depende do god-component do motor visual (arquivo
  de outra frente). O contrato socket mora dentro de um componente.
- `useDashboardSocket` conhece política de decode (invalida `readingZoneRef`, chama
  `loadCamConfig` em `camcfg-updated`, 162–171): o roteador de eventos executa regra do relé.
- `DashboardPage.tsx:111-137`: a página mexe nos internals do relé (fecha `bmp`, escreve
  `activeIdsRef/openIdRef`) — vazamento do encapsulamento de `useFrameRelay`.

**duplicações entre camadas (regra dos 3 já estourada)**
1. **Rótulos/cores de prioridade+estado de alarme em 4 lugares**: `routes/report/AlarmesPanel.tsx:9-18`
   (PRIORITY_LABEL/STATE_LABEL), `routes/dashboard/AlarmDrawer.tsx:20-29` (PRIO_LABEL/STATE_LABEL,
   minúsculas), `report/csv.ts:41-50` (ALARM_PRIORITY_PT/STATE_PT), + cores em `AlarmDrawer.tsx:6-19`
   e `AlarmesPanel.tsx:20-26` (este com **RGB hard-coded** `239,68,68…` duplicando os tokens `--state-*`).
2. **Efeito "garante camcfg por câmera"** byte-quase-idêntico em `DashboardPage.tsx:74-85` e
   `cameras/IpCamerasSection.tsx:119-131` (+ `cfgOf` local nos dois).
3. **Criação de socket do hub** em 3 pontos: `useDashboardSocket.ts:74-78`, `CameraPage.tsx:88-92`,
   `IpCamerasSection.tsx:79-84` (mesmo shape `io(url,{transports,auth,query})`).
4. `HUB_TRACKS_STALE_MS = 5000` duplicado (`TrackOverlay.tsx:16` e cópia no CameraWorkspace, admitido
   no comentário 15).
5. Átomo de KPI 2×: `ui/misc.tsx:123-141` (`KpiCard`, Tailwind) vs `routes/report/KpiRow.tsx:17-34`
   (`Kpi`, classes `.kpi big` do CSS legado) — mesmos dados, dois sistemas de estilo.
6. `auth.tsx:24-32` `loginErrorFor` replica a intenção de `api.ts:friendlyStatus` (o próprio
   comentário propõe unificar).

**prop-drilling**: `UsersPage.tsx:137-155` injeta 16 props (8 pares get/set) em `NotificacoesTab`
porque as tabs Radix desmontam. Funciona, mas o pai virou um saco de estado das 3 abas.

**o que está BEM separado** (não mexer sem motivo): `routes/dashboard/*` (hooks por domínio, lógica
pura testada em `transport.ts` + `transport.test.ts`), `routes/report/*` (painéis burros recebendo
view-model pronto; átomos Heatmap/TrendChart/RankingBars/EventsTable puros), `report/aggregate.ts` e
`report/calc/*` (puros + Vitest), `src/ui/**` (átomos Radix limpos, ~0 domínio), `api.ts` como
porta HTTP do hub (ver §4), `AlarmHealthPage`/`ProfilePage`/`LocalNodeSection` coesos.

---

## 3. ABSTRAÇÃO — fronteiras que faltam (só as que pagam)

1. **`src/types/analysis.ts` — contrato `HubAnalysis/HubTrack/HubZone`** (mover de
   `CameraWorkspace.tsx`). Entra: nada (só tipos). Sai: shape do evento `analysis-tracks`.
   Paga já: desacopla `useDashboardSocket/useFrameRelay/TrackOverlay` do arquivo que a outra frente
   está reescrevendo agora. Mesmo padrão já provado por `src/types/alarm.ts` (R2.2). Colocar
   `HUB_TRACKS_STALE_MS` junto (fonte única do gate de stale).
2. **`src/report/calc/fluxo.ts`** — mover `flowWindow/flowKpis/flowByHour/flowByLine` + tipos
   `FlowCell/FlowDataset/FlowLineRow` de `store.ts:236-339`. Entra: `FlowDataset, Period, Shift`.
   Sai: agregados puros. `store.ts` volta a ser só IO (ingest/load). De quebra some o espelho
   `PERIOD_DAYS` (usar o de `calc/common` via re-export do barrel).
3. **View-model por modo do Relatório** — `routes/report/useAtividadeView.ts` (e irmãos), assinatura
   `useXView(ds, events, filters) → PanelProps`. Entra: dataset+filtros; sai: exatamente as props que
   o painel já recebe hoje. ReportPage cai para orquestração real (~350 linhas: refresh, mode,
   filtros, CSV/print) e cada modo só recalcula quando visível. É a MESMA fatia que os painéis já
   definiram — não é abstração nova, é mudança de moradia do pipeline de memos (231–405).
4. **`src/camera/nodeRelay.ts`** — extrair de `CameraPage.tsx` o relé JPEG+keep-alive. Contrato:
   `startNodeRelay({video, canvas, socket, profile}) → { stop(), setProfile(cfg) }`; o evento
   `capture` da central vira chamada a `setProfile`. A página fica com estado/badge/JSX. Paga: o
   pipeline vira testável e o hot-path do nó ganha dono nomeado.
5. **`src/alarms/presentation.ts`** (ou dentro de `types/alarm.ts`): rótulos pt-BR + token de cor por
   prioridade/estado. Entra: `AlarmPriority|AlarmState`; sai: `{label, colorVar, borderVar}`.
   Elimina a duplicação nº 1 do §2 e o RGB hard-coded do heatmap de alarmes.
6. **`renomear report/mock.ts → report/calc/index.ts`** (barrel no lugar canônico) com re-export de
   compat 1-linha em `mock.ts` até os imports migrarem. Custo ~zero, remove a mentira do nome.

**Não fazer (YAGNI)**: fábrica genérica de socket (3 usos com ciclos de vida bem diferentes —
ganho < custo); quebrar `api.ts` em módulos por domínio (356 linhas, navegável, uma responsabilidade:
"cliente HTTP do hub"); contexto global para o estado das abas de UsersPage (o desconforto não está
gerando bug); mover a busca do AppShell para hook próprio (< 150 linhas, coeso).

---

## 4. MAPA DE ATAQUE — perf & precisão neste domínio

**api.ts é a única porta para o hub?** Quase sim — e a exceção é desenhada: HTTP do hub passa 100%
por `apiGet/apiSend/apiPut` (`store.ts` ingest incluso), exceto o `POST /api/login` em
`auth.tsx:117` (pré-token, deliberado). O **go2rtc** tem superfície HTTP própria fora do api.ts:
`useVideoTransport.ts:47` (GET /api/streams), `CameraTile.tsx:60` (ws URL) e `camera/whip.ts`
(outra frente) — 3 pontos montando URL sobre `APP_CONFIG.go2rtc.baseUrl`; aceitável hoje, vira seam
"go2rtcClient" só se crescer. **Socket**: sem porta única (3 `io()` call-sites, §2).

**Hot-paths reais deste domínio (por custo/frame):**

| Hot-path | Dono (arquivo) | Knob | Como medir |
|---|---|---|---|
| Decode JPEG→ImageBitmap de todo feed ativo | `routes/dashboard/useFrameRelay.ts:73-123` (`drainDecode`) | `TILE_DECODE_WIDTH=640` (:34); exceções nativo (aberta/longRange/leitura/srcW≤640, :90-99) | `performance.mark` em volta do `createImageBitmap`; contagem de frames descartados (`pending` sobrescrito em socket `frame`) |
| Relé de frames do nó (draw+toBlob+arrayBuffer por frame) | `routes/CameraPage.tsx:165-200` | `net.frameWidth=1280 / frameFps=12 / jpegQuality=0.9` (`config.ts:232-234`); presets de leitura (`config.ts:149-154`) | fps efetivo enviado vs alvo; tempo de `toBlob`; CPU da aba do nó |
| rAF do overlay WebRTC (por tile) | `routes/dashboard/TrackOverlay.tsx:40-95` | `HUB_TRACKS_STALE_MS=5000` (:16) | tempo do `tick`; nota: `cssVar()` ×3 e `measureText` por track rodam TODO frame (:74-76, :88) — memoizar é ganho barato |
| Nº de pipelines simultâneos na grade | `DashboardPage.tsx:90-137` (conjunto ativo + `watch`) | `dashboard.feedsPerPage=6` (`config.ts:108`); pausa-de-fundo via `openId` | CPU total com 6 vs 4 feeds; nº de decodes/s agregado |
| Recompute do Relatório (6 modos sempre) | `ReportPage.tsx:231-405` | nenhum — estrutural (ver §3.3) | React Profiler ao trocar `period`; `console.time` no refresh com 30d de buckets |
| Pollings | `useVideoTransport.ts:76` (5s go2rtc), `AlarmHealthPage.tsx:38` (7s), `UsersPage.tsx:83` (5s WA) | intervalos hard-coded | contagem de reqs/min em idle |

**Knobs de PRECISÃO DE PESSOA — onde moram e quem é o dono:**

- **Dono claro e único: `src/config.ts`** — é a casa dos limiares do pipeline LOCAL (fallback do
  motor do hub, ADR-009): `people.scoreThreshold=0.4` (:57), `people.dwellMinMs` (:65),
  `people.track.{iouThreshold 0.25, ttlMs 1500, counterMaxDist 0.35, minCrossingFrames 2,
  debounceMs 800}` (:70-80 — precisão da CONTAGEM/tripwire), `detection.{minScore, maxBoxes 40,
  nmsIoU 0.45, tiles 2×2, detectTileWidth 512}` (:22-30) e o perfil `longRange` 4×4/640 (:38-47).
  Consumidores são da outra frente (`vision/*`, `processors/*`) — o contrato é o objeto APP_CONFIG.
  Os racionais escritos ali (ex.: por que NÃO existe limiar separado de presença, :58-64) são a
  melhor doc de calibração do repo — preservar no corte de comentários.
- **Knob que afeta o MOTOR DO HUB a partir deste domínio**: o form de câmera IP
  (`cameras/IpCamerasSection.tsx:519-563`) grava `fps/width/quality` usados pelo ffmpeg do hub —
  `width` default 720 encolhe pedestre distante abaixo do mínimo do detector (o hint :537 já avisa).
  Para precisão de pessoa em câmera de rua, **este form é o primeiro ponto de ataque** (entrada do
  D-FINE), antes de qualquer threshold.
- **Separar precisão EXIBIDA de precisão CONTADA**: `overlay.confidenceThreshold` + presets por modo
  (`config.ts:95-103, 310-356`) filtram só o DESENHO; `people.scoreThreshold` decide a contagem.
  Ambos se chamam "confiança" na UI — documentar/nomear a diferença ao atacar precisão, senão a
  calibração de um mascara o outro.
- **Precisão percebida no transporte WebRTC**: `TrackOverlay` + `camera/interpolate.ts` (outra
  frente) determinam se a caixa "acompanha" a pessoa; `WEBRTC_ESTABLISH_MS=7000`
  (`CameraTile.tsx:32`) e `WEBRTC_FAIL_COOLDOWN_MS=30_000` (`useVideoTransport.ts:15`) governam
  disponibilidade do caminho fluido.
- **Mensurável hoje, sem código novo**: taxa de ingest com falha (contador em `store.ts:53-70`, só
  console); pico de pessoas por bucket (`peoplePeakOf`, `store.ts:126-133`); fluxo in/out por linha
  (kind "flow"). Falta expor: frames decodificados/s e latência hub→overlay (ts do
  `analysis-tracks` é recepção local — `useDashboardSocket.ts:130`, skew-proof porém cego à latência).

---

## 5. RISCOS de reescrita — o que NÃO tocar

- **ADR-007 / rAF**: o overlay fullscreen (`DashboardPage.tsx:284-323`, `.cam-overlay`) monta
  `CameraWorkspace/FadigaView` num `div` cru de propósito — NUNCA converter em Radix Dialog
  (Portal/scroll-lock remonta o `<canvas>` e mata o rAF/editor). O mesmo vale para o padrão
  refs-sem-setState do relé (`useFrameRelay`): getters estáveis são contrato com o rAF do
  CameraWorkspace; introduzir estado React ali reintroduz re-render por frame.
- **Contratos socket aditivos** (CLAUDE.md §3): `frame`, `cameras`, `watch`, `capture`,
  `camera-status`, `alarm-event/update`, `camcfg-updated`, `analysis-status`, `analysis-tracks`,
  `analysis-focus` — os handlers em `useDashboardSocket.ts` e `CameraPage.tsx` são o lado cliente
  do contrato; só adicionar, nunca renomear/remover payloads.
- **LGPD**: nenhum frame persiste — `FrameEntry` é efêmero e `bmp.close()` é disciplina de memória
  E de política (useFrameRelay:150-177); URL de câmera com credenciais nunca logada e sempre
  mascarada (`api.ts:341-345`, IpCamerasSection:194-208 — a edição deixa a URL em branco de
  propósito); CSV/alarmes só metadados.
- **Frente paralela em curso**: `src/CameraWorkspace.tsx` e `src/vision/*` estão sendo editados
  AGORA por outra frente. Meus arquivos importam de lá: `useDashboardSocket.ts:8-12`,
  `useFrameRelay.ts:8`, `TrackOverlay.tsx:3`, `CameraTile.tsx:3`, `DashboardPage.tsx:5-6`
  (`setInferencePriority` de `vision/scheduler`). Qualquer mudança de assinatura de
  `HubAnalysis/getFrame/FrameSource` quebra este domínio — a extração §3.1 (types/analysis.ts) deve
  ser negociada COM essa frente, não feita por cima.
- **Ordem de hooks do ReportPage**: os memos "sempre computados p/ ordem estável" (:231, :359) são
  intencionais; a extração §3.3 precisa manter hooks incondicionais dentro de cada view-model hook.
- **Idempotências finas fáceis de perder**: re-emit de `watch`/`analysis-focus` no reconnect
  (useDashboardSocket:86-91), guard 1× do fail do WebRTC (CameraTile:52-56, 71-76), re-render só na
  transição de cooldown (useVideoTransport:99-101), corrida do decode em voo (useFrameRelay:102-113).
- **e2e depende de nomes acessíveis** do AppShell (`aria-label` estável nos links, AppShell:38-41) e
  do default expandido da sidebar (:57-58).
