# Requisitos — Localização 2D na planta da fábrica (BLE puro, sem câmera)

> **Doc vivo.** Data: 2026-07-15 · Origem: requisitos do dono (verbatim, numerados para referência).
> Define o alvo de produto da trilha `/planta-ble`. Atualizar o status a cada onda.
> Relacionados: `PENDENCIAS.md` (arco identidade-na-câmera), `spec-multi-antena-ble.md`,
> ADR-014 (RSSI absoluto morto para DECISÃO — vivo como estimativa declarada), Regras 8–13 (CLAUDE.md §6).
>
> **Nota de escopo:** este documento é sobre a trilha SEM câmera (o beacon no crachá É a identidade —
> não existe o problema de associação tag↔pessoa do arco da câmera). O problema aqui é só ONDE, não QUEM.
>
> **Atualização (2026-07-15, mais tarde):** o dono trouxe o guia do rastreamento HÍBRIDO
> (`guia-hibrido-camera-ble.md`) que RECONTEXTUALIZA estes requisitos: a câmera vira a fonte
> principal de X,Y (o que dissolve o risco §4-B dentro da área visível), o BLE fica com identidade/
> zona/redundância, e o alvo imediato vira um piloto de ~100 m². Estes requisitos permanecem válidos
> como a espec do comportamento do mapa (filtro de movimento, estados, planta navegável) e como a
> espec do modo degradado só-BLE (fora da visão da câmera).

## 1. Condições do projeto (C1–C10)

| # | Condição |
|---|---|
| C1 | Área monitorada ≈ **50 m × 50 m** (2.500 m²). |
| C2 | Ambiente com **paredes, máquinas, estruturas metálicas** e outros obstáculos que interferem no sinal. |
| C3 | **1 a 3 celulares Android** como receptores Bluetooth. |
| C4 | Cada celular **fixo, ligado continuamente, em posição conhecida** (X,Y cadastrados no mapa). |
| C5 | Celulares **na energia elétrica** (sem depender de bateria). |
| C6 | Local com **internet/Wi-Fi** para envio das leituras ao servidor. |
| C7 | Até **10 pessoas** monitoradas simultaneamente. |
| C8 | Cada pessoa com um **beacon Bluetooth DX-CP27 preso ao crachá**. |
| C9 | Beacons **só transmissores**; os celulares detectam e medem o sinal. |
| C10 | A maior parte da operação: pessoas **paradas ou permanecendo um tempo na mesma região**. |

## 2. Requisitos funcionais (R1–R11)

| # | Requisito |
|---|---|
| R1 | Exibir cada pessoa num **mapa 2D baseado na planta da fábrica**, em X,Y **em metros**. |
| R2 | Posição atualizada **em tempo real ou próximo**. |
| R3 | Precisão de **~1 a 3 metros**, principalmente com a pessoa **parada**. |
| R4 | **Estabilidade da posição quando parada** — o marcador não pode ficar oscilando ao redor do ponto real. |
| R5 | **Sem saltos instantâneos** ou deslocamentos fisicamente impossíveis entre pontos distantes. |
| R6 | Todo deslocamento representado de forma **contínua e progressiva**. |
| R7 | Considerar **velocidade compatível com pessoa caminhando**. |
| R8 | Leituras com velocidade/deslocamento incompatível com movimento humano → tratar como **ruído/erro**. |
| R9 | Respeitar os **limites físicos da planta** (paredes, corredores, áreas bloqueadas, regiões não circuláveis). |
| R10 | Baixa confiança → **preservar a última posição confiável** ou apresentar **área de incerteza** — nunca deslocar abruptamente. |
| R11 | Diferenciar, sempre que possível, **parado · caminhando · localização temporariamente incerta**. |

## 3. Status de atendimento (auditado no main em 2026-07-15)

Legenda: ✅ atendido · 🟡 parcial · 🔴 não atendido.

| # | Status | Evidência / o que falta |
|---|---|---|
| C1 | 🟡 | O modelo aceita qualquer dimensão (`Floorplan{widthM,heightM}`, `server/bt/floorplan.js`). O risco não é código: ver §4-B (cobertura de 3 receptores em 2.500 m²). |
| C2 | 🟡 | Interferência é conhecida e MEDIDA no arco (16 dB de spread entre âncoras; multipath). A resposta da casa é fingerprinting (assinatura embute o ambiente) — já existe (§3 R3). Não há modelo de paredes ainda (R9). |
| C3 | ✅ | Multi-estação no main: app com `STATION_ID` configurável + `x-station-token` (F1); store por fonte `stationId\|MAC` (`server/bt/bt-readings.js`); `GET /api/bt/readings?all=1`; auto-descoberta + cadastro (`server/bt/stations.js`, aba Estações). |
| C4 | ✅ | Planta com X,Y por antena em metros + editor interativo (arrastar no canvas / digitar na tabela) — `src/planta/useFloorplanEditor.ts`, `AntennaTable.tsx`, `PUT /api/floorplan`. |
| C5 | ✅ | Operacional (fora do software). O app já roda contínuo com POST a ~500 ms. |
| C6 | ✅ | POST HTTP à LAN/Wi-Fi + descoberta UDP do hub (`server/bt/discovery.js`); `BT_STATION_TOKEN` em produção. |
| C7 | ✅ | Sem gargalo: identidade = MAC do crachá (cadastro `bt_tags`); ingest/telas já lidam com N tags × N estações. |
| C8 | ✅ | As tags do projeto SÃO CP27/CP28 (spike 2026-07-08). **Limite físico medido: advertising ~2,2–2,5 s** (mediana, n=30.267 intervalos) — teto de informação de TODO o resto (§4-A). |
| C9 | ✅ | É a arquitetura atual (beacon TX → estação mede → hub). |
| C10 | ⚠️ | Condição registrada: é exatamente o regime onde o RSSI dá menos informação instantânea — e onde TEMPO compra precisão (média longa de pessoa parada). Guia o desenho do §5. |
| R1 | 🟡 | Existe `/planta-ble` (mapa em metros, grade, antenas, tags — `src/routes/PlantaBlePage.tsx`). **Falta**: imagem da planta da fábrica como fundo e qualquer representação de paredes/áreas (hoje o "mapa" é o retângulo W×H). |
| R2 | ✅ | Polling de 2 s (`useBleReadings`) sobre ingest de ~500 ms. Latência típica ~2–4,5 s — o teto é o advertising da tag (~2,5 s), não o software. "Próximo do tempo real" atendido **com esse teto declarado**. |
| R3 | 🔴 | **O requisito de maior risco — ver §4-B.** Hoje o X,Y é multilateração por mínimos quadrados declarada como "ESTIMATIVA DE DEMO" (`src/fusion/floorplan.ts:5-10`), com modelo path-loss **default não calibrado** (`{rssi0:-45, n:2.2}` — o hook nunca passa modelo das âncoras). O que já é confiável: **zona por fingerprinting** (`src/fusion/fingerprint.ts`, kNN em dB, leave-one-out 15/15 no dado real, margens ~30 dB entre zonas) — mas zona é discreto, não 1–3 m contínuo. |
| R4 | 🟡 | Só EMA α=0,35 por tag (`src/planta/useFloorplanMap.ts:23,105-122`) — suaviza tremor, não é estabilidade de parado (não detecta "parado", não trava, deriva com o ruído). |
| R5 | 🔴 | Só o grampo ao retângulo (`floorplan.ts:263-264`). **Não há gate de velocidade** — mudança do conjunto de antenas audíveis pode teleportar a estimativa (o EMA ameniza, não impede). |
| R6 | 🔴 | Não há modelo de movimento/interpolação no caminho vivo. |
| R7 | 🔴 | Não implementado (a constante da casa: caminhada 1,1–1,2 m/s, usada nas contas do arco). |
| R8 | 🔴 | Não implementado (é o mesmo gate de R5/R7). |
| R9 | 🟡 | Clamp ao retângulo ✅. Paredes/áreas proibidas: **o primitivo geométrico está pronto e testado sem consumidor** (`src/fusion/floor-polygon.ts` — point-in-polygon + recorte por polígono navegável; era o "set-membership ∩navegável" do ADR-012, recalibrado como item de produto). Falta modelo de dados (polígonos na planta) + UI. |
| R10 | 🟡 | Selos de confiança existem e são honestos (fix `ok/weak/none` — 1 antena NÃO vira ponto; zona `alta/media/baixa` exigindo ajuste absoluto, commit `c4b7b6a`). **Falta**: hold da última posição confiável e área de incerteza desenhada no mapa (o conceito existe na Vista 2D da câmera — anéis). |
| R11 | 🔴 | Não há classificador de estado (parado/andando/incerto) por tag. |

**Placar: 7 ✅ · 6 🟡 · 6 🔴** (+ C10 como condição de projeto). A infraestrutura de recepção
(estações, posições, ingest, cadastro, telas) está pronta; a **camada de estimação com física de
movimento humano** (R4–R8, R10, R11) não existe; e R3 é uma promessa que o rádio, como está, não faz.

## 4. Riscos físicos que a doutrina obriga a declarar (antes de prometer)

**A. O teto de informação é a tag, não o software (Regra 8).** A CP27 anuncia a cada ~2,2–2,5 s.
A 1,2 m/s, uma pessoa anda ~3 m entre leituras frescas — um "pulo" de ~3 m entre atualizações é o
piso natural do instrumento, não erro do filtro. Consequências: (i) R6 (continuidade) só se resolve
com interpolação/estado no meio, nunca com mais leitura; (ii) qualquer gate de velocidade (R7/R8)
precisa medir velocidade sobre **leituras distintas**, não sobre POSTs (83% do que o hub recebe é
cópia — dedup por `measuredAt` já existe no ingest).

**B. "1–3 m por RSSI" contraria a física já medida no projeto (R3).** O arco da câmera mediu:
âncoras equidistantes lendo 15 dB de diferença; âncora a 0,78 m lendo igual a outra a 2,05 m;
RSSI→metros foi **refutado para decisão** (ADR-014, regra institucionalizada nº 6). E a **validação
de campo da própria trilha da planta (jul/15, 3 antenas Android + 10 tags reais)** cravou o mesmo,
com números locais: o `rssi0` default (−45 dBm@1m) superestima ~3× (real medido ~−66/−70 nas 3
antenas); a curva RSSI×distância **satura em ~−80 dBm além de ~2,5 m** (plana/invertida); e há
**13 dB de espalhamento entre tags COLADAS** (ruído independente de posição — calibrar o modelo não
salva). A assinatura do erro observada: junto à parede, o eixo perpendicular fica bom (grampo) e o
paralelo vaga entre os cantos — diluição geométrica, não bug. Em 2.500 m² com metal e apenas 3
receptores, a multilateração raramente terá ≥3 antenas ouvindo a mesma tag com sinal utilizável
(fix "ok" será raro; o normal será 1–2 antenas → fix fraco). **Prometer 1–3 m uniformes por
multilateração nesta configuração é prometer o que já refutamos duas vezes.** O que a física DÁ
com este hardware:
- **Zona correta com alta confiança** (fingerprinting/antena-mais-próxima — já validado em campo:
  15/15 em 3 rodadas cegas, margens ~30–40 dB; ressalva declarada: caso fácil, 3 pontos distantes —
  o valor real exige survey com pontos intermediários);
- **X,Y contínuo indicativo** (WKNN sobre survey denso + multilateração como fallback);
- **Precisão que melhora com o tempo parado** (C10 a favor: 8 min parado ≈ n_eff 20–25 no RSSI médio,
  erro-padrão ~1,2 dB — a média longa separa o que o instante não separa);
- Perto de antena e em área com survey denso, 1–3 m é plausível; longe delas, não.
**A resposta honesta ao cliente é a curva erro×região medida em campo, não um número único.**

**C. Toda a precisão citada até hoje é de bancada/simulador.** O gate que fecha qualquer promessa é
a **caminhada anotada na planta** (§6) — o análogo da task #4 do arco da câmera, e aqui é mais
simples (não precisa de câmera: andar/parar em pontos marcados e cronometrar).

## 5. O caminho (gap → construção, na ordem de valor)

1. **G1 — Filtro de movimento por tag** (fecha R4, R5, R6, R7, R8, R10-hold, R11 de uma vez).
   Módulo puro novo (ex.: `src/fusion/motion-filter.ts`), por MAC, em cima da estimativa crua
   (multilateração/WKNN): máquina de 3 estados (**parado · andando · incerto**), limite de velocidade
   de caminhada (~1,5 m/s com margem), inovação limitada (a posição publicada anda no máximo
   v_max·Δt na direção da estimativa nova), **hold da última posição confiável** com decaimento para
   "incerto", e "parado" detectado por estabilidade da assinatura → congela a posição publicada e
   passa a fazer **média longa** (o que compra precisão no regime C10). Lição da pesquisa (tag
   `research-fusion-arc`): filtrar sim, **extrapolar não** — o motion-engine v2 perdeu por overshoot.
2. **G2 — Planta de verdade** (fecha R1, R9): imagem da planta como fundo + polígonos de área
   navegável/bloqueada no `Floorplan`, consumindo `floor-polygon.ts` (pronto); estimativa projetada
   para dentro do navegável (nunca "dentro da parede").
3. **G3 — Precisão por fingerprint denso** (ataca R3): promover o fingerprinting a fonte primária de
   X,Y — survey em grade (~5–8 m de passo; ~10 s/ponto com o fluxo atual de calibração) + **WKNN já
   implementado** (`fingerprint.ts:150-164`, top-3 com peso 1/(dist²+ε)); multilateração vira
   fallback onde não há survey. É a rota que embute multipath/metal em vez de lutar contra.
4. **G4 — Área de incerteza no mapa** (fecha R10): halo/raio proporcional à confiança (fix + fit da
   zona); estado "incerto" do G1 desenha o halo crescendo em vez de mover o ponto.
5. **G5 — Instalação medida**: posicionar os 3 receptores em diagonal, não-colineares (M4 da
   `spec-multi-antena-ble.md`; `station-geometry.ts` já avisa), com walk-test antes de fixar.

## 6. Gate de aceite (como saberemos que atendemos — Regras 8/10/11)

- **Caminhada anotada na planta**: percurso com pontos marcados no chão (posição verdadeira
  conhecida) + paradas cronometradas de 1–10 min. Reportar **erro mediano e p90 em metros, por
  região** (perto/longe de antena, com/sem survey), sempre com **n e IC de Wilson** — nunca um
  número único.
- **R5/R8**: taxa de saltos fisicamente impossíveis publicados = **0** (é invariante do filtro, não
  meta estatística).
- **R4**: desvio da posição publicada com pessoa parada ≥ 2 min ≤ raio alvo (a definir na 1ª medição).
- **R11**: matriz de confusão parado/andando contra a verdade cronometrada.
- Regra 11: cada mecanismo novo (filtro, fingerprint denso, projeção navegável) reporta **o delta
  isolado**, não só o agregado.
