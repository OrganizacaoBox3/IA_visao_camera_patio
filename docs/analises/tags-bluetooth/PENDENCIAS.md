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
   - 🔴 **PRIMEIRA TENTATIVA REAL (2026-07-10) — SEM SUCESSO, registrado honestamente**: câmera nova
     conectada, calibrada, tag cadastrada com nome. Achado antes desta tentativa: a grade (dashboard)
     nunca ligava a fusão tag↔pessoa nos tiles MJPEG (bug de wiring — `CameraWorkspace mode="tile"`
     não recebia `getReadings`/`calibrationRev`; só a câmera aberta em tela cheia e o tile WebRTC
     tinham a fusão ligada) — CORRIGIDO (`CameraWorkspace.tsx`/`CameraTile.tsx`, commit deste dia).
     Confirmado que o fix funcionou: o anel BLE (que depende da MESMA calibração/leituras) passou a
     aparecer na grade. **Mas o rótulo da pessoa segue "Pessoa `<id>`" mesmo depois do fix, mesmo
     pedindo caminhada contínua de ~10-15s sem parar** — ou seja, o problema NÃO é mais wiring, é a
     ASSOCIAÇÃO em si (`assign()`) não atingindo confiança para falar com corpo/RSSI real. Causa
     raiz AINDA NÃO diagnosticada (candidatos: `minMovement`/`windowMs` calibrados só no simulador
     não baterem com a cadência real de RSSI da estação; sinal fraco/instável na posição real da
     estação; environment com multipath pior que o assumido) — **não investigado a fundo ainda**
     porque o dono pausou o teste para seguir com a bancada de simulação. Fica pendente: quando
     houver disponibilidade, instrumentar (logar o score/correlação bruta em vez de só a decisão
     final) para achar exatamente qual guarda está barrando a fala.
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
8. 🔬 **Hungarian+dustbin — REBAIXADO de volta para GATED** (correção de sequenciamento, especialista
   2026-07-10, revisão do escopo de persistência): a taxa de conflito alta (item 7) segue sendo o
   gatilho quantitativo, mas o **custo da lixeira seria calibrado contra uma paisagem de conflictRate
   que está prestes a mudar** — o item 9 (persistência) reduz o pool ativo a cada confirmação, o que
   baixa `conflictRate` por construção. Calibrar o dustbin contra o número de HOJE seria calibrar
   contra um mundo já obsoleto quando o dustbin entrasse em produção. **Gate corrigido: construir e
   medir o item 9 primeiro → re-medir `conflictRate` com persistência ligada → só então tornear o
   dustbin com o número pós-persistência.** Desenho do custo (derivado da curva de calibração, não
   knob livre) e regra a priori (erro total ≤ baseline, cobertura ≥ baseline, sobrevive às sentinelas,
   ganho decomposto como conversão abstenção→acerto) seguem valendo, só a ORDEM mudou.
9. **Persistência de rótulo no track** (produto — não ciência, mas rodada própria tipo v4) — escopo
   escrito em `docs/cientifica/escopo-persistencia-rotulo.md`, **REVISADO E APROVADO pelo especialista
   (2026-07-10)** com 3 correções incorporadas: (i) "sem conflito" na confirmação é LOCAL ao par
   track/tag (`Assignment.hadConflict`), não o `conflictRate` agregado de tick — senão multidão nunca
   confirmaria nada; (ii) **sentinela DUPLA** — id-switch-na-confirmação E id-switch-durante-`memória`
   (o pior caso real: troca silenciosa de ID do tracker num cruzamento, sem salto físico detectável,
   persistindo até o timeout); (iii) o `timeout` do estado `memória` vem da mineração de fragmentação
   (item 10), NÃO da curva de reliability (que calibra confiança de entrada, não sobrevivência de
   crença) — **isso torna o item 10 uma DEPENDÊNCIA desta rodada, não mais um item independente**.
   Ordem de construção corrigida: (1) minerar fragmentação → (2) máquina de estados → (3) sentinela
   dupla → (4) torneio → (5) revisão adversarial. **Construção e torneio começam já** (não é física
   nova); o **DEFAULT em produção** fica condicionado a dado (ou proxy) de id-switch com gente de
   verdade — diferente do hello world solo (item 2), que não testa ambiguidade multi-pessoa.
   - ✅ **(1) mineração de fragmentação** — feita, ver item 10.
   - ✅ **(2) máquina de estados** — `src/fusion/label-memory.ts` (`LabelMemoryPolicy`), pura, 15
     testes verdes. candidata→confirmada exige N=3 ticks consecutivos de fala QUALIFICADA (margem
     ≥0,4 — bin de alta confiança do reliability diagram, mais estrito que o `minMargin` de fala do
     associador — E `hadConflict:false`, LOCAL por par, Mordida 1). Confirmada→memória quando
     evidência fresca some; memória→confirmada na reentrada (mesma barra); quebra por contradição
     sustentada (N=3 ticks de outra tag qualificada) ou por timeout (12s, candidato da mineração,
     Mordida 3) — contradição FRACA não derruba ativamente (v1, backstop é só o timeout). Morte de
     track = ausência no array de assignments → remove a crença. **Ainda NÃO** wired em
     `useTagFusion.ts`/produção (por design — torneia no harness antes; ver escopo doc).
   - ⬜ **(3) sentinela dupla** (id-switch-na-confirmação + id-switch-durante-memória, Mordida 2) —
     estender `sim.ts`/`replay-fusion.ts`. Próximo passo.
   - ⬜ **(4) torneio** com a regra a priori (métricas novas: cobertura de experiência, erro-segundos
     por estado de origem, latência de correção — ainda não existem no harness).
   - ⬜ **(5) revisão adversarial** antes de qualquer default em produção.
10. ✅🔬 **Fragmentação de tracks como proxy de id-switch — MINERADA 2026-07-10** (leitura pura de
    `server/bt/fusion-session.jsonl`, sem escrever/mover/apagar nada nele — invariante de gravação
    respeitada). Método: casar morte de track com nascimento de track NOVO próximo no tempo (≤15-30s)
    e no espaço (centro do bbox, dist≤0,15 normalizado), condicionado a `maxDisp≥0,06` durante a vida
    do track morto (ver caveat abaixo — o motivo do filtro).
    - **Achado prévio que quase contaminou a medição**: dos 312 tracks distintos vistos na câmera com
      sinal (90 min), **metade (157/312) tinha deslocamento total <0,02** (normalizado) — quase certo
      artefato de tracker sobre objeto parado/ruído, não pessoa andando. Medir fragmentação sem
      filtrar isso teria inflado o proxy com "flicker" de coisa parada (193 candidatos brutos, número
      descartado). Filtrando para tracks com movimento real (`maxDisp≥0,06`): 92 mortes de track
      "móvel" em 90 min (uma única câmera tinha sinal na janela gravada; a segunda câmera ficou vazia
      no período).
    - **Resultado condicionado**: 35-46/92 mortes de track móvel (38-50%, sensível à janela de
      casamento) acham um renascimento próximo — ou seja, a MAIORIA (50-62%) das mortes de track com
      movimento real são saídas de cena genuínas, não fragmentação. Gap temporal das que religam:
      mediana 6,5-9,1 s, p75 12,0-14,9 s, p90 13-18 s (a distribuição NÃO converge limpo ao alargar a
      janela de 15s→30s — a cauda continua crescendo, sinal de que o casamento por proximidade
      espaço-temporal é um proxy ruidoso, não uma medição definitiva).
    - **Parâmetro candidato para o `timeout` do estado `memória` (v1, a revisar com dado de campo
      real): ~12 s** — na zona mediana-a-p75 da janela de 15s (a mais conservadora/menos contaminada
      pela própria largura da janela de busca). Ordem de grandeza, não número definitivo — mesma
      ressalva que o especialista já havia registrado ("calibra a ordem de grandeza, não a verdade").
    - **Limitação honesta, registrada para não virar acidente**: (i) sem verdade anotada, não dá pra
      distinguir "id-switch real durante cruzamento de 2 pessoas" de "tracker perdeu e reencontrou a
      MESMA pessoa" — ambos os casos entram como "candidato"; (ii) a gravação disponível tinha muito
      pouca atividade humana real (grande parte dos tracks era ruído estático) — o número de eventos
      úteis é pequeno (92 mortes móveis, 35-46 candidatos) para uma estatística robusta; (iii) só 1
      câmera teve sinal na janela gravada. **O teste de campo com gente de verdade (item 2) continua
      sendo a fonte que resolveria isso de vez** — este proxy destrava a construção agora com um valor
      defensável, não substitui o dado real.
11. **Achado de código (2026-07-10, verificado por leitura, não suposição)**: o cálculo de
    margem/conflito (`associate.ts`) usa a matriz de score ESTÁTICA (pré-resolução gulosa) — um
    concorrente "fantasma" já consumido por OUTRO par ainda conta como rival. Isso **superestima**
    ambiguidade sistematicamente (nunca subestima) e pode explicar parte da taxa de conflito alta,
    em cima da colisão de assinatura 1-D. Não é bug (é simplificação defensável); registrado para
    informar a leitura do shuffle-baseline (item 7) e de qualquer refinamento futuro do dustbin.
12. **Bancada de simulação** (proposta do dono, `docs/cientifica/simulador.md`, avaliada e planejada
    2026-07-10 — plano em `C:\Users\crist\.claude\plans\peppy-wondering-garden.md`): generaliza
    `sim.ts` em World Spec JSON (mundos paramétricos, física calibrada pelos números já minerados
    nesta sessão — τ de autocorrelação, offsets regionais, viés corporal) + player visual (2 vistas
    sincronizadas) + modo de anotação que alimenta o teste de campo (item 2) via `SessionTruth`. Não
    duplica o simulador existente (generaliza `SimOpts`/`simulateFusionScenario`); risco técnico
    principal é reproduzir os 8 cenários pinados BIT-A-BIT antes de qualquer física nova (gate
    isolado, "passo zero"). **Trilha P (player, não toca `sim.ts`) pode rodar AGORA em paralelo** ao
    item 9 (persistência); **Trilha M (World Spec, mexe em `sim.ts`) espera o item 9 fechar** — dono
    único por arquivo por rodada, mesma lição do `session-loader.ts`.

### Previsões falseáveis registradas (especialista, 2026-07-10 — cobrar depois de medir)

- **(a) FALSEADA — mas por prova matemática, não fraqueza estatística** (`src/fusion/shuffle-baseline.ts`,
  2026-07-10): `shuffleConflictRate` deu **bit-a-bit idêntico** à taxa real em TODOS os cenários testados
  (canonico/multidao/bloco/cruzamento/ruido-alto) e TODOS os seeds (≥6). Motivo provado, não medido: o
  `hadConflict`/`conflictRate` (`associate.ts`) é calculado inteiramente da matriz de scores por
  (pista,tag) — nunca olha nome de tag nem verdade. Renomear tags por bijeção fixa é permutação de
  COLUNAS da matriz; margem top-2 e "houve conflito" são invariantes a qualquer permutação de colunas —
  não existe shuffle desse tipo capaz de mudar o resultado. **O desenho testado é estruturalmente cego
  a essa pergunta.** Um baseline de verdade precisaria quebrar a CORRESPONDÊNCIA FÍSICA RSSI↔trajetória
  (ex.: ruído independente da posição), não só renomear identidade — registrado como direção futura,
  fora do escopo de hoje. As funções (`shuffledScenario`/`meanShuffleConflictRate`) ficam como ferragem
  reusável para esse baseline futuro corrigido.
- **(b)** Alongar a janela de correlação (`windowMs`) derruba a taxa de conflito MAIS do que melhora a
  precisão média — ataca a colisão, não o ruído. Não testado ainda.
- **(c)** A segunda estação, quando existir, derrubará a taxa de conflito desproporcionalmente ao
  ganho de precisão — duplica a dimensão do espaço de assinatura. Gated por hardware.

### Reliability diagram SEM o corte de produção (minMargin:0) — medido 2026-07-10

Comparado à curva de produção (minMargin 0.1) nos 3 cenários mais relevantes: o corte sempre melhora
SÓ o bin mais baixo (bins 1-4 são idênticos entre cru e produção, por construção — a margem não
depende do corte, só a filtragem final depende). Onde o corte MAIS vale: `bloco` — bin 0 cru é
quase cara-ou-coroa (59,3%, n=216); com o corte de produção vira 85,0% (n=40, o maior salto dos três)
— exatamente o caso ambíguo que motivou a guarda originalmente. Em `canonico`/`multidao` o ganho é
mais modesto. `canonico` cru tem uma leve NÃO-monotonicidade nos 3 primeiros bins (80,0%→77,8%→74,3%
antes de subir) — provavelmente ruído de amostra pequena, não inversão estrutural.

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
