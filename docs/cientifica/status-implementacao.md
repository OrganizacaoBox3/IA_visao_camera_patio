# Status de implementação da referência científica — sugerido × feito × pendente

> Auditoria de 2026-07-10 (2 sondas de leitura integral sobre `base.md`, `exploracao.md`, `dev.md`,
> `pedido_caderno.md`, `caderno-provas-visuais.html`) cruzada com o código no `main`.
> **Doc vivo** — atualizar quando um item mudar de coluna. Legenda: ✅ feito · 🟡 parcial · ⬜ pendente.

## O foco do dono: usar as TAGS FIXAS a nosso favor (com 1 antena)

**Nota de fidelidade:** os docs não usam o vocabulário "reference tags/LANDMARC/correção diferencial" —
mas prescrevem os quatro mecanismos que materializam exatamente essa ideia:

| # | Mecanismo prescrito | Onde nos docs | Status |
|---|---|---|---|
| A1 | **Set-membership: anel BLE ∩ setor câmera ∩ navegável** — "região garantida, não aposta" | caderno §3; base.md:183,342 | 🟡 anel ✅ (`floor-plot.ts`); **geometria ∩navegável pura ✅** (`floor-polygon.ts` — point-in-polygon + recorte do anel por polígono, 100% testável, sem câmera); falta a UI de desenhar/persistir o polígono e ligar no `useFloorTags.ts`/`draw.ts` (fase futura); ∩ setor da câmera fica de baixo valor com 1 câmera só (tudo visível já está no FOV) |
| A2 | **GP/kriging: âncoras fixas → mapa de propagação auto-aprendido** com incerteza calibrada — "o mapa é aprendido, não configurado" | caderno §5; base.md:175,344,370 | 🟡 **versão de ordem-zero entregue hoje**: `fitPathLoss` ajusta o log-distance continuamente pelas 4 âncoras. Falta o campo GP completo (incerteza por ponto) — e exige âncoras mais espalhadas (span atual 0,7–1,6 m é estreito) |
| A3 | **Fatores de mapa** (paredes/corredores/navegável) — "carregam mais bits que o BLE"; "maior salto de precisão por esforço" | exploracao.md:16; pedido_caderno:200 | ⬜ nada usa a planta como restrição ainda |
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
