# Checklist de entrada de sensor no motor de fusão (ADR-013, item 5)

> UMA página. Todo sensor novo (2ª antena BLE, AoA, UWB, mmWave, …) entra pela MESMA porta do BLE
> de hoje respondendo às três perguntas abaixo e cumprindo o rito. Se a resposta exigir mexer no
> MOTOR (associate.ts e afins) em vez de escrever um adapter, a interface está errada — pare e
> revise o ADR-013 antes de codar.

## 1. Que evidência o sensor emite?

Declare, ANTES de escrever código, no vocabulário de `src/fusion/evidence.ts`:

- **`MeasurementKind`** — a NATUREZA da medição: `position2d` · `range` · `bearing` ·
  `identity-series` (escalar correlacionável no tempo, o RSSI de hoje) · `identity-claim`
  (ID embutido no pacote, ex. UWB). Um tipo NOVO só nasce se um sensor real o exigir (YAGNI).
- **Em que eixo vota (QUEM × ONDE) e com que força** — ex.: BLE-RSSI 1 antena = QUEM forte /
  ONDE quase nada; AoA = ONDE médio-forte / QUEM no pacote; UWB = fortíssimo nos dois;
  mmWave = ONDE forte / QUEM zero (substitui a câmera no eixo ONDE, não o BLE no QUEM).
- **Incerteza típica** (`sigma`, na unidade da medição) — de datasheet + medida em campo. Quando a
  primeira fonte POSICIONAL real entrar, `sigma` deixa de ser opcional no contrato (decisão
  registrada em `evidence.ts`).

## 1.5 GEOMETRIA DE INSTALAÇÃO (Δ3 do especialista — pré-requisito que mata o piloto em silêncio)

> Vale para todo sensor cuja evidência de identidade dependa de **variação** (o BLE-RSSI de hoje).

- **O receptor vai NO DESTINO ou ATRÁS dele, sobre o EIXO do caminho dominante de aproximação.**
  Caminhar até a mesa = caminhar em direção ao receptor = gradiente radial máximo (a inclinação da
  log-distância é máxima perto do receptor — ~0,9 década de span numa aproximação 8→1 m, vs 0,42
  medido com a estação junto da câmera).
- **PROIBIDO instalar ao LADO da mesa**: a aproximação vira tangencial ao receptor → variação
  radial ≈ 0 → a identidade NUNCA fecha, e a equipe passa semanas investigando o algoritmo enquanto
  o bug está no suporte da parede. É o modo de falha mais perigoso porque é silencioso.
- **Otimizável no simulador ANTES de furar parede**: simular os caminhos reais de aproximação
  contra posições candidatas de receptor e maximizar o span radial esperado (em décadas). É
  geometria pura — uso legítimo da bancada, sem risco de circularidade (não envolve o modelo de
  RSSI, só a trajetória e a distância). Ver ADR-014 item 7.

## 2. Qual adapter escreve — e onde?

- **Fonte de identidade (o caso BLE de hoje):** o adapter emite `RawReading` (`src/fusion/frame.ts`)
  com `sourceId` (o id físico da fonte — no BLE é o `stationId`, nome mantido por retrocompat) e
  grava na sessão com `sourceKind` próprio (ver o evento `"ble"` em `server/bt/session-recorder.js`
  — sensores novos ganham evento próprio ou reutilizam o shape, sempre ADITIVO ao JSONL).
- **Fonte posicional futura (UWB/AoA/mmWave):** entra como tipo de linha NOVO na gravação (o loader
  tolera tipos desconhecidos por contrato) + adapter que emite a evidência tipada com `sigma`
  obrigatório. É a SEGUNDA fonte posicional independente que destrava o factor graph (ADR-013,
  item 6) — antes dela, não construir solver.
- Fusão de identidade multi-fonte: soma de Fisher-z com gate por n_eff (ADR-013, item 4) — o mesmo
  código para N antenas ou qualquer mistura; hardware melhor só passa mais rápido pelo MESMO gate.

## 3. Rito de homologação (nenhum passo é pulável)

1. **Gravar** sessão de campo com o sensor ligado (`FUSION_RECORD`, formato JSONL do
   session-recorder — só metadados, LGPD/ADR-002) + verdade-terreno anotada pós-coleta.
2. **Replay** no harness (`src/fusion/session-loader.ts` → `replayFusionSession`): o associador DE
   PRODUÇÃO roda sobre o dado real pelo mesmo caminho do gate sintético.
3. **Torneio com regra a priori** — critérios PINADOS ANTES de olhar o resultado (padrão da 2ª
   antena: precisão(A+B) ≥ máx(A,B), cobertura ≥ 1,5×, conflito ≤ 0,6×).
4. **Sentinela adversarial** que VIOLE o pressuposto físico que o simulador compartilha com o motor
   (ex.: para RSSI, corpo bloqueando o rádio enquanto a pessoa se aproxima — se sim e campo
   discordam, o campo manda).
5. **Decomposição por tipo de erro** (falso-rótulo × abstenção × troca) — não só a métrica agregada.
6. **Só então** o sensor entra no default de produção.

## Métrica de universalidade (ADR-013, item 7)

Ao plugar o sensor, conte **quantas linhas do MOTOR mudaram** (associate.ts + fusão — adapters e
gravação não contam). Previsão registrada do especialista: **~zero** (adapter + fusão de z, mais
nada). Se deu mais que isso, a interface vazou — registrar em ADR antes de seguir.
