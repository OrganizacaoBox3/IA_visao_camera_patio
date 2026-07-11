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
   **A mesma caminhada agora acumula TRÊS funções (especialista, 2026-07-11)**: (a) verdade anotável
   — a UI de anotação do player está pronta; (b) viés corporal real; (c) **teste direcional da
   hipótese do viés-como-feature**: num trajeto radial ida-e-volta (mesma geometria, placement
   fixo), a perna corpo-entre deve ter RSSI sistematicamente menor (esperado 4-12dB) E correlação
   RSSI×distância MAIS FORTE que a perna livre. A curva não-monotônica da bancada (viés moderado
   melhora precisão 84→90%) fica registrada como **direção CONDICIONADA a essa confirmação física —
   PROIBIDO tornear no sim antes dela** (seria a v4 com outro chapéu: mecanismo e gerador
   compartilhando o mesmo cardioide especificado); mesmo depois, o torneio exigirá sentinelas que
   quebrem o pressuposto direcional (placement sorteado por sessão, multipath descorrelacionante).
   ROI honesto do especialista: explorar a feature exige estimar orientação+placement (latentes
   novas); uma segunda estação compra dimensão de assinatura sem inferir nada.
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
     porque o dono pausou o teste para seguir com a bancada de simulação.
   - 🔬 **PLANO DE DIAGNÓSTICO definido pelo especialista (2026-07-11): instrumentar o FUNIL, não
     o score** — a decisão final é o fim de uma cadeia de vetos; o silêncio pode morrer em
     qualquer elo. Registro por tick e por par (tag,track): n_pares na janela → span temporal →
     movStd do track → r → score → margem → gate que vetou. Candidatos ordenados por
     probabilidade×discriminabilidade: (1) **cadência real** — BLE de campo (advertising+scan
     window+dedup) pode entregar menos leituras/janela que o `minSamples` assume; comparar
     inter-arrival real (a mineração das 6h tem a distribuição) com o que o associador exige — se
     n_pares morre no gate 1, nada a jusante importa; (2) **relógio/latência** — ts de chegada no
     hub + jitter desalinha os pares (rssi,dist) e dilui r; teste discriminante: cross-correlação
     com lag variável — pico de |r| em lag≠0 é assinatura de relógio, e o próprio lag é a
     correção; (3) **multipath em movimento** — σ 5,6dB foi medido em âncoras PARADAS; tag móvel
     atravessa fading espacial; assinatura: σ da tag móvel >> σ das âncoras, r subindo com janela
     maior; (4) **escala do minMovement** — calibrado em sim; homografia real pode produzir metros
     diferentes → movStd real sob o limiar com a pessoa visivelmente andando. **E o diagnóstico
     NÃO espera corpo presente**: se a caminhada frustrada foi gravada (FUSION_RECORD estava
     ligado no hub na época), o replay com o funil instrumentado roda sobre ela HOJE.
   - ✅🔬 **FUNIL RODADO SOBRE A GRAVAÇÃO REAL (2026-07-11) — ASSASSINO LOCALIZADO EM MINUTOS,
     exatamente como o especialista previu.** Ferramenta: `diagnoseFunnel()` aditivo em
     `associate.ts` (por par: n_samples → span → movVar → r → score → margem → veredito, reusando
     a MESMA matemática do assign) + `diagnoseFusionSession()` + `npm run funnel` (leitura pura do
     arquivo de campo). Resultado na câmera do teste frustrado (`cam-8a95ac6090`, H calibrada,
     18,7 min, 12 pistas):
     - **9.877 ticks×par avaliados, ZERO SPOKE** — o silêncio reproduzido offline.
     - **Histograma de vetos: lowMovement 80,5% · constantSeries 15,1% · poucos samples 4,3%.
       NENHUM par jamais chegou ao score** — o funil morre antes de existir correlação.
     - **CAUSA RAIZ: a ESCALA da homografia.** A cena inteira projeta em ~0,9×1,3 "metros" — a
       calibração foi salva em unidade errada (dimensões do retângulo não estavam em metros
       reais). `movVar` máximo da sessão INTEIRA = 0,214, contra `minMovement=0,25` (≈0,5m de
       desvio): **o gate de movimento era fisicamente impassável — o rótulo NUNCA poderia falar
       com esta calibração**, por mais que a pessoa andasse.
     - **Contraprova**: a câmera SEM calibração (`cam-6da58c2c5e`, proxy 1/bh, 147 min) FALA —
       3.329 ticks×par SPOKE, ~300 episódios de rótulo (movVar p90=2,14 no proxy).
     - **Assassino nº 2 (real, não fatal): cadência BLE** — inter-arrival mediano do batch =
       2.063ms → só ~3,9 leituras DISTINTAS por janela de 8s (o tick de 500ms repete o último
       batch; o gate de contagem passa com amostras-escada). Produz o `constantSeries` alto e
       dilui r — mas não explica o zero absoluto.
     - **AÇÕES**: (1) IMEDIATA (dono): recalibrar a `cam-8a95ac6090` com os pontos do retângulo
       em METROS REAIS — o teste de campo pode ser repetido no mesmo dia; (2) produto: validar a
       unidade no fluxo de calibração (um retângulo de <2m de lado num galpão é quase certamente
       erro de entrada — avisar na UI); (3) pesquisa: `minMovement` adaptativo à escala da cena;
       (4) `windowMs`/`minSamples` cientes da cadência real de ~2s do BLE (contar leituras
       DISTINTAS, não ticks).
   - ✅🔬 **SEGUNDA RODADA DE CAMPO (2026-07-11, mesma noite) — A FÍSICA VALIDADA E O DEFAULT
     MUDADO PELO RITO COMPLETO.** O dono recalibrou (chão visível agora projeta ~4,4×5,0m —
     escala plausível, problema de unidade resolvido) e caminhou radialmente. Sequência:
     - Funil pós-recalibração: `movVar` saltou de max 0,049 pra **max 0,228** — mas ainda ZERO
       falas: o gate `minMovement=0,25` (calibrado no galpão sintético 8×6m) continuava
       impassável numa sala real de ~4×5m. Veredito migrou de "execução" para "knob".
     - **REPLAY CONTRAFACTUAL da mesma caminhada** (sem tocar produção): com `minMovement=0,15`,
       **28 falas com correlação até -0,91** — a pista do dono casou com a tag `CE:5D`
       repetidamente. **A correlação RSSI×distância está VALIDADA COM CORPO REAL pela primeira
       vez.** A cascata a jusante se comportou (âncoras morrem honestamente em série-constante;
       margem filtra empates); a cadência BLE de ~2s não impediu corr forte com movimento amplo.
     - **Torneio sintético da mudança** (12 cenários): 0,15 é NEUTRO no agregado (73,0%=73,0%);
       `parado` segue 100% abstenção (o caso que o knob protege — variância de gente parada é ~0);
       custo localizado: bloco 82,0→80,0%, falseLabels +1-2 em 3 cenários.
     - **DEFAULT MUDADO: `minMovement` 0,25→0,15** (`associate.ts` + espelho no
       `session-recorder.js`), com evidência dupla (campo + torneio) e re-pinagem consciente dos
       gates afetados (`replay-fusion.test.ts`: bloco/grade-sem-station/ancoras-multidao*;
       `persistence-tournament.test.ts`: PINS re-medidos — o quadro qualitativo do torneio da
       persistência NÃO mudou: ratio 0,68 vs 0,67, v1 segue reprovada).
     - **Falta para fechar o hello world**: o dono repetir a caminhada COM o default novo no ar
       (rebuild/restart do front) e ver o rótulo na tela; gravar; anotar no player; processar
       (task #4). A hipótese direcional (perna corpo-entre vs livre) pode ser testada na mesma
       gravação.
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
   - ✅🔬 **(3) sentinela dupla — FEITA e a Mordida 2 COMPROVADA, não só implementada**
     (`src/fusion/sim.ts` ganhou `forceSwitchAt` — troca determinística de trackId, sem RNG, no
     tick exato que o chamador escolher, byte-compat quando ausente; `src/fusion/
     persistence-sentinel.ts` acha o instante certo por replay-e-descobre: confirma → procura
     proximidade física real entre as 2 pessoas numa janela — só injeta quando acha um tick
     "sem salto", senão devolve `null` honesto). 6 testes verdes, **cenário determinístico
     (seed=1, "cruzamento")**: sentinela 1 (id-switch na confirmação) injeta no tick 6 — a crença
     CONFIRMA o rótulo ERRADO já ao nascer (a evidência que fecha a confirmação vem de antes da
     troca) e segue errada por ≥4 ticks medidos; sentinela 2 (id-switch durante memória, sustain=4
     ticks) injeta no tick 76 — crença errada por ≥10 ticks medidos, corrigindo só no tick 95 (9,5s
     depois da injeção) — **mais lento que a sentinela 1**, na direção que a previsão do
     especialista registrava (memória é o pior caso). Números fixos/reproduzíveis, não achados por
     sorte — documentados no teste.
   - ✅🔬 **(4a) métricas novas — FEITAS e a previsão do especialista CONFIRMADA quantitativamente**
     (`src/fusion/memory-metrics.ts`, 9 testes): `computeMemoryMetrics` (cobertura de experiência —
     tempo, não tick, pesado por delta real de `ts` — + erro-segundos decomposto fresco×memória) e
     `computeCorrectionLatencies` ("da quebra real até a tela parar de mentir", por episódio
     contíguo de desacordo crença×verdade). Medido nas duas sentinelas (seed=1, "cruzamento"):
     erro-segundos-em-memória da sentinela durante-memória (14,5s) é **mais que o DOBRO** da
     sentinela na confirmação (6s) — exatamente a direção prevista (memória é o pior caso, mais
     tempo pra exibir errado sem correção precoce). Números fixos, reproduzíveis, no teste.
   - ✅🔬🔴 **(4b) torneio — RODADO, e a v1 (defaults atuais) NÃO PASSA a regra a priori em
     agregado** (`src/fusion/persistence-tournament.test.ts`, 13 testes, PINS honestos — não
     forçados a passar). Suíte inteira (12 cenários) medida, baseline (associador cru, sem
     persistência) × com-memória, mesma unidade de tempo:
     - **Eixo 1 (erro-segundos ≤ baseline): PASSA.** Agregado 209 000ms → 95 500ms.
     - **Eixo 2 (cobertura de experiência ≥ N× baseline, N≥1): FALHA.** Agregado 20,84% → 13,88%
       (multiplicador ≈0,67× — CAIU, não subiu).
     - **Causa raiz (achada pela quebra por cenário, não chutada)**: em multidão
       (multidao/ancoras-multidao/ancoras-multidao-bias/ancoras-mismatch-n), a barra de
       confirmação (`confirmMargin:0,4` por `confirmTicks:3` consecutivos) é estrita demais pro
       regime de correlação mais ruidoso desses cenários — o track NUNCA confirma, e a memória
       fica ZERADA (0% cobertura, 0 erro) exatamente onde o baseline por-tick conseguia acertar
       OCASIONALMENTE (16-25% de cobertura ali). A decomposição por transição confirma que o
       canal legítimo existe (abstenção→acerto: 239 500ms, >>10× a regressão correto→errado: só
       8 000ms) — o mecanismo NÃO está "quebrado", só está OTIMIZADO para o caso simples
       (canonico/sem-calibração melhoram) e mal-calibrado pro caso denso.
     - **CONCLUSÃO, sem meias-palavras: v1 como está NÃO é candidato a default.** Precisa de
       retuning dos parâmetros de confirmação (ex.: barra adaptativa à densidade da cena, ou
       `confirmMargin` mais permissivo com `confirmTicks` maior compensando) numa PRÓXIMA rodada
       de torneio — não decidido aqui por chute; fica registrado como o próximo passo real antes
       de (5). Mesma disciplina do v4: achado negativo documentado com a mesma força que um
       achado positivo, nada escondido.
   - ⬜ **(4c) retuning — PLANO DEFINIDO pelo especialista (2026-07-11): mudar a VARIÁVEL da
     barra, não o número.** A falha de multidão não é "0,4 é alto demais" — é que margem absoluta
     é um proxy cuja taxa de câmbio varia com o regime (densidade comprime margens). Plano:
     (1) estratificar a curva de reliability por regime (estratificador mais barato: nº de
     candidatos avaliáveis no tick; binário denso/esparso já serve); (2) a barra vira
     **"precisão-implicada ≥ P\* por K ticks de fala qualificada"** — se margem 0,22 em multidão
     historicamente entrega 93% de acerto, ela confirma em multidão (a adaptatividade EMERGE da
     condicionalização, sem função ad-hoc de nº de tags); (3) grade de busca sobre (P\*, K) ∈
     {0,90; 0,95; 0,98} × {2; 3; 4} — 9 células, regra a priori como filtro, dois parâmetros com
     semântica probabilística em vez de dois números mágicos; (4) **emenda v2 da confirmação
     (nascida do achado "crença nasce já errada")**: janela de confirmação LIMPA — nenhum evento
     de proximidade <0,4m entre os K ticks que a fecham (ataca o modo de nascimento tóxico,
     custa quase nada de cobertura). **Previsão registrada do especialista**: com a barra
     condicionada, a confirmação volta a fechar em multidão e a cobertura de experiência supera
     o baseline por-tick no agregado mantendo erro-segundos abaixo — porque a decomposição
     (abstenção→acerto 239.500ms >> correto→errado 8.000ms) diz que o defeito é de câmbio, não
     de motor. Se nem assim houver célula que satisfaça os dois eixos em todos os regimes, ISSO
     é a evidência de que o denso exige política própria. Retornar ao torneio (4b) — régua
     pinada em `persistence-tournament.test.ts`.
   - ⬜ **(5) revisão adversarial** antes de qualquer default em produção — só depois de (4c) e um
     torneio que passe os dois eixos da regra a priori.
   - 🔬 **Diagnóstico unificador (especialista, 2026-07-11)**: a falha da persistência em multidão
     e a refutação da previsão (b) são o MESMO fenômeno — densidade comprime margens; a margem
     alimenta tanto a fala quanto a confirmação; num sistema com abstenção, colisão vira SILÊNCIO,
     não erro (por isso wrongRate satura e quem sangra é a cobertura). **Corolário verificado
     (2026-07-11, dados da família ×pessoas já medida)**: a cobertura decai GEOMETRICAMENTE —
     razão consecutiva 0,846±0,030 (quase constante, 2→7 pessoas), ~15%/pessoa adicional.
     Não-linear em nível (exponencial), coerente com colisão comprimindo margens continuamente,
     mas SEM joelho/limiar crítico. O corolário do especialista ("a não-linearidade deve estar na
     cobertura") fica confirmado na forma exponencial, não na forma de quebra de regime.
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
    - ✅ **Fase 0 (Trilha P)** — feita: núcleo puro do player (`src/fusion/player/`) + rota `/replay`
      navegável (canConfigure), 18 testes. Ver commits de 2026-07-10.
    - ✅🔬 **Fase 1, passo zero (Trilha M) — FEITA, aceite §9.1 confirmado** (`src/fusion/
      world-spec.ts` + `world-spec.test.ts`, 13 testes): `WorldSpecV1` (JSON declarativo) → tradução
      pura pra `SimOpts` → MESMA `simulateFusionScenario` de sempre (decisão de baixo risco:
      NÃO reescreveu o miolo do gerador nem a ordem de consumo do RNG — só uma camada de tradução em
      cima). Os 12 cenários pinados de `FUSION_SCENARIOS` reproduzem **bit-a-idênticos** (`toEqual`
      profundo, não só métricas agregadas) pelo caminho novo. **Ainda NÃO tem física nova** — nenhum
      parâmetro aqui é "medido"; são os MESMOS defaults de sempre, só em JSON. A Fase 2 (física
      calibrada com os números já minerados nesta sessão — τ autocorrelação 0,49-0,94/2s, spread de
      offset regional ~16dB, viés corporal ~12dB médio validado contra quedas transientes, timeout
      de fragmentação ~12s) é o próximo passo — SÓ ali os dados reais/medidos entram de fato.
      Sequenciada corretamente: só começou depois que a rodada de persistência (item 9) pausou.
    - ✅🔬 **Fase 2, primeiro incremento — ruído RSSI autocorrelacionado (AR(1)), calibrado pelo τ
      medido** (`sim.ts`, knob `rssiNoiseTauS`, opt-in — ausente = IID, byte-compat total, os 12
      cenários pinados seguem intactos). Honestidade sobre a calibração: a mineração das 6h reais
      deu autocorrelação de 0,49-0,94 NUM LAG de 2s — invertendo ρ(Δt)=exp(-Δt/τ) pros dois extremos
      dá τ≈2,8s a τ≈32s, uma faixa LARGA (a mineração cobriu regimes de obstrução bem diferentes por
      âncora); por isso **não** cravamos um default único escondendo essa incerteza — quem liga o
      knob escolhe o τ explicitamente. 3 testes novos: controle positivo (regra institucionalizada
      nº4 — sem o knob, autocorrelação empírica ≈0, prova que SEM ele é IID de verdade) + a
      autocorrelação COM o knob bate a fórmula teórica (ρ=exp(-Δt/τ)) dentro de margem + byte-compat
      confirmado. Só se aplica ao RSSI de PESSOA por ora (âncoras seguem IID — limitação declarada,
      não medida ainda pra elas). Restante da Fase 2 (offsets regionais, viés corporal direcional,
      oclusão estruturada) segue pendente — próximos incrementos, mesmo padrão (opt-in, fonte
      marcada, byte-compat).
    - ✅🔬 **Fase 2, segundo incremento — offsets REGIONAIS por polígono (não achatado por
      emissor, por pedido explícito do dono)** (`sim.ts`, knob `rssiRegions`, opt-in): reusa
      `pointInPolygon` de `floor-polygon.ts` (mesmo primitivo do ∩navegável, sem duplicar
      geometria) — dentro de um polígono soma o `offsetDb` daquela região (pessoas E âncoras;
      regiões sobrepostas SOMAM, não "a primeira que bater"). FONTE: `rssi0` implícito variou
      16dB entre as 4 âncoras da calibração real (`relatorio-consolidado-2026-07-10.md` §4) —
      evidência de que um modelo único de propagação pro espaço inteiro é pobre. O MECANISMO está
      pronto e testado; os polígonos/deltas de uma família calibrada ficam pra Fase 3.
    - ✅🔬 **Fase 2, terceiro incremento — viés corporal DIRECIONAL** (`sim.ts`, knobs `bodyBias`+
      `tagPlacement`, opt-in, por pedido explícito do dono de fazer o modelo completo, não só a
      profundidade média): ângulo entre o heading (direção de caminhada, proxy da orientação do
      corpo) e a linha tag→estação, mais o lado do corpo (`peito`/`bolso-esq`/`bolso-dir`) —
      pior caso (`peakDb`) quando o corpo bloqueia a linha de visão, piso (`meanDb`) quando a tag
      encara a estação, `angWidthDeg` controla a largura da zona de sombra. Pessoa PARADA (sem
      heading real) usa só o piso — decisão explícita de não inventar orientação sem movimento.
      FONTE: `meanDb`/`peakDb` cruzam literatura (4-10dB médio, pico ~20dB) com a profundidade
      medida nas quedas transientes das 6h reais (~12dB médio); `angWidthDeg` é `[chute marcado]`
      até o teste de campo calibrar — marcado como tal, não escondido. 12 testes novos (unitários
      da função pura `bodyBiasDb` + integração ponta-a-ponta) provam: pior/melhor caso batem
      `peakDb`/`meanDb`; a colocação da tag rotaciona a direção efetiva; o valor nunca extrapola
      o intervalo [meanDb, peakDb]; pessoa parada usa só o piso; byte-compat quando ausente.
    - ✅🔬 **Fase 2, quarto e ÚLTIMO incremento — oclusão ESTRUTURADA (obstáculos)** (`sim.ts`,
      knob `obstacles`, opt-in, por pedido explícito do dono de fechar a Fase 2 inteira nesta
      sessão): polígonos de mundo com dois papéis independentes por obstáculo — `occludesVision`
      (dropout ESTRUTURADO, determinístico: segmento pessoa→câmera cruza o polígono → o tracker
      simplesmente não vê, mesmo efeito de `dropoutP` mas pela geometria, não sorteio) e
      `rfAttenDb` (atenuação de RF somada ao RSSI quando o segmento pessoa/âncora→estação cruza —
      múltiplos obstáculos cruzados SOMAM, mesma convenção de `rssiRegions`). Reusa
      `segmentIntersectsPolygon` (novo primitivo puro, algoritmo clássico de interseção de
      segmentos) contra as arestas do polígono. 8 testes novos (primitivo de interseção + bloqueio
      de visão + atenuação de RF isolada + soma de múltiplos obstáculos + byte-compat).
      **FORA DE ESCOPO v1, documentado no código, não escondido**: o acoplamento "id-switch
      elevado na SAÍDA da oclusão" que `simulador.md` §4 propõe fica pra uma rodada futura — exige
      estado extra (há quanto tempo a pessoa estava oculta) que este incremento não adiciona;
      `idSwitchOnCross` (proximidade física) segue sendo o único mecanismo de id-switch hoje,
      independente deste knob.
    - **FASE 2 COMPLETA** — os quatro incrementos de física medida (ruído AR(1), offsets
      regionais, viés corporal direcional, oclusão estruturada) estão prontos, testados (73 novos
      testes em `sim.ts`/`sim.test.ts` ao todo nesta rodada) e **todos** byte-compat com os 12
      cenários pinados (nenhum default mudou). Nenhuma família/curva calibrada foi criada ainda
      com eles — isso é Fase 3 (famílias paramétricas, ≥20 seeds/ponto, IC — próximo passo natural
      quando houver prioridade pra isso) ou o teste de campo real decidindo os valores finais.
    - ✅🔬 **Fase 3, primeira leva (2 frentes paralelas, propriedade exclusiva de arquivo)**:
      - **(A) Famílias paramétricas** (`src/fusion/families.ts`, 6 testes): `runFamily()` — um
        eixo varia, seeds determinísticos 1..N (default 20, §7.1), IC 95% por bootstrap percentil
        (LCG próprio seedado, zero Math.random), decomposição por tipo de erro OBRIGATÓRIA
        (wrong/falseLabels/idSwitches junto de precisão/cobertura). Cada célula é literalmente
        `replayFusion(simulateFusionScenario(...))` — motor único, nada reimplementado. Primeira
        família concreta: `FAMILY_PRECISION_VS_PEOPLE` (people 2..7). CI roda eixo reduzido; a
        curva completa fica atrás de `FAMILY_FULL=1`.
      - **🔬 Previsão (b) do escopo ("a curva precisão×pessoas tem JOELHO") — ⚠️ LEITURA
        RETIFICADA pela revisão adversarial da Fase 4 (2026-07-11)**: a leitura original deste
        item ("wrong acelera 10→87, o joelho aparece na decomposição") NÃO sobreviveu à
        normalização — o crescimento era majoritariamente do DENOMINADOR (nº de decisões cresce
        ~3,5× no eixo). Normalizado, `wrongRate` SATURA (2,4%→5,3%→platô ~5,5%), curva côncava —
        o oposto de aceleração; e `people=2` é incomparável (1 tag → swap impossível). **Veredito
        corrigido: previsão (b) mais próxima de REFUTADA** — o que degrada com densidade são
        cobertura (41%→17,7%) e precisão (89,6%→72,2%), em declive suave. Ironia registrada: a
        leitura errada usou a bandeira da "regra da decomposição" enquanto caía na armadilha da
        contagem absoluta — a regra certa é decompor EM TAXAS quando o eixo muda o nº de
        oportunidades. Correção estrutural: `FamilyPoint` agora carrega `wrongRate`/`swap`/
        `opportunities` (a armadilha não se repete).
      - **(B) Modo anotação — núcleo puro** (`src/fusion/player/annotation.ts`, 10 testes):
        estado imutável de anotação (trackId → mac|null|ausente — os TRÊS estados de
        `SessionTruth` preservados), export com MAC normalizado, import pra retomar sessão,
        resumo pra UI futura. SEM UI de propósito: o player ainda não abre gravação real, e
        anotar sintético não faz sentido (a verdade já nasce pronta lá). É a ferramenta que
        faltava pro dia do teste de campo (item 2) — anotar o roteiro de 6min em minutos.
      - ✅🔬 **Fase 3, segunda leva (2 frentes paralelas, 2026-07-11)**:
        - **3 famílias novas** (`families.ts`): ×ruído (rssiNoiseDb 2..12 — degrada suave, 95,2%→
          55,1%, sem joelho), ×viés corporal (⚠️ RETRATADA E RE-MEDIDA — ver revisão adversarial
          da Fase 4 abaixo: a curva original "84%→14,7%" mediu um mundo com o SINAL do viés
          invertido; a curva correta é NÃO-MONOTÔNICA: 84%→~90% em 4-12dB → 80,4% em 24dB)
          e ×erro de cadastro de âncora. Knob novo `anchorPosErrorM` em `sim.ts`
          (modela posAssumed≠posReal do §3 — desloca SÓ o cadastro exportado, física intacta,
          byte-compat).
        - **🔬 PREVISÃO (c) DO ESCOPO — CONFIRMADA COM NÚMEROS** ("erro de posição de âncora move
          auditoria e anéis, NÃO a precisão de identidade; se mover, há acoplamento escondido"):
          curva completa (20 seeds/ponto), precisão **86,5% em TODOS os 5 pontos** (0 a 2m de
          erro), decomposição bit-idêntica. Coerente com gate/blend OFF por default: a correlação
          não consome posição de âncora. O teste roda em CI comparando os ICs dos extremos — se um
          dia gate/blend voltarem aos defaults e criarem o acoplamento, este teste FALHA com
          mensagem "ACHADO: acoplamento escondido" (sensor permanente, mesma família das
          sentinelas de viés do v4).
        - **Comando ponta-a-ponta (aceite §9.3 ✅)**: `npm run family -- <nome>` (scripts/
          family.mjs — spawna o vitest com FAMILY_FULL=1, sem dependência nova) imprime a curva
          completa com IC + decomposição. Sem argumento lista as 4 famílias.
        - **Player abre GRAVAÇÃO REAL (aceite §9.2 parcial ✅) + UI de anotação (§6 ✅)**
          (`ReplayPlayerPage.tsx` + `player/session-view.ts` novo, 12 testes): .jsonl lido 100% no
          cliente (LGPD — nada sobe), domínio da planta calculado do bounding box real (fallback
          8×6), painel de anotação (track → MAC/sem-tag/limpar, os 3 estados de SessionTruth),
          export/import por download local manual (padrão cine-loop). Anotar pinta o track no
          replay na hora. Limitações declaradas: enquadramento pelos primeiros 2000 ticks; lista
          de tracks sem virtualização (gravações de horas ficam pesadas de rolar, não travam).
      - **Restante da Fase 3/4**: pino das curvas quando estabilizarem (§7.1), aceite §9 formal
        (o §9.4 — SessionTruth anotado consumido por replayFusionSession sem adaptação — está
        construído mas nunca exercitado com gravação real de verdade: falta o teste de campo),
        e revisão adversarial da bancada (§12/Fase 4 do plano).

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
