# Escopo — Bancada de simulação: mundos paramétricos + replay visual (v1)

> **Origem:** proposta do dono (jul/2026): "cenário em canvas como uma câmera fake, âncoras com
> posições e margem de erro, pessoas passando com tags simuladas, vários tamanhos de galpão e
> obstáculos; cruzar verdade com inferência e melhorar o modelo — simulador para
> treinamento/validação." Este doc modela essa proposta no padrão da casa (regra antes do dado,
> sentinelas, decomposição, aceite mensurável) para implementação.
>
> **Decisão de leitura nº 1, antes de qualquer código:** JÁ EXISTE um simulador (`src/fusion/sim.ts`
> + `replay-fusion.ts` + 8 cenários pinados no CI). Este escopo NÃO cria um segundo simulador —
> generaliza o gerador de mundos do que existe e adiciona uma camada de VISUALIZAÇÃO que consome
> gravações. Qualquer implementação que duplique lógica de simulação fora do motor único está
> errada por definição.

## 0. Vocabulário (obrigatório para não se enganar)

- **Verdade-terreno (ground truth):** o estado real do MUNDO SINTÉTICO (posição de cada pessoa,
  dono real de cada track, RSSI sem ruído). Existe só em gravação sintética.
- **Dado real:** o que veio do campo (sessões do `session-recorder`). Verdade só existe se anotada.
- **Inferência:** o que o associador/motor de produção diz. Existe nos dois mundos.
- "Cruzar dados reais com inferidos" (proposta original) = cruzar **verdade-terreno sintética** com
  inferência. Melhorar o modelo contra isso melhora o modelo NO SIMULADOR — a transferência para o
  campo é o *sim-to-real gap* e foi exatamente o que a v4 mediu da pior forma. Papel científico da
  bancada: **funil de hipóteses (barato, adversarial), não juiz final**. O juiz segue sendo o campo.
- **Câmera fake** = câmera **geométrica** (produz tracks/caixas via homografia), não fotométrica
  (não produz pixels). O detector/tracker real NUNCA roda sobre o canvas (§4, §10).
- **Tags são BLE** (o produto não usa RFID; nomenclatura unificada em todo o código novo).

## 1. O que já existe × o que este escopo adiciona

| Dimensão | Hoje | Com a bancada |
|---|---|---|
| Mundos | 8 cenários fixos, hardcoded | Spec declarativa JSON; famílias paramétricas (galpão, obstáculos, população) |
| Física RSSI | log-distância + ruído gaussiano iid | Parâmetros com FONTE: σ e autocorrelação [medidos], offsets regionais [medidos], viés corporal orientacional [literatura+minerado], atenuação por obstáculo |
| Tracker sintético | dropout/jitter/switch uniformes | + oclusão geométrica estruturada; switch/fragmentação condicionados a cruzamento/oclusão, taxas [mineráveis] |
| Medição | pinos por cenário (pontos) | + curvas de degradação com IC (≥20 seeds/ponto) |
| Visual | nada | Player de replay (2 vistas sincronizadas) para gravação sintética OU real |
| Verdade de campo | inexistente (protocolo espera anotação manual) | Modo anotação no player → exporta `SessionTruth` |

## 2. Arquitetura — um motor, uma gravação, três consumidores

```
World Spec (JSON) ──▶ Motor de simulação (headless, seed, determinístico)
                              │
                              ▼
                    Gravação JSONL (formato ÚNICO,
                    cabeçalho de mundo + verdade embutida)
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   Harness / CI          Player visual         Datasets de treino
 (replay-fusion,        (canvas, humano,        (futuro, §7.iii)
  torneios, curvas)      anotação)
        ▲                     ▲
        └── sessões REAIS (session-recorder) usam o MESMO formato ──┘
```

**Regras duras:**
1. O player **não simula, não re-computa inferência, não contém lógica de associação** — projeta o
   que está na gravação. O que você vê É o que o harness mediu (mesmo arquivo, mesmo bit).
2. **Cabeçalho de mundo no contrato de gravação** (extensão aditiva do contrato da rodada
   versão+knobs): sintético → `worldSpec` completo + verdade por tick; real → snapshot do
   `camcfg` (homografia, âncoras, estação) + verdade ausente/anotada. Sem cabeçalho, o player não
   tem como desenhar planta nem vista — é requisito, não nice-to-have.
3. Determinismo bit-a-bit: todo aleatório via RNG seedado (padrão já existente). Replay de replay
   é idêntico.

## 3. World Spec (a gramática dos mundos)

JSON declarativo, versionado, um arquivo por mundo. Blocos e parâmetros (fonte marcada):

```jsonc
{
  "version": 1,
  "seed": 42,
  "geometry": { "widthM": 24, "depthM": 12 },            // livre por família
  "obstacles": [                                          // polígonos no chão
    { "poly": [[...]], "rfAttenDb": 8, "occludesVision": true, "label": "máquina A" }
  ],
  "sensors": {
    "station":  { "posM": [x,y] },                        // v1: 1 estação (multi-estação é gated)
    "anchors":  [ { "mac": "...", "posRealM": [x,y], "posAssumedM": [x,y] } ],
                                                          // posAssumed ≠ posReal = erro de instalação (eixo de curva)
    "camera":   { "poseM": [x,y], "heightM": 3.2, "tiltDeg": 35, "fovDeg": 90,
                  "homographyError": { "pxSigma": 0 } }   // homografia REAL derivada da pose;
                                                          // a ASSUMIDA = real + perturbação (eixo de curva)
  },
  "population": {
    "people": [ { "id": "p1", "route": {"kind":"waypoints"|"parado"|"bloco"|"cruzamento", ...},
                  "speedMps": 1.2, "tagMac": "...", "tagPlacement": "bolso-esq|bolso-dir|peito" } ]
  },
  "physics": {
    "pathLoss":   { "n": 2.2, "rssi0": -59 },             // [chute marcado até campo calibrar n]
    "noise":      { "sigmaDb": 5.6, "tauAutocorrS": ___ },// [MEDIDO — 6h; τ da mineração]
    "regionOffsets": [ { "poly": [[...]], "offsetDb": -9 } ],
                                                          // [MEDIDO — 16 dB de spread entre âncoras]
    "bodyBias":   { "meanDb": 6, "peakDb": 18, "angWidthDeg": 100 },
                                                          // [LITERATURA 4–10 dB médio; pico ~20;
                                                          //  validar com quedas transientes mineradas]
    "readRate":   { "hz": ___, "jitter": ___ }            // [MINERÁVEL — inter-arrival real por tag]
  },
  "tracker": {
    "jitterPx": 4, "dropoutP": 0.03,
    "idSwitch": { "base": ___, "crossingBoost": ___ },    // [MINERÁVEL — fragmentação da gravação]
    "fragmentation": { "deathRebirthP": ___, "gapS": ___ },
    "structuredOcclusion": true                            // §4 — oclusão vem da geometria, não de sorteio
  },
  "inject": [                                              // injeção CIRÚRGICA p/ sentinelas
    { "atS": 12.5, "kind": "idSwitch", "tracks": ["t3","t7"] }
  ]
}
```

- **Compatibilidade retroativa obrigatória:** os 8 cenários atuais são reescritos como World Specs
  e reproduzem os pinos do CI **bit-a-bit** antes de qualquer feature nova (aceite §9.1).
- Parâmetro sem fonte entra como `[chute marcado]` visível no spec — nunca como número mudo.

## 4. Física — o que entra e o que deliberadamente fica fora

**RSSI por leitura:** `rssi = pathLoss(d) + regionOffset(pos) + bodyBias(θ, placement) −
Σ atenuação(obstáculos cruzados no segmento tag→estação) + ruído AR(1)(σ, τ)`.
θ = ângulo entre a orientação do corpo (derivada da direção de caminhada) e a linha tag→estação;
o lado do corpo onde a tag está (placement) decide quando o corpo sombreia.

**Oclusão visual estruturada:** pessoa cujo segmento até a câmera cruza obstáculo com
`occludesVision` → track em dropout enquanto durar; na SAÍDA da oclusão e em cruzamentos
próximos, probabilidade elevada de id-switch/fragmentação (é onde tracker real erra). Isso dá base
física às sentinelas da persistência — **mantendo** a injeção cirúrgica (`inject`), porque
sentinela exige o evento no instante exato, não quando a física quiser.

**Fora, com razão dita:** raytracing/multipath explícito (outro projeto; multipath é representado
honestamente como `regionOffsets` + caudas de ruído localizadas); síntese de pixels/vídeo (o
detector real nunca roda sobre canvas — simulamos o TRACKER estatisticamente, que é o que o
associador consome); 3D completo (2D + altura/tilt da câmera basta para homografia e oclusão).

## 5. Player de replay (o canvas da proposta)

- **Duas vistas sincronizadas:** planta (top-down: verdade, tracks, âncoras, estação, anéis,
  obstáculos) e vista-da-câmera (projeção pela homografia da gravação — sintética: derivada da
  pose; real: a de produção). A vista-câmera ensina intuição de oclusão/horizonte que a planta
  esconde (cheirality/anel-fantasma já mordeu uma vez).
- **Controles:** play/pause, scrubbing, velocidade (0.25×–8×), passo por tick.
- **Overlays ligáveis:** verdade-terreno (só sintético); tracks com trilha; crença tag↔track com
  os TRÊS estados da persistência (candidata/confirmada/memória — mesma gramática visual de
  produção); anéis BLE; resíduo por âncora (cores já em produção); margem top-2 do tick.
- **Timeline de eventos** (a régua embaixo): conflitos, quebras, id-switches (reais da física e
  injetados), entradas/saídas de memória, abstenções. Clicar no evento → pula o replay.
- **Live-tail** (assistir gravação em andamento): conveniência v1.5 — replay é a arquitetura.

## 6. Modo anotação — o player é o anotador do teste de campo

Com sessão REAL aberta: selecionar track → atribuir tag/pessoa → definir intervalo de validade →
exportar **`SessionTruth`** (tipo que JÁ existe e hoje só é alimentado por sintético). Saída
alimenta `replayFusionSession` sem nenhuma cola nova. **Consequência de backlog:** o item nº 1
(teste de campo) ganha a ferramenta de verdade que faltava; o roteiro de 6 min passa a ser
anotável em minutos, no sofá, depois da caminhada.

## 7. Três regimes de uso, três disciplinas

1. **Validação/regressão (headless):** famílias paramétricas — um eixo varia, ≥20 seeds por ponto,
   IC (bootstrap), **decomposição por tipo de erro obrigatória** (regra da casa). Pinos antigos
   intocados; curvas novas ganham pinos próprios quando estabilizarem.
2. **Debug/geração de hipóteses (visual):** regra anti-anedota — hipótese nascida no player só
   vira mudança de código depois de virar **cenário headless + métrica** que a captura. O olho
   propõe; o harness dispõe.
3. **Treino de modelos (futuro, quando GP/GNN/dustbin-aprendido chegarem):** só com
   *domain randomization* (treinar sob DISTRIBUIÇÃO de mundos, nunca um mundo); holdout de eixos
   de mentira (ex.: treinar sem viés corporal alto, validar com); âncoras reais permanecem
   held-out perpétuo (auditam, nunca treinam — invariante da rodada do GP); **default de produção
   só com dado real** (regra institucionalizada). O simulador poda arquiteturas; não promove.

## 8. O que a bancada permite perguntar (e as previsões já registradas)

Curvas de degradação (cada uma é pergunta de produto): precisão×nº de pessoas ("até quantas?"),
×σ de ruído, ×viés corporal, ×erro de posição de âncora e ×erro de homografia ("quão bem preciso
instalar?" → tolerância de instalação = custo de onboarding), ×densidade de obstáculos, ×tamanho
de galpão.

**Previsões falseáveis (costume da casa — para cobrar depois):**
- (a) Dropout **estruturado** produz assinatura de erro qualitativamente diferente do iid:
  id-switches concentrados em bordas de oclusão e cruzamentos, não uniformes.
- (b) A curva precisão×pessoas tem **joelho**, não declive linear — colisão de assinatura no
  espaço 1D (distância radial) domina a partir de certa densidade.
- (c) Erro de posição de âncora move **auditoria e anéis**, NÃO a precisão de identidade — a
  associação por correlação não consome posição de âncora. Se mover, há acoplamento escondido
  (bug ou suposição não documentada) e a bancada terá pago por si só.

## 9. Aceite da bancada (regra a priori — v1 está pronta quando)

1. Os 8 cenários atuais, reescritos como World Specs, reproduzem os pinos do CI **bit-a-bit**.
2. O MESMO player abre uma gravação sintética e uma sessão real existente (sem código específico
   por origem).
3. Uma família ponta-a-ponta (precisão×nº de pessoas, 20 seeds/ponto, IC) sai por um comando.
4. Uma sessão real anotada no player exporta `SessionTruth` consumido por `replayFusionSession`
   sem adaptação manual.

## 10. Fora de escopo v1 (cortes deliberados)

Síntese de vídeo/pixels; raytracing RF; física 3D completa; editor CAD de mundos (mundos são JSON
escritos/gerados — editor visual é v2 SE doer); modelos de multidão (social force) além de
waypoints+cruzamentos; tempo-real interativo como requisito (replay primeiro); multi-estação no
spec (o campo `station` já nasce extensível a lista, mas simular N estações espera o hardware e a
rodada própria).

## 11. Ordem de construção e coordenação de frentes

- **Trilha P (Player + anotação):** consome o JSONL que JÁ existe (sessões reais + saída do sim
  atual com cabeçalho mínimo). **Não toca `sim.ts` nem `associate.ts`** → pode rodar em paralelo à
  rodada da persistência. Entrega valor imediato: debug visual da gravação passiva atual +
  anotador pronto para o dia do teste de campo.
- **Trilha M (World Spec + física calibrada + famílias/curvas):** mexe em `sim.ts` — o MESMO
  arquivo que a rodada da persistência estende (sentinela dupla). **Sequenciar após a persistência
  fechar** (lição `session-loader`: dono único por arquivo por rodada). Passo zero da trilha:
  migrar os 8 cenários para specs com pinos intactos (aceite 9.1) ANTES de qualquer física nova.
- **Sinergia já paga:** a mineração de fragmentação (dependência do timeout da persistência)
  alimenta também `tracker.idSwitch/fragmentation` — uma mineração, dois consumidores.
- Cabeçalho de mundo no contrato de gravação é **aditivo** (mesma disciplina da rodada
  versão+knobs; testes tolerantes a campos aditivos — lição já institucionalizada).

## 12. Riscos nomeados (e onde este doc os mata)

| Risco | Antídoto |
|---|---|
| Segundo simulador / deriva de verdade | §2 — motor único; player não computa; gravação é a interface |
| Fidelidade visual confundida com fidelidade física | §3 — todo parâmetro com fonte `[medido]/[literatura]/[chute marcado]`; a régua é a mineração, não o olho |
| "Melhorar o modelo" = overfit ao sintético | §0, §7 — funil, não juiz; default só com dado real; sim-to-real dito com todas as letras |
| Escopo rastejante (virar CAD/jogo) | §10 — cortes explícitos; v1 é replay + curvas |
| Colisão de frentes em `sim.ts` | §11 — trilha M espera a persistência; dono único por arquivo |