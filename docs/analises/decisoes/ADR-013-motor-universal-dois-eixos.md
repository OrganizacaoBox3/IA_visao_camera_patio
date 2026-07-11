# ADR-013 — Motor universal pelos dois eixos (QUEM × ONDE): taxonomia de evidência e critério de entrada de sensores

Data: 2026-07-11 · Status: aceito · Origem: diálogo dono↔especialista pós-laudo (a "Fase 8" do
documento-mãe, agora com lastro empírico do arco 2026-07-08→11).

## Contexto

O objetivo estratégico do dono é o software ser o produto e o hardware um potencializador
(BLE hoje; AoA/mmWave/UWB amanhã — "em todos os casos o software deve sobreviver e entregar o
melhor resultado possível"). O arco de medições destas semanas revelou o padrão que torna isso
executável, em vez de aspiracional:

- **Tudo que CAIU** (v4/distância absoluta, trilateração implícita, Hungarian cru) dependia de um
  modelo físico calibrado de um sensor específico.
- **Tudo que SOBREVIVEU e validou em campo** (correlação temporal série×série — corr −0,91 com
  corpo real; abstenção por significância; exclusão por cadastro; âncoras como auditoria; o
  aparato gravar→replay→torneio→adversarial) **não sabe o que é RSSI**.

A arquitetura que emergiu (câmera=ONDE, BLE=QUEM) não é concessão pragmática — é o caso
particular da estrutura geral: **todo sensor de localização vota em dois problemas distintos,
IDENTIDADE e POSIÇÃO, com forças diferentes**. BLE-RSSI 1 antena: QUEM forte (série
correlacionável), ONDE quase nada. AoA: ONDE médio-forte, QUEM no pacote. UWB: fortíssimo nos
dois. mmWave: espelho da câmera (ONDE forte, QUEM zero — substitui a câmera no eixo ONDE, não o
BLE no eixo QUEM). **Trocar de hardware nunca troca a arquitetura — troca os pesos com que cada
eixo é alimentado.**

"Sobreviver em todos os casos" não significa performar igual: significa **degradar honestamente
e melhorar monotonicamente com hardware melhor, sem reescrita**. Isso é testável.

## Decisão

1. **A taxonomia do motor são os dois eixos, não a lista de sensores.** Toda evidência declara em
   que eixo vota e com que incerteza; o motor mantém os dois eixos e deixa cada evidência votar
   onde é forte.
2. **Contrato de evidência tipado pela NATUREZA da medição** (aditivo): `position2d` · `range` ·
   `bearing` · `identity-series` (o escalar correlacionável — o RSSI de hoje) · `identity-claim`
   (ID embutido, ex. UWB), com incerteza obrigatória por medição.
3. **`sourceId`/`sourceKind` por leitura na gravação e nos contratos** (generalização do
   `stationId` que a 2ª antena já exigiria — mesmo custo, nome certo).
4. **Fusão de identidade multi-fonte por soma de Fisher-z** — o mesmo desenho do experimento de
   2 antenas, que funciona sem alteração para N antenas, antena+AoA, ou qualquer mistura. O gate
   por significância (n_eff) é a peça-chave da universalidade: não pergunta "isso é RSSI?",
   pergunta "quantos pontos independentes e qual correlação?" — hardware melhor passa mais rápido
   pelo MESMO código (UWB falaria em ~2s com r≈0,99; BLE precisa dos 8-15s e do −0,9 que o campo
   mostrou).
5. **Checklist de entrada de sensor** (doc de 1 página): que evidência emite, em que eixo vota,
   qual o rito de homologação (gravar→replay→torneio→adversarial).
6. **Critério de entrada do factor graph (T1), enfim limpo**: ele entra quando existir a SEGUNDA
   FONTE POSICIONAL independente (UWB/AoA/mmWave) — é aí que "fundir posições com covariância"
   deixa de ser abstração e vira necessidade. Construí-lo antes seria a v4 arquitetural: um solver
   casado com um mundo que ainda não existe.
7. **Métrica de universalidade** no experimento da 2ª antena (além da regra a priori já pinada —
   precisão(A+B) ≥ máx(A,B), cobertura ≥1,5×, conflito ≤0,6×, razão de decaimento 0,846 subindo):
   **quantas linhas do motor mudaram para acomodar a segunda fonte**. Previsão registrada do
   especialista: perto de zero — adapter e fusão de z, mais nada. Se confirmar, a interface está
   no lugar certo e UWB/AoA/mmWave entram pela mesma porta.

## Consequências

- A 2ª antena (ESP32, item de maior ROI do backlog) vira o **ensaio geral do motor multi-fonte**,
  não só um upgrade de cobertura.
- O trabalho barato é agora (itens 2-5: aditivos, sem reescrita); o caro (factor graph) fica
  gated pelo critério do item 6 — com data de entrada objetiva, não nostalgia do caderno.
- Estratégia de produto explícita: hardware é commodity com margem de commodity (Quuppa/Pozyx
  vendem o rádio); o que não se copia num datasheet é um motor que aceita qualquer rádio, propaga
  incerteza honesta de ponta a ponta, abstém quando não sabe, se auto-audita por âncoras e
  melhora a cada sensor plugado. **Essa camada é o produto.**
- Risco declarado: tipar evidência cedo demais pode fossilizar uma taxonomia errada — mitigado
  por ser aditivo (campos novos, contratos velhos intactos) e pela regra de que cada tipo novo só
  nasce quando um sensor real o exigir (YAGNI vigiado pelo checklist do item 5).
