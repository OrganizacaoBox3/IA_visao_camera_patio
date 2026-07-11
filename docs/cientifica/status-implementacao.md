# Status de implementação da referência científica — sugerido × feito × pendente

> Auditoria de 2026-07-10 (2 sondas de leitura integral sobre `base.md`, `exploracao.md`, `dev.md`,
> `pedido_caderno.md`, `caderno-provas-visuais.html`) cruzada com o código no `main`.
> **Doc vivo** — atualizar quando um item mudar de coluna. Legenda: ✅ feito · 🟡 parcial · ⬜ pendente.

## Princípios institucionalizados (do especialista, em resposta ao relatório consolidado, 2026-07-10)

Duas regras da casa, nascidas da revisão adversarial que derrubou o v4 — valem para **todo** mecanismo
futuro, não só o que já rodou:

1. **Nenhum mecanismo novo entra sem uma sentinela adversarial que viole o pressuposto físico que ele
   compartilha com o simulador.** O v4 foi aprovado por um torneio honesto porque o simulador e o
   mecanismo nasceram do mesmo modelo mental (log-distância) — o torneio media o mecanismo no único
   universo onde ele é ótimo por construção. As sentinelas de viés (`ancoras-multidao-bias`,
   `ancoras-mismatch-n`) já institucionalizam isso na prática; esta é a regra nomeada.
2. **Todo ganho agregado deve ser decomposto por tipo de erro antes de virar default.** O ganho do v4
   inteiro vinha de "âncora não confundida com pessoa" — não da física de distância que a narrativa
   original alegava. Ganho que não se explica mecanicamente é ganho escondendo a própria causa.
3. **Gravação de campo é artefato imutável e append-only** — nenhum agente tem poder de deleção sobre
   sessões de gravação real. Nasceu de um incidente real (perda de ~7h de dado de campo por um `rm -f`
   sobre arquivo sob escrita ativa); mitigação em camadas no `session-recorder.js` (segmentação por
   hora + backup periódico). Detalhes e runbook: `CLAUDE.md` §3 Invariantes.
4. **Todo teste de hipótese exige controle positivo antes de interpretar qualquer nulo** — demonstrar
   que a manipulação consegue mover ALGUMA métrica que sabidamente deveria mover; se o controle
   positivo falha, o experimento é ritual, não medição. Nasceu do próprio especialista admitindo um
   erro de nível de abstração no desenho do shuffle-baseline: embaralhar NOMES de tag (permutação de
   colunas da matriz de score) é matematicamente incapaz de mudar `conflictRate` — o desenho correto
   precisaria quebrar a correspondência FÍSICA RSSI↔trajetória (ex.: deslocamento temporal circular),
   não só o rótulo de identidade. Ver `src/fusion/shuffle-baseline.ts` (achado negativo provado,
   não só medido) e `docs/analises/tags-bluetooth/PENDENCIAS.md` (previsão a).
5. **Toda fórmula em spec vem com um exemplo de sanidade direcional de uma linha** — "caminhar de
   costas para a estação deve DERRUBAR o RSSI; se subir, o sinal está invertido". Teste dimensional
   e direcional para prosa, com o mesmo status dos testes para código. Nasceu do post-mortem do
   sinal invertido do viés corporal (revisão adversarial da Fase 4 da bancada, 2026-07-11): o §4 de
   `simulador.md` somava `bodyBias` quando atenuação subtrai — o desenvolvedor implementou fielmente
   uma fórmula errada; o erro era da ESPECIFICAÇÃO. O modo de falha mais perigoso de uma spec é o
   entendimento certo com o documento errado, porque ninguém desconfia dela. Um exemplo direcional
   de dez segundos no §4 teria pego o bug antes de virar curva retratada.

### Recalibrações do material original (assumidas pelo próprio especialista)

- **Sinkhorn "standalone" não se sustenta.** A formulação de Sinkhorn como generalização direta do
  Hungarian pressupõe implicitamente a MESMA função objetivo do Hungarian (maximizar soma de scores,
  todo mundo atribuído) — que nunca continha a invariante "rótulo errado é pior que nenhum". O
  Hungarian *puro*, medido, piora o guloso+guarda exatamente por isso. O degrau correto não é Sinkhorn
  isolado: é **atribuição com abstenção dentro da otimização** (dustbin do SuperGlue / unbalanced
  optimal transport), com **gatilho quantitativo mensurável**: taxa de ticks com conflito de
  atribuição real (cadeias de conflito entre ≥2 tags disputando o mesmo track) — hoje baixa, com
  poucas tags. Enquanto for baixa, o item fica no gelo por número, não por intuição.
- **"Fatores de mapa = maior salto de precisão" só valia para uma arquitetura onde BLE também vota na
  posição** (factor graph clássico). Na arquitetura real do projeto (câmera=posição via homografia,
  BLE=identidade via correlação), o `∩navegável` **não alimenta a associação de forma significativa**
  — a posição da pessoa visível já vem certa da câmera, e o anel de uma estação é isotrópico (não tem
  direção pra vetar "do outro lado da parede"). **Reetiquetado: item de PRODUTO** (anéis honestos
  visualmente — tag fora de vista aparece em corredor plausível, não dentro de máquina), não degrau
  científico. Só volta a ser alavanca de precisão quando existir estimador de posição que não seja a
  câmera (multi-estação, ou predição na oclusão com prior de movimento que o associador ainda não tem).

## O foco do dono: usar as TAGS FIXAS a nosso favor (com 1 antena)

**Nota de fidelidade:** os docs não usam o vocabulário "reference tags/LANDMARC/correção diferencial" —
mas prescrevem os quatro mecanismos que materializam exatamente essa ideia:

| # | Mecanismo prescrito | Onde nos docs | Status |
|---|---|---|---|
| A1 | **Set-membership: anel BLE ∩ setor câmera ∩ navegável** — "região garantida, não aposta" | caderno §3; base.md:183,342 | 🟡 anel ✅ (`floor-plot.ts`); **geometria ∩navegável pura ✅** (`floor-polygon.ts` — point-in-polygon + recorte do anel por polígono, 100% testável, sem câmera); falta a UI de desenhar/persistir o polígono e ligar no `useFloorTags.ts`/`draw.ts` (fase futura). **RECALIBRADO pelo especialista (2026-07-10): item de PRODUTO, não degrau científico** — na arquitetura real (câmera=posição), o ∩navegável não alimenta a associação (o anel de 1 estação é isotrópico, sem direção pra vetar; a posição de quem é visível já vem certa da câmera). Só volta a ser alavanca de precisão com estimador de posição não-câmera (multi-estação ou predição na oclusão) |
| A2 | **GP/kriging: âncoras fixas → mapa de propagação auto-aprendido** com incerteza calibrada — "o mapa é aprendido, não configurado" | caderno §5; base.md:175,344,370 | 🟡 **versão de ordem-zero entregue hoje**: `fitPathLoss` ajusta o log-distance continuamente pelas 4 âncoras. Falta o campo GP completo (incerteza por ponto) — e exige âncoras mais espalhadas (span atual 0,7–1,6 m é estreito) |
| A3 | **Fatores de mapa** (paredes/corredores/navegável) — "carregam mais bits que o BLE"; "maior salto de precisão por esforço" | exploracao.md:16; pedido_caderno:200 | ⬜ nada usa a planta como restrição ainda. **RECALIBRADO pelo especialista**: essa promessa valia para factor graph clássico (BLE também vota na posição) — na arquitetura real (BLE só decide identidade), fatores de mapa não têm o mesmo efeito. Só relevante de novo com estimador de posição não-câmera |
| A4 | **Cold-start física→aprendido + auto-auditoria NIS** — âncora com distância conhecida detecta "sensor mentindo"/deriva e dispara recalibração | dev.md:7,23 | 🟡 cold-start log-distance ✅ (é o que fizemos); `stationHealth` faz drift da refTag (NIS-zero); falta o **resíduo contínuo por âncora** exposto como saúde do modelo |

**Síntese:** a tese do dono ("não basta a antena; as fixas são sensores de calibração") é exatamente A2+A4.

**Atualização 2026-07-10 (v4 implementada e TESTADA):** a evidência de distância absoluta no
associador (câmera diz 3,1 m; RSSI calibrado pelas âncoras diz ~3,3 m → 2ª evidência p/ o QUEM) foi
construída, torneada E **revertida pela revisão adversarial** — circularidade sim↔fit provada (com
viés corporal real, a v4 ligada piora drasticamente). Decisão final: o mecanismo simples e imune a
viés foi adotado (**tags-âncora nunca são candidatas a pessoa** — captura o ganho real sem modelo de
RSSI no caminho); gate/blend de distância absoluta ficam como **knobs de pesquisa desligados**,
aguardando dado de campo real para o A4 (viés corporal, expoente do canal). Detalhes e números:
`harness-associacao-indoor.md` §v4. Isso muda A4 de 🟡 para: cold-start ✅, exclusão de âncoras ✅
(o ganho real, capturado), resíduo/gate por distância 🟡 (implementado, correto, mas OFF até haver
dado real — o teste de campo do dono é o próximo passo que decide se liga).

## Processo (dev.md — as 7 decisões de engenharia)

| # | Decisão prescrita | Status |
|---|---|---|
| 1 | Contrato de evidência universal (medição+covariância+ts captura+fonte+qualidade) | 🟡 contratos existem (`evidence.ts`, `FusionFrame`) mas **sem covariância/qualidade** por medição |
| 2 | Tempo: ts de CAPTURA na borda; filtering (vivo) + smoothing (consolidado) | 🟡 ts é do hub no ingest (chegada, não captura); **só filtering** — smoother ⬜ |
| 3 | **Harness de replay + event sourcing + simulador + métricas** — "vem ANTES de qualquer algoritmo" | ✅ **feito por inteiro e na ordem prescrita**: recorder/session-recorder (opt-in), `sim.ts` (simulador do galpão), `replay-fusion` (motor real medido), métricas de identidade. Falta: IDF1 formal, tempo de recuperação pós-oclusão, calibração de incerteza |
| 4 | Motor puro `(estado, evidências) → estado`; stack Python+GTSAM como serviço | 🟡 motores puros ✅ (todos); GTSAM/Python **adiado de propósito** (ADR-012 — gated por dados/hardware) |
| 5 | Identidade é hipótese versionada (p, revisão), não fato | 🟡 `Assignment` carrega confiança e abstém (tag=null) ✅; versionamento/event-sourcing de identidade ⬜ |
| 6 | Smoother como gerador de pseudo-labels (auto-aprendizado) | ⬜ sem smoother |
| 7 | Observabilidade da inferência + borda + LGPD by design | 🟡 LGPD ✅ (nenhum frame persistido, metadados-only, opt-in); telemetria de inferência (taxa de ambíguas, NIS por fonte) ⬜ |

## Os 7 painéis do caderno de provas × código

| Painel | Técnica | Status |
|---|---|---|
| §1 Fusão por covariância (Bayes/MAP) | ⬜ nenhuma fusão pesada por covariância no motor |
| §2 Kalman/prior de movimento na oclusão | 🟡 ByteTrack tem modelo de movimento p/ caixas; motores v2/v3 (trilha outdoor) têm velocidade; o associador indoor não prediz na oclusão |
| §3 Set-membership (anel ∩ setor ∩ navegável) | 🟡 anel ✅ (hoje); interseções ⬜ |
| §4 Sinkhorn/transporte ótimo | 🟡 Hungarian implementado e **medido → rejeitado como default** (achado: otimalidade sem ambiguidade piora); Sinkhorn-com-ambiguidade ⬜ — nosso achado refina a prescrição |
| §5 GP/kriging radio map | 🟡 fit paramétrico pelas âncoras ✅ (hoje); campo GP com incerteza ⬜ |
| §6 GNN de trajetórias (CERN) | ⬜ gated por escala (nº de tags) |
| §7 Kernel robusto (Huber) | ⬜ o associador usa guardas (minSamples/minMovement/top-2) em vez de kernels; Huber no RSSI ⬜ |

## Roadmap de de-risco (pedido_caderno) × onde estamos

| Passo prescrito | Status |
|---|---|
| Spike GTSAM (1 entidade, 3 fatores) | ⬜ adiado (ADR-012: JS-first; o harness já cumpre o papel de validar a arquitetura em escala de brinquedo) |
| (1) Fatores de mapa | ⬜ |
| (2) Multi-entidade + mixture/Sinkhorn | ⬜ (multidão já medida no harness: 59,8% — a régua está pronta) |
| (3) GNN de poda | ⬜ |

## O que JÁ fizemos que os docs pedem (resumo do ✅)

1. **A ordem certa** — "contrato de evidência e harness ANTES de algoritmo sofisticado": cumprido à risca (Fases 0–3 + harness indoor + gravador de campo).
2. **Motor puro e replay determinístico** — todos os motores são funções puras; replay reproduzível.
3. **Simulador do galpão** — `sim.ts` (pessoas/câmera/BLE sintéticos com verdade).
4. **Homografia câmera→planta** — produção, calibrada na instalação, com âncoras por vértice.
5. **LGPD by design** — frames nunca persistem; gravações opt-in de metadados.
6. **Honestidade como invariante mecânica** — abstenção guardada (parado=0 erros), torneios com regra a priori, pinos medidos.
7. **Anel BLE + calibração contínua pelas âncoras** (hoje) — primeiro degrau de §3+§5.

## Backlog priorizado (do que falta, pelo critério valor÷esforço dos próprios docs)

1. ✅ **v4 do associador: exclusão de âncoras** (o ganho real, imune a viés) — feito 2026-07-10.
   🟡 gate/blend de distância absoluta implementados mas OFF (aguardando dado de campo real).
2. ⬜ **Resíduo por âncora como saúde do modelo** (NIS-lite, A4) — barato, expõe "sensor mentindo" na UI.
3. ⬜ **∩ navegável no anel** (A1, meia-entrega de fatores de mapa): recortar o anel pelo polígono de chão da cena.
4. ⬜ **Métricas que faltam no harness**: IDF1 formal, recuperação pós-oclusão, calibração de incerteza.
5. ⬜ **ts de captura na borda** (TC22 carimbar; hoje é o ts do hub).
6. ⬜ **Sinkhorn com ambiguidade modelada** (§4, informado pelo nosso achado do Hungarian).
7. ⬜ **Campo GP completo** (§5) — quando houver âncoras mais espalhadas.
8. ⬜ **Smoother + pseudo-labels** (dev.md §6) e **factor graph/GTSAM** — gated por dados de campo acumulados (o gravador já coleta).
