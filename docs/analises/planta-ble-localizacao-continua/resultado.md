# Resultado — localização contínua na Planta BLE

Data: 2026-07-15  
Origem: [spec.md](./spec.md) → [plan.md](./plan.md) → [tasks.md](./tasks.md)

## Resultado objetivo

O mecanismo que empurrava tags para as bordas foi removido do caminho publicado. A solução
multilaterada só aparece quando o ponto bruto está dentro da planta e o residual passa pelo gate;
clamp não transforma mais uma solução externa em coordenada válida. No fixture real da Mesa
serigrafia, a geometria legada continua produzindo raios incompatíveis, mas agora retorna
`quality="invalid"`, `fix="none"` e `pos=null` em vez de `(3,0)`.

A posição operacional passa a usar o WKNN contínuo do fingerprint quando há confiança média/alta.
Zona, coordenada, geometria da mesa e distância permanecem campos independentes: reconhecer
"Mesa serigrafia" não move a tag para o centro da mesa.

## Sensores vermelhos observados antes das correções

- Temporal/fingerprint: 6 falhas iniciais e 1 falha adicional do watermark mostraram snapshot
  repetido, leitura pré-captura, vetor dessincronizado, margem entre amostras irmãs e peso singular.
- Geometria: 7 casos falharam antes dos gates de residual/modelo por estação; o fixture central era
  publicado como canto.
- Avaliação: o teste falhou inicialmente por ausência do módulo de ground truth.
- Case de estação: o teste reproduziu `TC22` versus `tc22` antes da normalização.

Os sensores foram mantidos como testes de regressão e terminam verdes.

## Implementação entregue

- `BtReading` propaga `ts/measuredAt`; captura usa watermark, deduplica
  estação+MAC+instante e conta somente medições físicas distintas.
- Agregação de captura usa mediana por tag e peso igual entre tags; o vetor vivo aceita apenas
  evidência fresca (6 s) e sincronizada (3 s).
- Distância de fingerprint usa o `std` salvo com piso/teto; margem compara labels distintos; WKNN
  tem piso de peso, é balanceado por zona e não emite X,Y com confiança baixa.
- Modelos RSSI→distância são ajustados por estação a partir dos pontos conhecidos do survey.
- Multilateração propaga posição bruta, residual, limite, qualidade e fonte; soluções externas,
  degeneradas ou residuais são recusadas antes do desenho.
- Seletor de fonte usa fingerprint primário e geometria apenas como fallback validado.
- Filtro temporal limita velocidade, distingue `andando/parado/incerto`, ignora ordem regressiva,
  mantém brevemente a última posição e a expira após 10 s.
- Histerese de zona avança somente com novo `measuredAt`, não com poll repetido.
- Áreas físicas são polígonos métricos persistidos separadamente; retângulos antigos são migrados
  para quatro vértices. Distância à borda e faixa causada pela incerteza são derivadas sem alterar X,Y.
- Saves com área duplicada, auto-intersectante ou fora da planta agora falham de forma visível; o
  servidor não descarta mais geometria silenciosamente durante uma alteração.
- O motor de desenho já estabilizado na câmera virou um seam espacial compartilhado. A câmera
  conserva o adaptador de letterbox e a Planta BLE usa o mesmo gesto/seleção com um adaptador
  `TopdownTransform`, sem manter dois editores concorrentes.
- A configuração foi separada em `Planta | Áreas | Calibração BLE`. A aba Áreas usa o mapa como
  palco: arraste cria retângulo, cliques criam polígono e a forma selecionada pode ser movida ou ter
  vértices inseridos/removidos.
- O mapa desenha halo métrico, área física e estado incerto; a lista separa zona, posição, fonte e
  distância. Amostras de treino aparecem somente na calibração; fonte, movimento, halo e evidência
  detalhada ficam recolhidos em "Diagnóstico BLE".
- Foi criado avaliador fail-closed com split explícito, erro p50/p90, jitter parado, saltos,
  cobertura/rejeição/clamp e Wilson 95%, geral e por mecanismo.

## Re-medição automatizada

O survey 3 × 5 m e os quatro vetores vivos informados foram versionados em fixtures:

- a multilateração default recusa os quatro vetores em vez de clampá-los nas bordas;
- o WKNN classifica os quatro como `Mesa serigrafia` com confiança média/alta e publica pontos
  estritamente internos (`0 < x < 3`, `0 < y < 5`), não cantos;
- a própria assinatura central é recusada pela geometria quando seus raios não são fisicamente
  compatíveis.

Gates executados:

- `npm run typecheck`: aprovado;
- lint direcionado dos arquivos alterados: aprovado;
- `npm run build`: aprovado;
- testes focais do editor compartilhado, floorplan e distância: 59 aprovados;
- `npm test`: 147 arquivos aprovados, 3 ignorados; 1.734 testes aprovados, 43 ignorados;
- Playwright `/planta-ble`: o cenário passou em 5,8 s, incluindo desenho/persistência de área por
  arraste e acessibilidade mobile. O wrapper
  excedeu o timeout depois do teste durante o encerramento do ambiente; as portas 4100/5180 foram
  confirmadas fechadas.

## O que não foi comprovado

Os testes demonstram correção de contratos e impedem o colapso determinístico nas bordas. Eles não
provam acurácia métrica no chão de fábrica. O ponto da mesa faz parte do conjunto de treino; portanto
não é holdout e não autoriza alegar erro em metros, presença de uma pessoa trabalhando ou precisão de
produção.

Ainda é necessário executar o protocolo de ground truth da spec com pontos de teste independentes e
trajetos reais. Até lá:

- o halo é diagnóstico de dispersão/modelo, não intervalo de confiança calibrado;
- "dentro da mesa" significa relação entre a posição inferida e a geometria cadastrada;
- BLE pode sustentar proximidade/permanência, mas não comprova atividade laboral;
- a multilateração permanece fallback e pode continuar com cobertura baixa mesmo calibrada.

## Ajuste de painel (2026-07-15, retomada) — a mesa vira o sinal primário, com tempo de permanência

Pedido do dono: o painel mostrava a zona por antena (irrelevante ao usuário final); o que ele quer
ler é "o operador está na mesa (área criada) e há quanto tempo", por X,Y. Entregue:

- **Presença na MESA com histerese**: posição publicada ∩ polígono da área (ADR-017 respeitado —
  a área nunca reposiciona a tag), estabilizada pelo MESMO motor `zone-presence` (o rótulo é o
  label da área; observação qualificada = posição com confiança alta/media e movimento não-incerto;
  ts = evidência física, reamostragem não infla streak).
- **Painel**: status primário virou "Na mesa X · há N min" (tom ok), com "Confirmando mesa X…",
  "Fora das mesas" (+ "esteve na mesa X por N min (saiu há…)"), "Localização incerta · última mesa"
  e aviso para cadastrar áreas quando não há nenhuma. A zona por rádio (antena/ponto de treino)
  desceu para o "Diagnóstico BLE". A distância à área só aparece quando FORA (dentro, o status já diz).
- **Mapa**: a área ocupada acende (`--state-ok`, contorno sólido, rótulo com os ocupantes); vazia
  segue neutra tracejada (going-gray).

Honestidade declarada: o tempo exibido é da SESSÃO ATUAL de permanência, computado no navegador —
o acumulado por turno (24/7, independente de aba aberta) segue sendo a pendência P1–P3 de
`spec-zona-trabalho-ble.md` §6 (acumulador no hub + corte por turno + aba de ocupação). E "na mesa"
continua significando relação entre posição INFERIDA e geometria cadastrada — a validação métrica
de campo (holdout) segue pendente como abaixo.

Gates re-executados: typecheck/lint/build ✓ · 1.734 testes aprovados, 43 ignorados ✓ ·
Playwright `/planta-ble` ✓ (3,7 s).

## Próxima medição de campo

1. Cadastrar a dimensão física da Mesa serigrafia no editor de áreas.
2. Coletar fingerprints adicionais em uma malha interna, preservando pontos exclusivos de teste.
3. Registrar tags paradas no centro, fora da mesa, nas bordas e em trajeto conhecido.
4. Rodar `localization-eval` no split `test` e publicar p50/p90, jitter, saltos, cobertura, rejeição e
   clamp por fonte.
5. Só então ajustar gates e decidir se a distância à mesa atende ao uso operacional.
