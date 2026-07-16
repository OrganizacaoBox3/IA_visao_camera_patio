# Parecer — a área "retângulo" vs o triângulo das antenas (a distorção do posicionamento)

> Data: 2026-07-15 · Origem: pergunta do dono ("a área não é necessariamente um quadrado; deveria
> ser o polígono dos vértices das antenas? Com 3 antenas numa área quadrada a localização fica
> distorcida — avalie como o posicionamento usa a área e o algoritmo de conversão para metros").
> Método: leitura do código vivo (`floorplan.ts`, `fingerprint.ts`, `continuous-position.ts`) +
> aritmética sobre a instalação REAL dos fixtures (3×5 m; antenas em (1.43, 5), (3, 0), (0, 0)).

## 1. Veredito em uma linha

**A sua observação está certa — mas a causa da distorção não é o retângulo, e a cura não é trocar
o container por um triângulo: é (a) tratar o polígono das antenas/survey como REGIÃO DE CONFIANÇA
(visível e usada na confiança), e (b) dar pontos de survey aos cantos que hoje não têm suporte.**

## 2. Como o X,Y é calculado hoje (e onde cada mecanismo usa a "área")

1. **Fonte primária — fingerprint WKNN** (`fingerprint.ts:150-164`): a posição publicada é a média
   ponderada (pesos 1/(dist²+ε)) dos **top-3 pontos de survey COM coordenada**. O retângulo só
   entra como gate de sanidade (`selectPositionCandidate` recusa WKNN fora de [0,w]×[0,h]).
2. **Fallback — multilateração** (`floorplan.ts:120-162`): mínimos quadrados sobre as antenas
   vivas; o retângulo entra em `insideFloor` (solução fora → `invalid`, sem clamp — ADR-017) e no
   limite de residual (25% da diagonal). Com o modelo path-loss real, o residual estoura e ela
   quase nunca publica (o fixture real do centro da mesa dá residual >100 m).
3. **two-circle** (2 antenas): escolhe a raiz que cai dentro do retângulo.
4. O desenho enquadra o retângulo inteiro; o EMA/motion-filter não conhece área nenhuma.

## 3. A matemática da distorção que você está vendo

**O WKNN é uma COMBINAÇÃO CONVEXA: a posição publicada vive, por construção, dentro do fecho
convexo dos pontos de survey — nunca fora.** Hoje o survey tem coordenada apenas nas antenas ⇒
todo X,Y publicado cai dentro do **triângulo (1.43,5)–(3,0)–(0,0)**, que cobre só **~37%** do
retângulo 3×5 (área do triângulo = 7,1 m² de 15 m²). Os ~63% restantes do galpão são
**inalcançáveis por construção** — não é ruído, é geometria.

E é pior que o triângulo: com pesos positivos nos 3 vizinhos, a posição só alcança um vértice no
limite (distância RSSI → 0 numa antena). Conta com os números reais da instalação (ruído em-zona
~5–9 dB, entre-zonas ~30–40 dB): tag EM CIMA da antena `tc22` → pesos ≈ 1/25 : 1/900 : 1/900 → a
posição sai ~5% puxada para as outras antenas (≈26 cm para dentro). Tag no MEIO (distâncias RSSI
parecidas) → pesos quase iguais → a posição desaba para perto do **centróide (1.48, 1.67)**.
**O retrato: as tags vivem num triângulo ENCOLHIDO em direção ao centróide — exatamente a
"distorção" observada.**

A multilateração tem o mesmo vício por outra via (GDOP): dentro do triângulo os gradientes das 3
distâncias se cruzam em ângulos bons; fora dele as antenas são vistas num cone estreito e a
componente radial fica mal condicionada → erro amplificado, residual alto, gate recusa. **O
polígono das antenas é, de fato, a região de boa geometria — a sua intuição está correta.**

## 4. Por que NÃO trocar o container pelo triângulo

- O retângulo é a **planta física** (paredes reais); o triângulo é a **cobertura de calibração**.
  Uma pessoa PODE estar fora do triângulo (num canto do galpão) — representar a área como triângulo
  transformaria "não sei estimar aí" em "aí não existe", violando o contrato do ADR-017 (área
  física, zona e posição são independentes; nada de encaixar).
- Mesas/áreas de trabalho podem ficar fora do triângulo — a presença-na-mesa precisa continuar
  existindo lá (com honestidade sobre a confiança).
- Clampar/projetar a estimativa para dentro do triângulo é o mesmo erro do clamp antigo para o
  retângulo, que já removemos.

## 5. A melhoria certa (viável e simples), em ordem de valor

- **S1 — Região de confiança visível e usada (código, ~meio dia com testes).** Calcular o fecho
  convexo de {antenas vivas} ∪ {pontos de survey com coordenada} (função pura; hull de ≤13 pontos é
  trivial) e:
  (a) desenhar no mapa — dentro = normal; fora = sombreado "sem cobertura de calibração";
  (b) estimativa publicada FORA do hull → rebaixar confiança um degrau e marcar
  `foraDaRegiaoCalibrada` (painel: "estimativa fora da área calibrada");
  (c) NADA de mover/clampar a posição.
- **S2 — A cura de campo (sem código, ~15 min): survey nos cantos.** Calibrar 3–4 pontos
  intermediários COM coordenada (os cantos úteis do galpão + as mesas) estende o fecho convexo do
  suporte ao retângulo inteiro — o WKNN passa a PODER publicar lá. É a única forma de cobrir os 63%
  hoje inalcançáveis: **código não estima onde o survey nunca mediu** (extrapolar RSSI = inventar).
  A UI de calibração já aceita ponto intermediário com X,Y.
- **S3 — Aviso de survey pobre (código, ~1 h).** Se os únicos pontos com coordenada são as antenas,
  a aba de calibração avisa: "seu survey cobre ~37% da planta — calibre os cantos e as mesas".
- **NÃO fazer:** container triângulo; clamp/projeção ao hull; extrapolação do WKNN (k adaptativo/
  pesos negativos); mexer na multilateração antes de ter modelo calibrado por estação (ela mal
  publica hoje — o gate está certo).

## 6. Aferição honesta (o que estes números são e não são)

Os números acima (37%, ~26 cm, centróide) são **geometria determinística da instalação do fixture**
— valem como mecanismo, não como acurácia de campo. A régua de campo continua sendo o
`localization-eval` (fail-closed, p50/p90/jitter/saltos com Wilson 95%) rodado num split de TESTE
com pontos independentes — o protocolo já registrado em `resultado.md` §Próxima medição. Depois do
S2 (survey nos cantos), rodar o eval de novo mede QUANTO a cobertura estendida comprou.

## 7. Nota relacionada — cadência das tags (pedido do mesmo dia)

Alvo: advertising a ~100 ms ("máximo de atualizações"). Aproveitamento real no pipeline atual: o
app da estação guarda a ÚLTIMA leitura por MAC por POST (500 ms) ⇒ com 100 ms de advertising cada
POST carrega uma leitura fresquíssima (idade ≤100 ms), e a captura de survey fica ~3× mais rica
por janela — ganho real; mas ~4/5 dos pacotes seguem descartados no app. Para aproveitar 100%,
o app precisaria ACUMULAR leituras por batch (pendência registrada; só vale se formos usar séries
densas no hub). Custo declarado: bateria — 100 ms ≈ meses de CR2032, contra ~1 ano em 300–500 ms.
