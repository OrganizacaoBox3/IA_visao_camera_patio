# Pendências — Identidade aumentada BLE (tags nas câmeras)

> **Doc vivo.** Fonte única das pendências deste arco (tags BLE + AR nas câmeras).
> Atualizar a cada onda — feito sobe pra "Feito", novo gap entra em "Pendente".
> Diretriz do usuário (jul/2026): **manter as pendências sempre registradas.**
> Última atualização: jul/2026.

## Feito (no `main`)

- Registro/nomeação de tags (`bt_tags` + `/tags-ble`).
- Estação TC22 (app robusto, tela viva, sem Grendene no header).
- Ingest efêmero (`bt-readings`) + relay socket `bt-readings` + snapshot.
- Homografia (retângulo de dimensão conhecida + arrastar pontos + grade de conferência).
- Fusão tag↔pessoa por correlação RSSI×distância + recusa honesta ("não sei").
- Rótulo AR na caixa da pessoa — **grade E tela cheia**.
- **Ponto da ESTAÇÃO na calibração** (origem correta da correlação) — commit `91aa48c`.
- **Fase 2 — tag fixa de REFERÊNCIA**: heartbeat da estação + drift do RSSI + leitura RSSI@1m
  (observabilidade; **não** entra na associação, que segue por correlação). Módulo puro `stationHealth.ts`
  + hook + chip; marcada na calibração (`refTag:{mac,px}`).
- **TC22 conecta ao hub sozinho**: descoberta UDP na LAN (broadcast `VISAO_HUB_DISCOVER` → o hub responde
  o endereço; `server/discovery.js` no MESMO processo — gate `single-hub.test.js`). Endereço também
  editável à mão (toque no subtítulo) e persistido, como fallback. "Sobe um, sobe tudo" travado em teste.
- **Costura de localização (ADR-012)**: contrato `LocatedEntity` (`src/localizacao/entity.ts`) + adapters
  do heurístico; a `TagsMapPage` consome a costura (prova viva).
- **Fase 0 do motor científico — harness de replay** (`src/localizacao/`, `docs/cientifica/fase0-harness-replay.md`):
  contrato de evidência + motor puro plugável + gerador sintético + métricas (RMSE/cobertura) + gate Vitest.
  **Baseline v0 medido: RMSE 24,4 m** no cenário-gate — o alvo que a fusão futura precisa superar.
- **Fase 1 (paralelizada)**: (A) **recorder opt-in** de dado real (`server/bt/recorder.js`, `BT_RECORD` OFF por
  default, metadados-only/LGPD, gitignored) + loader puro (`src/localizacao/recording.ts`); (B) **motor de fusão v1**
  (`src/localizacao/fusion-engine.ts`, centroide ponderado por RSSI) — **RMSE 12,29 m (~metade do baseline)** no gate
  sintético. Ganho honesto: sintético; campo tende a menos.
- **Fase 2 (paralelizada)**: (1) **motor v2 com modelo de movimento** (`src/localizacao/motion-engine.ts`, velocidade
  da tag + extrapolação) — 11,28 m no gate; (2) **suíte de benchmark** (`src/localizacao/scenarios.ts`, 9 cenários).
  **Achado honesto:** a fusão v1 é o ganho robusto (~43% vs baseline, 8/9); o v2 **empata** no agregado (14,8 vs 14,9)
  e perde em 4/9 por overshoot — ganho decisivo do v2 fica p/ um **v3 com extrapolação adaptativa por confiança**.
- **Fase 3 (torneio paralelo)**: 2 hipóteses de v3 (consistência × resíduo). Vencedor **`guarded-engine.ts`** (resíduo
  + confiança da base) — **14,35 m (−3,7% vs v1)**, vence 5/9. **TETO FÍSICO provado:** 4/9 cenários têm ganho de
  extrapolação ótimo = 0 → limite de 1 estação+RSSI; caminho além = **âncora/multi-estação**, não mais extrapolação.
  **Default segue o v1** (ganho do v3 é modesto/sintético/afinado à suíte) — v3 é candidato até **dado de campo** validar.

## Pendente (priorizado — REORDENADO 2026-07-10 pelo especialista, em resposta ao relatório consolidado)

> Ver `docs/cientifica/relatorio-especialista-resposta-2026-07-10.md` (resposta integral) e
> `status-implementacao.md` §Princípios institucionalizados. Ordem por valor imediato/esforço, não por
> ambição — o campo (real) sempre antes de qualquer coisa construída em cima de fundação sintética.

1. ✅ **Mineração das 6h reais** (quedas transientes/autocorrelação/cross-âncora) — FEITO, ver abaixo.
2. **Hello world de campo (2 min, o próprio dono sozinho, 1 tag no bolso)** — verdade trivial (todo
   track é ele), zero coordenação. Mede viés corporal real + correlação RSSI×distância com corpo de
   verdade + taxa de abstenção com alvo único. Não mede ambiguidade multi-pessoa, mas já destrava as
   perguntas de viés/GP. O roteiro completo de 6 min (`protocolo-teste-campo-indoor.md`) continua
   sendo o padrão-ouro quando houver disponibilidade — **ambos DEFERIDOS pelo dono**, não bloqueio
   técnico. É também o dado que decide se os knobs `maxDistRatio`/`distWeight` da v4 podem ser religados.
3. 🟡 **Contrato de gravação/pseudo-label** (session-recorder) — PARCIAL, 2026-07-10:
   - ✅ **Versão do algoritmo/knobs por sessão**: linha `"meta"` no JSONL (`gitRev` do hub via
     `git rev-parse --short HEAD` + espelho manual do `FusionConfig` DEFAULTS de `associate.ts`),
     escrita 1x por processo. `session-loader.ts` parseia (`SessionMeta`), retrocompatível com
     gravações antigas (`meta: null`).
   - ⬜ **Decisões do associador por tick (margem + candidatos rejeitados)** — GAP HONESTO: o
     associador (`TagTrackAssociator.assign()`) roda no CLIENTE (`useTagFusion.ts`, browser), não
     no hub que grava o JSONL (`server/bt/session-recorder.js`) — gravar isso exige um canal NOVO
     cliente→servidor (endpoint/socket) que não existe hoje; não construído sem necessidade
     validada em campo. A DEFINIÇÃO já está pronta em código: `PseudoLabelCandidate`/
     `AssignmentTick`/`findPseudoLabelCandidates` (`src/fusion/session-loader.ts`) — "episódio-
     candidato" = associação sustentada (≥5s), margem alta (≥0.15), sem conflito, sem troca de
     tag/id no mesmo track. Espera o wiring de gravação para ter dado real a minerar.
   - ⬜ **Offset de relógio hub↔TC22** — investigado e CONFIRMADO limite físico: o payload real do
     TC22 (`tc22-scanner/.../MainActivity.java:405`, contrato `{stationId, readings:[{mac,name,rssi}]}`)
     NÃO tem timestamp do dispositivo — todo `ts` é `Date.now()` do hub na chegada (mesmo achado já
     listado em `status-implementacao.md`, "ts de captura na borda"). Não implementável sem o TC22
     ganhar um campo de timestamp próprio; documentado como limitação, não inventado protocolo NTP.
     Se o TC22 um dia mandar `deviceTs`, a linha `{"t":"clock","ts":<hubTs>,"deviceTs":<...>}` é o
     formato natural a adicionar (o loader já tolera tipos de linha desconhecidos).
4. **Espalhar as âncoras em distâncias log-espaçadas** (ex.: 0,5/1,5/4/8 m à estação, não um retângulo
   compacto) — barato, destrava a identificabilidade do expoente `n` e amplia a malha de auditoria de
   resíduo (uma âncora perto do canto da `…CE:3C` separaria obstrução local de deriva da estação).
   Requer acesso físico — mesma disponibilidade do item 2.
5. **Set-membership ∩navegável** — RECALIBRADO: item de **produto** (anéis visualmente honestos), não
   degrau científico nesta arquitetura (câmera=posição já não precisa da restrição de mapa; anel de 1
   estação é isotrópico). Geometria pura já pronta (`floor-polygon.ts`); falta só a UI.
6. **Multi-estação** — gated (hardware é barato — ESP32/Android aposentado bastam — mas o custo real é
   que cada estação nova precisa da própria calibração/auditoria de deriva, como as 4 âncoras atuais
   já provam). Depois do campo, não antes.
7. ✅🔬 **Reliability diagram + taxa de conflito** — CONSTRUÍDOS 2026-07-10 (task #13). `conflictRate`
   NÃO é baixa (46,9% no canônico, ~90-98% em multidão) — **corrigiu a suposição do especialista** de
   que seria rara com poucas tags. Reliability é honestamente monotônico em `multidao`.
8. 🔬 **Hungarian+dustbin — ELEVADO de "gated" para EXPERIMENTO IMEDIATO** (2026-07-10, o próprio
   gatilho do item 7 acabou de estourar o limiar): a taxa de conflito alta muda a leitura — não é
   "Sinkhorn standalone" (recalibrado, Pergunta 1), é **atribuição com abstenção dentro da
   otimização** (dustbin do SuperGlue / unbalanced OT). Diferente do v4: é política de decisão sobre
   os MESMOS scores que o guloso já consome — não introduz física nova, logo estruturalmente menos
   vulnerável à circularidade (as 2 sentinelas de viés rodam mesmo assim; disciplina não abre exceção).
   **Desenho**: custo da lixeira DERIVADO da curva de calibração (aceitar par só quando a precisão
   empírica implicada pela margem ≥ alvo de produto) — não é knob livre. Regra a priori: erro total ≤
   baseline, cobertura ≥ baseline, sobrevive às sentinelas, ganho decomposto OBRIGATORIAMENTE como
   conversão abstenção→acerto (lição do v4, não reembaralhamento de acertos entre pares).
   **Pré-requisito em andamento**: curva de reliability SEM o corte de minMargin (task em progresso)
   — o custo do dustbin deriva dela.
9. **Persistência de rótulo no track** (produto — não ciência, mas rodada própria tipo v4) — escopo
   escrito em `docs/cientifica/escopo-persistencia-rotulo.md` (máquina de estados, métricas novas —
   cobertura de experiência/erro-segundos/latência de correção — sentinela de id-switch-na-
   confirmação). **Construção e torneio começam já** (não é física nova); o **DEFAULT em produção**
   fica condicionado a dado (ou proxy) de id-switch com gente de verdade — diferente do hello world
   solo (item 2), que não testa ambiguidade multi-pessoa.
10. **Fragmentação de tracks como proxy de id-switch** — minerável JÁ na gravação passiva que
    recomeçou (morte+renascimento de track próximos no tempo/espaço), sem verdade anotada. Não
    captura troca SILENCIOSA entre 2 pessoas que se cruzam, mas calibra a ordem de grandeza real da
    instabilidade do tracker (hoje só chutada pelo simulador) — alimenta o gate do item 9.
11. **Achado de código (2026-07-10, verificado por leitura, não suposição)**: o cálculo de
    margem/conflito (`associate.ts`) usa a matriz de score ESTÁTICA (pré-resolução gulosa) — um
    concorrente "fantasma" já consumido por OUTRO par ainda conta como rival. Isso **superestima**
    ambiguidade sistematicamente (nunca subestima) e pode explicar parte da taxa de conflito alta,
    em cima da colisão de assinatura 1-D. Não é bug (é simplificação defensável); registrado para
    informar a leitura do shuffle-baseline (item 7) e de qualquer refinamento futuro do dustbin.

### Previsões falseáveis registradas (especialista, 2026-07-10 — cobrar depois de medir)

- **(a)** Taxa de conflito sob shuffle (embaralhar RSSI entre tags) ficará PRÓXIMA da real em
  `multidao`; no `canonico`, a real ficará VISIVELMENTE ABAIXO do shuffle (scores carregam informação
  real ali). Em teste (Frente C, 2026-07-10).
- **(b)** Alongar a janela de correlação (`windowMs`) derruba a taxa de conflito MAIS do que melhora a
  precisão média — ataca a colisão, não o ruído.
- **(c)** A segunda estação, quando existir, derrubará a taxa de conflito desproporcionalmente ao
  ganho de precisão — duplica a dimensão do espaço de assinatura.

### Feito em 2026-07-10 (upgrade medido pelo harness — ver `docs/cientifica/harness-associacao-indoor.md`)

- ✅ **Guarda de ambiguidade top-2** (minMargin 0.1, novo default por torneio com regra a priori):
  erros da suíte −46%, id-switches 59→6, `bloco` 60,8→82,0% de precisão; + fix do furo de oclusão
  (dono ocluso segue vetando — reproduzido e testado).
- ✅ **CameraTile passa `stationPx`** (usa `useCameraTagLabels`, o caminho do fullscreen) — +32 pts medidos.
- ✅ **Calibração não fica mais stale** (rev por câmera via `camcfg-updated {kind:"calibration"}`, ADR-006).
- ✅ **Hungarian medido e rejeitado como default** (wrong +4,9% vs guloso) — knob `optimal` existe, desligado.
- ✅ **Plotagem de tags no chão** (monitoramento, grade+fullscreen): âncoras nos cantos (amarelo, posição
  exata), estação e ANÉIS de distância (ciano, tracejado — honesto: 1 antena = distância, não posição) p/
  tags não-associadas; RSSI→distância **calibrado ao vivo pelas âncoras** (`floor-plot.ts`; span estreito →
  regime `anchors-offset`: offset calibrado, expoente fixo). Anomalia (âncora muda >15 s) em vermelho.
  Revisão adversarial: anel-fantasma no horizonte (cheirality) e identificabilidade do fit corrigidos.
- ✅ **UX das âncoras na calibração**: tag já usada (âncora de outro canto / referência) aparece
  DESABILITADA com o papel visível — não some (sumiria = "fora de alcance") nem confunde.
- ✅ **v4 — evidência de distância absoluta (tags-âncora calibram o RSSI)**: implementada, torneada,
  **revertida pela revisão adversarial** (circularidade sim↔fit provada — com viés corporal real a
  v4 ligada piora drasticamente, precisão 26%/cobertura 1,8%). Decisão final e ADOTADA: **tags-âncora
  nunca são candidatas a pessoa** (`excludeTags`) — captura o ganho real sem modelo de RSSI no
  caminho. Gate (`maxDistRatio`) e blend (`distWeight`) ficam como knobs de PESQUISA desligados,
  com 2 sentinelas de viés permanentes no harness (`ancoras-multidao-bias`, `ancoras-mismatch-n`).
  Detalhes: `docs/cientifica/harness-associacao-indoor.md` §v4.
- ✅ **Orientação de instalação documentada na UI**: passo "Estação BLE" da calibração
  (`CalibrationPanel.tsx`) ganhou dica (`Alert tone="info"`) para fixar a estação BLE junto da
  câmera — texto honesto e escopado ao modo sem calibração (medido: +27 pts, 71,8% vs 44,5%, ver
  `docs/cientifica/harness-associacao-indoor.md`); comentário no código cita a fonte do número.
- ✅ **Geometria pura do set-membership ∩navegável** (`floor-polygon.ts`): point-in-polygon + recorte
  do anel por polígono, 100% testado, ZERO consumidores em produção ainda (falta a UI — recalibrado
  como item de produto, não ciência, ver §Princípios institucionalizados em `status-implementacao.md`).
- ✅ **Mineração das 6h reais** (sem precisar de pessoas): quedas transientes de RSSI por âncora =
  proxy de atenuação corporal (profundidade média ~12 dB, dentro do envelope estimado pelo
  especialista); autocorrelação temporal alta (0,49-0,94 em 2 s) — confirma que o ruído real NÃO é
  independente amostra-a-amostra como o simulador assume; cross-âncora mostra 66-72% das quedas são
  LOCAIS (não evento global) — valida o desenho do resíduo-por-âncora; `…CE:3C` tem o maior nº de
  quedas (490 em 7h) com distribuição de cauda pesada (obstrução intermitente, não multipath
  estrutural constante). Detalhes: `docs/cientifica/relatorio-consolidado-2026-07-10.md` §9.5.

## Limites honestos (não são bugs — física de 1 estação + RSSI)

- Pessoa **parada** ou em **aglomerado** → tende a "não sei" (SNR≈1; sem movimento não há o que correlacionar).
- **Posição em metros vem da CÂMERA** (homografia); o BLE só decide **QUEM**. Marcar estação/referência
  melhora o "quem", não adiciona posição.

## Fora deste arco (ver memória `homolog-estado-deploy`)

- Deploy dos acumulados no homolog (disco ~99% — risco em pé).
- Segurança: rotacionar senha admin/Postgres + `AUTH_SECRET`; instalar poda de backups + sudoers.
- Fine-tune (recall em multidão além do teto S@896) — bloqueado em GPU (Colab/cloud).
