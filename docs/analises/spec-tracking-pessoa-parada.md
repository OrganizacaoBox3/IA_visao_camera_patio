# SPEC — Tracking persistente de pessoa parada ("o marcado some")

> Status: **proposta aguardando aval do dono** · Data: 2026-07-12
> Insumos: pesquisa de mercado (Frigate stationary handling — o precedente direto; ByteTrack/
> DeepSORT/BoT-SORT/OC-SORT; Axis/Avigilon) + mapa completo da cadeia de morte do track (7 mapas,
> constantes literais, arquivo:linha) + as medições já feitas no arco (PENDENCIAS §3, #27, #31).

## 0. O diagnóstico — a queixa tem TRÊS causas empilhadas, em camadas diferentes

A auditoria decompôs "o marcado some se a pessoa estiver parada" em três elos independentes:

1. **[OVERLAY — a causa visual mais provável, e a mais barata]** Com o hub analisando, pessoa
   parada → cena estática → o gate de movimento PULA a inferência (correto, economiza CPU) → mas
   **nenhum `analysis-tracks` é emitido durante o skip** (até 6s entre probes) → o interpolador do
   front **expira a caixa em 2,6s** (`expireMs 2600 < probeMs 6000`). **A caixa some com o track
   VIVO no hub (ttl 8000).** Subir TTL não toca este elo.
2. **[TRACKER — a morte real]** No front (câmera não coberta pelo hub): `ttlMs=1500` mata o track
   parado em ~3s (mediana medida). No hub: a morte é por **relógio** (wall-clock TTL 8000) com
   margem de só 2000ms sobre o probe de 6000ms — um probe atrasado (pool saturado) mata o track
   com a pessoa lá; e ~2 probes sem detecção (pessoa sentada com score < 0,25) também matam.
   Morto = **ID novo** na re-detecção (a guarda de nascimento só vale com o track vivo) → dwell
   zera.
3. **[MÉTRICA — a consequência]** Track morto com a pessoa presente → `people=0`,
   `activeFrames`↓ → a zona vira **VAZIA** (deveria ser OCIOSA = pessoa presente sem movimento) →
   **falso alerta de ociosidade** — que a frente de turnos tornaria pior ("ocioso DENTRO do
   turno"). É a métrica-que-mata sendo violada por um knob.

## 1. A decisão de design central (o mercado é convergente)

> **"Parado" é um ESTADO explícito do track — não morte.** A ausência de movimento na região da
> caixa é **evidência de PRESENÇA** (para sair de cena, a pessoa PRECISA gerar movimento). O track
> estacionário não expira por relógio; ele é **refutado por evidência**: a detecção roda
> periodicamente (o nosso probe JÁ é isso) e só a **ausência de detecção em M probes consecutivos**
> o mata. Teto opcional para o caso patológico.

Precedentes: Frigate (`stationary.threshold` ~10s p/ entrar; `interval` ~10s de confirmação;
`max_frames` opcional; sem movimento na caixa = continua lá; o ghost do "carro que saiu e ficou
rastreado por horas" é resolvido pela refutação periódica) · OC-SORT (track parado = caixa
congelada + velocidade zero — o nosso `predictBBox` já faz isso) · Axis Occupancy in Area (conta
estacionário como presente, por design) · ByteTrack 2ª passada (score alto para NASCER, baixo para
SUSTENTAR — já temos: 0,35/0,25).

**O que o nosso hub JÁ tem de graça:** o probe de 6s do gate de movimento É o "interval" do
Frigate. A peça que falta não é infraestrutura — é **trocar a morte por relógio pela morte por
evidência** para tracks estacionários.

## 2. Os consertos (um por camada)

**C1 — Overlay nunca esfomeado (o conserto visual):** durante o skip do gate, o hub **re-emite o
último estado dos tracks** (payload leve e imutável — os tracks estão congelados; marcado
`coasting:true`) a cada rodada gateada, OU o `expireMs` do interpolador passa a respeitar a
cadência real (`> probeMs + margem`). Preferência: re-emissão (mantém o contrato "payload fresco
= verdade" e o overlay pode indicar visualmente o estado parado — caixa estável, sem fade).

**C2 — Estado ESTACIONÁRIO no tracker (espelhado hub+front, mesma política):**
- **Entrada**: posição estável por N frames observados (análogo `stationary.threshold`; jitter de
  bbox tolerado — o inimigo nº 1 segundo o Frigate).
- **Vida**: caixa congelada, velocidade zero (já é o comportamento do `predictBBox`); **isento de
  TTL wall-clock**; re-associação na 1ª passada por IoU (já funciona: predita = observada).
- **Morte por EVIDÊNCIA**: M probes consecutivos **com detecção rodando** e sem match → morre
  (análogo `max_disappeared`). Isso também conserta a armadilha do probe atrasado: se a detecção
  NÃO rodou, não conta como miss — o relógio deixa de matar.
- **Teto opcional** (`stationaryMaxMs`, generoso, ex. 2h) para o caso patológico.
- **Anti-hijack**: track estacionário **não é alvo do 2º estágio** (re-associação por distância) —
  ele não se moveu; pessoa NOVA no raio não pode herdá-lo (o ímã de id-hijack medido no arco:
  12→100% com ttl 1500→12000).
- **Saída da métrica**: track estacionário conta `people`/`occupied` → a zona fica **OCIOSA**
  (presente, sem movimento), nunca VAZIA — a semântica correta para a frente de turnos.

**C3 — O harness ANTES dos knobs (a armadilha nº 1 da auditoria):** o `eval/counting.mjs` — o rito
oficial para mudar knobs de tracker — **é cego exatamente para este cenário**: não tem pessoa
parada, não exercita o gate/probe (chama `processRound` direto) e não afere ocupação. **Mudar
ttl/estado estacionário com esse torneio seria luz verde sem medir a falha.** Primeiro estende-se
o harness (cenários de dwell longo com gate simulado + métricas de sobrevivência de ocupação,
ghost e id-switch), depois roda-se o torneio. Aí o **#31** (alinhar o front) executa com régua
válida.

## 3. Critérios de aceite

- **CA-1 (a queixa):** Given hub analisando e pessoa PARADA 10 minutos; Then a caixa **nunca some**
  do dashboard (nem 1 frame de buraco > 1s) e o ID é o MESMO do início ao fim.
- **CA-2 (saída limpa, anti-ghost):** When a pessoa SAI da zona; Then o track fecha em ≤ M probes
  (não "coasta" por minutos — o carro-fantasma do Frigate não se reproduz); a ocupação da zona cai
  junto.
- **CA-3 (morte por evidência, não relógio):** Given probe atrasado 12s por saturação (detecção
  NÃO rodou); Then o track estacionário **sobrevive** (hoje: morre aos 8s).
- **CA-4 (anti-hijack):** Given pessoa A estacionária e pessoa B entrando no raio de 0,12; Then B
  ganha ID novo (não herda o de A) — sentinela explícita.
- **CA-5 (métrica):** Given pessoa parada na zona; Then sample reporta `people ≥ 1` e estado
  OCIOSA (não VAZIA); o falso alerta de "zona vazia" não dispara.
- **CA-6 (score fraco):** pessoa sentada com score intermitente em [0,25, 0,35) é SUSTENTADA pela
  2ª passada (já existe — vira teste explícito de regressão).
- **CA-7 (paridade):** hub e front com a MESMA política de estado estacionário (knobs podem
  diferir por ambiente, a POLÍTICA não — teste espelhado nos dois lados).
- **CA-8 (torneio):** nenhuma mudança de knob promovida sem o `eval:counting` ESTENDIDO verde
  (ghost e id-switch não pioram além da régua pinada a priori).

## 4. Fases

**F1 — Overlay (C1) [P, barato, resolve a queixa visível]:** re-emissão durante skip +
`coasting` no payload + ajuste do interpolador. Teste de unidade do interpolador + e2e visual.

**F2 — Harness (C3) [P]:** cenários estacionários no `eval/counting.mjs` (dwell 10min com gate
simulado; saída; probe atrasado; score intermitente) + métricas novas (sobrevivência de ocupação,
ghost-time, id-switch de estacionário). **Régua pinada ANTES do torneio** (a priori, como manda a
casa).

**F3 — Estado estacionário (C2) [S após F2]:** máquina de estados espelhada nos dois bytetracks +
morte por evidência + anti-hijack + métrica OCIOSA. Passa pelo torneio do F2. Uma mudança de
POLÍTICA de tracker = revisão serializada, um PR.

**F4 — Alinhamento do front (#31) [S após F2]:** ttl/knobs do front via torneio agora válido —
fecha o caminho B (câmeras sem hub).

**F5 — Amarração com turnos [S]:** o estado OCIOSA-com-pessoa alimenta o gate de ociosidade da
frente de turnos (pessoa presente e parada DENTRO do turno = o caso que o cliente quer ver;
zona vazia fora do turno = silêncio).

## 5. Fora de escopo v1

ReID visual como re-âncora pós-morte (ADR-015 — pilar próprio; aqui a estratégia é NÃO deixar o
track morrer); classificador visual de estacionário (Frigate 0.16 — se o jitter nos morder,
reavaliamos); mudanças no gate de movimento/probeMs (o gate está certo — o problema era a emissão
e a morte por relógio); Kalman/aparência no tracker.

## 6. Riscos e mitigações

| risco | mitigação |
|---|---|
| Ghost/ocupação fantasma com estacionário imortal | morte por EVIDÊNCIA (M probes com detecção sem match) + teto opcional + CA-2 |
| ID-hijack (medido: cresce com persistência) | estacionário fora do 2º estágio + CA-4 sentinela |
| Torneio cego dá luz verde falsa | F2 ANTES de F3/F4 — harness estendido com régua pinada |
| Jitter de bbox acorda o estacionário à toa | threshold de entrada tolerante a jitter (lição nº1 do Frigate); classifier visual só se precisar |
| Divergência hub/front (de novo) | POLÍTICA espelhada + teste de paridade (CA-7) |
| Re-emissão no skip custa banda | payload é congelado/leve e já é volatile; só para câmeras com espectador (hasViewers já existe) |
