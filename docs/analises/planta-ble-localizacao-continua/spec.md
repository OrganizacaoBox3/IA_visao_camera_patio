# Especificação — localização contínua na Planta BLE

> **Status:** em implementação  
> **Rota:** `/planta-ble`  
> **Fonte da verdade desta mudança:** este documento  
> **Trilha:** `spec.md` → `plan.md` → `tasks.md` → implementação → `resultado.md`

## 1. Objetivo

Exibir a posição estimada dos beacons de forma contínua e tecnicamente honesta dentro da planta,
sem deslocá-los artificialmente para uma antena, zona ou mesa. A tela deve distinguir:

1. a **medição** recebida das antenas;
2. a **posição contínua inferida** em metros;
3. a **classificação de zona** por semelhança de sinal;
4. a **geometria conhecida** das áreas de trabalho;
5. a **distância estimada** entre a posição do beacon e uma área de trabalho.

Uma zona pode indicar proximidade provável, mas não pode determinar à força a coordenada desenhada.
Da mesma forma, proximidade ou permanência perto da mesa não prova que uma pessoa está trabalhando.

## 2. Problema observado

Tags colocadas fisicamente no centro do triângulo formado pelas três antenas são desenhadas nas
laterais ou nos cantos da área. A interface atual apresenta esse resultado como uma coordenada firme,
apesar de a geometria calculada ser incompatível com a planta.

O problema não é a posição visual da mesa. O ponto é produzido pelo modelo de distância baseado em
RSSI, extrapolado muito além da escala física da planta, e depois limitado silenciosamente ao retângulo.
A classificação por fingerprint já produz uma coordenada contínua, mas a tela usa apenas seu rótulo de
zona e continua desenhando a saída geométrica limitada.

## 3. Baseline reproduzível — 2026-07-15

### 3.1 Ambiente configurado

- Planta: `3 m × 5 m`.
- `tc22`: `(1,4347258485639685; 5)` m.
- `tc22-0963`: `(3; 0)` m.
- `tc22-70a3`: `(0; 0)` m.
- Amostra `Mesa serigrafia`: `(1,5; 2,5)` m.

### 3.2 Por que a multilateração colapsa nas bordas

O modelo global vigente usa aproximadamente:

```text
d(rssi) = 10 ^ ((-45 - rssi) / (10 × 2,2))
```

Assim, um sinal perto de `-80 dBm` vira aproximadamente `39 m`, embora a maior dimensão da planta seja
`5 m`. Para as antenas inferiores, separadas por `W = 3 m`, a coordenada horizontal obtida por diferença
de círculos é:

```text
x = (W² + d_esquerda² - d_direita²) / (2W)
  = (9 + d_esquerda² - d_direita²) / 6
```

Para `x` permanecer no intervalo físico `[0; 3]`, é necessário:

```text
|d_esquerda² - d_direita²| ≤ 9 m²
```

Perto de `-80 dBm`, apenas `1 dB` de diferença altera a distância ao quadrado em centenas de metros
quadrados. Isso excede em mais de uma ordem de grandeza o intervalo admissível de `9 m²`. Leituras a
partir de aproximadamente `-89 dBm` ainda atingem o teto legado de `100 m`, agravando a degeneração.
Portanto, a saída externa seguida de limitação à borda é uma consequência determinística do modelo,
não uma oscilação visual eventual.

### 3.3 Evidências do snapshot

| Tag | RSSI `[TC22, TC22-70A3, TC22-0963]` | Coordenada bruta | Após limitação legada | Residual aprox. |
|---|---|---:|---:|---:|
| `CE3C` | `[-85, -79, -94]` | `(-1459,69; 111,97)` | `(0; 5)` | `1398,6 m` |
| `CE5C` | `[-91, -81, -83]` | `(-160,87; -763,75)` | `(0; 0)` | `717,3 m` |
| `CE89` | `[-95, -79, -83]` | `(-267,70; -797,19)` | `(0; 0)` | `780,6 m` |
| `CE8B` | `[-96, -82, -84]` | `(-198,68; -709,27)` | `(0; 0)` | `669,8 m` |

Até o fingerprint do centro, aplicado ao modelo geométrico legado, gera aproximadamente
`(51,7; -881,3)` e termina limitado a `(3; 0)`, com residual de cerca de `828,9 m`.

No mesmo snapshot, a interpolação WKNN dos fingerprints existentes produziu posições entre cerca de
`0,06 m` e `0,37 m` do centro da mesa. Isso é somente um **teste de sanidade**, não uma medida de
acurácia: o ponto central também pertence ao conjunto de treino e ainda não há holdout de campo.

### 3.4 Limitações de evidência atuais

- O texto “84 leituras” não implica 84 medições independentes. O polling pode repetir a última leitura
  entre atualizações do sensor.
- A captura atual pode incluir leitura anterior ao início da captura e repetições com correlação `ρ = 1`.
- A agregação perde identidade da tag e instante da medição; um vetor pode combinar sinais medidos em
  instantes materialmente diferentes.
- O desvio-padrão salvo nos fingerprints não participa da distância estatística.
- A confiança geométrica considera principalmente a quantidade de antenas e descarta o residual.
- A histerese atual conta polls, não necessariamente novas observações BLE.

Pela Regra 8 do guia, toda estatística deve respeitar `nEff ≤ nDistinct`. Nenhuma afirmação de
estabilidade pode usar polls repetidos como evidência adicional.

## 4. Modelo conceitual obrigatório

```text
leituras brutas com tempo
        │
        ├── classificação de zona ───────────────► rótulo provável
        │
        └── estimativa contínua X,Y ─► movimento ─► posição + incerteza
                                                │
geometria independente das áreas ──────────────┴► dentro/fora + distância
```

### 4.1 Invariantes

- **I01 — Sem encaixe forçado:** rótulo de zona ou proximidade de mesa nunca sobrescreve `x,y`.
- **I02 — Medição ≠ inferência:** RSSI e timestamps permanecem distinguíveis das estimativas derivadas.
- **I03 — Evidência distinta:** uma amostra repetida não aumenta `nDistinct`, `nEff` ou estabilidade.
- **I04 — Sem falsa precisão:** geometria inválida não vira ponto firme por limitação silenciosa.
- **I05 — Tempo coerente:** sinais combinados em um vetor pertencem a uma janela temporal declarada.
- **I06 — Case canônico:** identificadores de antena são comparados sem sensibilidade a maiúsculas,
  preservando o nome original apenas para exibição.
- **I07 — Honestidade operacional:** proximidade/permanência é indício de presença, não prova de trabalho.
- **I08 — Dados de campo imutáveis:** nenhuma gravação real é apagada ou reescrita nesta mudança.

## 5. Requisitos funcionais

### R01 — Evidência temporal íntegra

Cada leitura utilizada por captura, classificação ou posição deve carregar `measuredAt` e, quando
disponível, o identificador da tag. Capturas aceitam apenas evidências posteriores ao início e
deduplicam por estação, tag e instante medido.

### R02 — Vetor ao vivo fresco e sincronizado

Um vetor ao vivo só combina estações dentro do limite de idade e de dispersão temporal configurado.
Quando não houver evidência suficiente, o sistema deve declarar ausência/baixa confiança, sem reutilizar
silenciosamente um vetor antigo como se fosse atual.

### R03 — Captura representativa

A captura deve agregar tags e estações de modo robusto e balanceado, reportando leituras recebidas,
leituras distintas, janela temporal e estações efetivas. O número visível deve ser `nDistinct`, não o
número de polls.

### R04 — Fingerprinting sem singularidade

A distância entre vetor vivo e fingerprint deve considerar cobertura, variabilidade salva e um piso de
variância. Pesos devem ser limitados, sem singularidade `1/0`. Amostras repetidas do mesmo rótulo não
podem ganhar votos ilimitados apenas por quantidade.

### R05 — Zona e posição independentes

O classificador pode emitir `label`, margem e confiança. A interpolação pode emitir `pos` contínua e
incerteza. Se a confiança posicional for insuficiente, `pos` deve ser ausente mesmo que uma zona ainda
seja reportada.

### R06 — Geometria calibrada e rejeitável

A conversão RSSI→distância deve aceitar parâmetros por estação. A multilateração deve propagar residual,
condicionamento/qualidade e posição bruta. Resultado incompatível com a planta deve ser rejeitado ou
marcado incerto antes de qualquer operação visual; a borda não é uma solução automática.

### R07 — Seleção explícita da fonte

A posição publicada deve informar a fonte (`fingerprint`, `multilateração` ou `mantida`), a idade da
evidência e a incerteza. Fingerprint com cobertura adequada é a fonte primária nesta configuração;
multilateração só participa quando seus gates geométricos forem atendidos.

### R08 — Movimento fisicamente plausível

O filtro temporal deve usar timestamps reais, limitar velocidade implausível, amortecer jitter e
distinguir `andando`, `parado` e `incerto`. Na perda breve de evidência, mantém a última posição com
incerteza crescente; depois do TTL, não finge uma atualização.

### R09 — Áreas de trabalho independentes

Mesa e outras áreas devem ser polígonos posicionáveis em qualquer ponto da planta, sem relação obrigatória
com os cantos ou com as antenas. A distância deve ser calculada da posição estimada até o polígono
(`0 m` quando dentro), acompanhada da incerteza da posição.

### R10 — Apresentação honesta

O mapa deve mostrar ponto, halo de incerteza, estado de movimento e origem da estimativa. Posição mantida
ou incerta deve ter linguagem visual diferente de uma observação recente. Zona provável aparece como
informação separada; não move o ponto.

### R11 — Avaliação com ground truth

A qualidade deve ser medida em pontos de teste independentes do treino. O relatório deve separar o
desempenho de cada mecanismo e reportar `p50`, `p90`, jitter, saltos, cobertura e taxa de limitação/rejeição.
O agregado global não pode esconder que um mecanismo isolado falhou.

## 6. Critérios de aceite — Given/When/Then

### AC01 — Antena com diferença de case

**Dado** um cadastro `tc22-70a3` e uma leitura `TC22-70A3`  
**Quando** a captura validar a antena de referência  
**Então** ambos são reconhecidos como a mesma estação e nenhum alerta indevido é exibido.

### AC02 — Poll duplicado

**Dado** que a API repete a mesma leitura medida durante vários polls  
**Quando** uma captura é concluída  
**Então** ela conta uma única evidência distinta e satisfaz `nEff ≤ nDistinct`.

### AC03 — Leitura anterior à captura

**Dado** um snapshot medido antes do início da captura  
**Quando** a captura começa sem uma nova medição BLE  
**Então** o snapshot antigo não entra na amostra.

### AC04 — Vetor temporalmente incompatível

**Dado** sinais de três antenas cuja dispersão temporal excede a janela aceita  
**Quando** a localização é calculada  
**Então** o vetor não é tratado como simultâneo e a saída fica ausente ou incerta.

### AC05 — Centro da planta

**Dado** evidência de teste independente coletada no centro da planta  
**Quando** houver cobertura/confiança suficiente  
**Então** a posição publicada pode ocupar qualquer ponto interno compatível com a evidência e não é
encaixada em uma borda, antena, zona ou mesa.

### AC06 — Geometria impossível

**Dado** círculos que produzem posição bruta centenas de metros fora de uma planta de `3 × 5 m`  
**Quando** a multilateração for avaliada  
**Então** ela é rejeitada/marcada incerta com residual visível e não vira um ponto firme na borda.

### AC07 — Zona sem posição

**Dado** um rótulo de zona com margem aceitável, mas evidência insuficiente para `x,y`  
**Quando** o mapa atualizar  
**Então** a zona pode ser informada, porém nenhum ponto inventado é desenhado.

### AC08 — Área de trabalho no interior

**Dado** uma mesa desenhada como polígono no centro  
**Quando** uma posição contínua válida se aproximar ou entrar nela  
**Então** a distância é calculada geometricamente até o polígono, sem deslocar o beacon para a mesa.

### AC09 — Salto implausível

**Dado** duas estimativas consecutivas cuja velocidade excede o limite configurado  
**Quando** o filtro de movimento atualizar  
**Então** o ponto não teleporta, a incerteza reflete a divergência e o evento entra na métrica de saltos.

### AC10 — Evidência perdida

**Dado** uma última posição confiável e a interrupção temporária de leituras  
**Quando** ainda estiver dentro do TTL de manutenção  
**Então** a posição permanece explicitamente marcada como mantida/incerta; após o TTL, não é apresentada
como observação atual.

### AC11 — Avaliação sem vazamento de treino

**Dado** fingerprints de treino e pontos de teste fisicamente marcados e separados  
**Quando** o harness avaliar o mecanismo  
**Então** nenhum ponto de teste participa do treino e as métricas são reportadas por mecanismo e estrato.

## 7. Métricas e regra de decisão

| Métrica | Definição |
|---|---|
| `erro_p50_m` | mediana da distância Euclidiana entre estimativa e ground truth de teste |
| `erro_p90_m` | percentil 90 da mesma distância |
| `jitter_p90_m` | p90 da distância de cada posição à mediana durante tag fisicamente parada |
| `saltos_rate` | proporção de transições que excedem o limite espacial/velocidade definido |
| `coverage` | proporção de instantes elegíveis em que o mecanismo publicou posição válida |
| `clamped_rate` | proporção de posições publicadas obtidas por corte à borda; alvo estrutural: `0%` |
| `rejected_rate` | proporção de candidatos recusados pelos gates, separada por motivo |
| `nDistinct` | quantidade de tuplas distintas estação+tag+`measuredAt` |

Toda proporção deve incluir `n` e intervalo de Wilson de 95%. Métricas devem ser separadas por fonte,
ponto de teste, cobertura de antenas e estado parado/em movimento.

Metas operacionais iniciais são **hipóteses de produto**, não fatos comprovados: `p50 ≤ 0,75 m`,
`p90 ≤ 1,5 m`, `jitter_p90 ≤ 0,75 m`, saltos `≤ 1%` e cobertura `≥ 80%`. Elas só podem virar promessa
de produto após medição de campo independente. O alvo estrutural que independe de calibração é:
nenhuma coordenada publicada pode ser criada por limitação silenciosa à borda.

## 8. Fora de escopo

- Afirmar que uma pessoa está trabalhando apenas por proximidade BLE.
- Identificar uma pessoa sem associação explícita e autorizada da tag.
- Substituir BLE por UWB, AoA ou novo hardware nesta entrega.
- Prometer precisão métrica antes do conjunto ground truth de campo.
- Reprocessar, apagar ou “limpar” gravações de campo existentes.
- Alterar contratos de câmera, persistência de frames ou demais rotas não relacionadas à Planta BLE.

## 9. Dependências e risco residual esperado

- São necessários pontos de teste físicos independentes, inclusive centro, interior fora da mesa,
  proximidade das bordas e trajetos em movimento.
- RSSI sofre multipercurso, obstrução pelo corpo e orientação da tag. Software pode declarar incerteza e
  reduzir falsos saltos, mas não elimina o limite físico do canal.
- Com apenas quatro fingerprints, a interpolação interna é uma hipótese forte. Uma malha mais densa é
  necessária para validar precisão em toda a área.
- Distância estimada à mesa herda o erro posicional; deve ser exibida com incerteza e limiar operacional.

