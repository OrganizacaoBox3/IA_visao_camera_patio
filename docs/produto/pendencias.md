# Backlog / pendências — Visão de Pátio (POC)

> Itens deixados para depois, com origem. Atualizado em 2026-06-09.

## Adiado explicitamente
- **Relatório — Etapa B (persistência real / IndexedDB):** a central grava **só indicadores** (LGPD) enquanto roda; a tela `/relatorio` passa a ler dados reais (hoje usa mock). *(pausado a pedido em 2026-06-09; tela/Etapa A já feita)*
- **Relatório — Etapa C:** insights automáticos mais ricos + export PDF nativo + comparativo antes/depois por marco. *(depende da B)*
- **Reconhecimento facial (Nível 3):** identificação individual/biometria — só como módulo isolado, opt-in, off por padrão, local-only, rotulado, cenário de acesso/porta. Pendente de OK explícito. Ver `avaliacao-reconhecimento-presenca.md`.
- **Alertas externos (WhatsApp):** canal de notificação à liderança. Adiado pelo usuário ("sem notificação por enquanto"); banner no painel já imita o formato.
- **Multi-tenant:** adiado pelo usuário.

## ★ TOP 1
- **Melhorar export CSV e PDF do relatório** — tarefa #30. CSV completo (eventos + agregados por área/atividade/turno/horário + KPIs) e PDF nativo bem formatado (cabeçalho, gráficos legíveis) no lugar do print. (= Relatório Etapa C)

## Gaps do documento ainda abertos (de `cobertura-vs-documento.md`)
- **Acesso restrito ao painel (login)** — tarefa #25.
- **Robustez a falso positivo industrial** — tarefa #27.
- **Processamento edge/local/nuvem** — tarefa #28.

## Feito
- **#24 Câmera IP / RTSP** — FEITO 2026-06-09. Hub ingere RTSP via **ffmpeg → frames JPEG (MJPEG)** e emite o mesmo evento `frame` → câmera IP vira câmera comum (zonas/análise/histórico) **sem mudar o front**. `server/rtsp.js` (spawn ffmpeg, parse FFD8..FFD9, reconnect, ENOENT-safe). Fontes: `server/rtsp.sources.json` (gitignored) ou env `RTSP_SOURCES`. Requer **ffmpeg no PATH**. *Não testado contra RTSP real aqui (sem ffmpeg/câmera); boot+sintaxe ok. Produção low-latency = WebRTC/go2rtc (evolução).*
- **Relatório em ABAS (anti-scroll)** — FEITO 2026-06-09. Topo fixo (filtros·lente·KPIs·insight slim) + abas **Quando para** (heatmap), **Onde para** (ranking por área **+ por atividade** — novo), **Tendência** (evolução 14d **+ por turno** — novo), **Eventos** (tabela). Só o painel da aba ativa rola (um único scrollbar, sem barras aninhadas). `Cell` ganhou `atividade` (mock+store) p/ o ranking por atividade.
- **#1/#23 Histórico real (persistência IndexedDB) + #29 só indicadores** — FEITO 2026-06-09. `src/report/store.ts`: IndexedDB (`buckets` por câmera|zona|hora + `events`), **só indicadores, sem imagens** (LGPD). A central mantém a **grade montada** (câmera aberta vira overlay) e os **tiles gravam** continuamente: `CameraView` emite amostras a cada 3s (`onSample`) + alertas (`onAlert`). `/relatorio` agora lê **dados reais** (`loadDataset`→reusa as agregações de mock.ts; `loadEvents`→tabela), com **empty-state honesto** + botões **"Carregar dados de demonstração"** (`seedDemo`), **↻ atualizar** e **limpar histórico** (`clearAll`). Substituiu o mock fixo. Etapa C (insights automáticos avançados/PDF nativo) segue como evolução.
- **#4 Dimensões fluxo e atividade por área** — FEITO 2026-06-09. **Atividade:** campo estruturado por zona (Carga/Descarga/Expedição/Estoque/Picking/Espera/Produção/Indefinida), seletor no card, persiste; semente infere do nome. **Fluxo:** histórico de movimento por zona (amostra ~2×/s, buffer 40) → **sparkline** + **nível Alto/Médio/Baixo** no card. (Turno já existia como filtro no relatório.) *Agregação por atividade no relatório fica junto da persistência (#23).*
- **Redesign UX F1→F5** — FEITO 2026-06-09. **F1** SPA app shell (rail slim Central/Relatório; `/camera` fora) + tokens espaçamento. **F2** câmera feed-dominante (faixa KPI deduplicada + alerta em toast + drawer "Detalhes" abas Áreas/Timeline/Presença → tela ao vivo sem scroll). **F3** central: grade adaptativa (`colsFor` 1/2/3/4 col) que **preenche o viewport**, tiles flex (sem aspect fixo), scroll só com muitas câmeras. **F4** relatório: grade 2×2 (`rep-content`) que cabe sem scroll de página; só a tabela de eventos rola; em <1000px empilha e rola. **F5** mobile: rail vira **bottom-nav** <640px, drawer vira bottom-sheet, headers quebram linha. Plano em `docs/produto/plano-ux-redesign.md`. Build verde. *(refino fino e validação ao vivo pendentes)*
- **Sensibilidade de movimento por área (slider na UI)** — FEITO 2026-06-09. Cada zona tem `sensitivity` 1..10 (slider no card); mapeia p/ fator nos limiares (`sensitivityFactor`, 5=padrão). Persiste por câmera. Calibra falso positivo (sombra/luz) sem mexer em arquivo.
- **#2 Estado "baixa movimentação / gargalo" (LENTA)** — FEITO 2026-06-09. Faixa de movimento entre `motionSlowRatio` e `motionActiveRatio` = LENTA (laranja); movimento fraco NÃO conta como parada (não dispara alerta), mas é sinalizado como gargalo (estado + badge + evento). Cinco estados: ATIVA·LENTA·OCIOSA·VAZIA·ALERTA.
- **#3 Limite por área configurável na interface** ("a liderança define limites") — FEITO 2026-06-09. Cada zona tem seu `idleAlertMs`, editável por um seletor no card da zona (presets 30s..30min); persiste por câmera em localStorage (só geometria/limites, sem imagens). O toggle "Limite curto (10s)" da central sobrepõe para demo. *(possível evolução: limite custom livre; outras "regras" por área — ex.: sensibilidade de movimento)*
