# ADR-012 — Abordagem científica (fusão BLE+visão): viabilidade e trilha de adoção

**Status:** aceito · **Data:** 2026-07-09 · **Fonte:** `docs/cientifica/` (base.md, exploracao.md, dev.md,
pedido_caderno.md, caderno-provas-visuais.html) — conversa de pesquisa que propõe um "motor de localização" maduro.

## Contexto

Os documentos de `docs/cientifica/` reformulam o produto como **estimação do estado de várias entidades no
tempo, a partir de evidências heterogêneas/ruidosas/ambíguas, sob restrições físicas** — não "um sistema BLE+câmera".
Propõem um arcabouço rico:

- **Substrato único: factor graph** (GTSAM/iSAM2) — cada sensor vira um "fator"; fusão por otimização conjunta em vez
  de pipeline sequencial. É a materialização do "Motor Universal" (Fase 8 do plano deles).
- **Fronteira patenteável:** a **associação mora dentro do grafo** (semantic-SLAM max-mixture + transporte ótimo/
  Sinkhorn num laço EM) — associação e localização resolvidas **juntas**.
- **Transplantes associativos:** reconstrução de trajetória do CERN (GNN track-finding), GP/kriging p/ o mapa de RSSI,
  set-membership (restrições do galpão como informação), Huber/robustez, active inference.
- **Software em volta do motor (dev.md):** contrato de evidência (incerteza como cidadã de 1ª classe), tempo de
  captura, filtering×smoothing, **harness de replay + simulador**, motor puro, identidade-como-hipótese (event
  sourcing), smoother-como-gerador-de-rótulo.
- **Caderno de 7 provas visuais** (HTML) — a matemática de cada peça, já escrita em **JS**.

**Realidade do código HOJE (ancorada):** stack **100% JS/Node** (React/Vite/TS + Node `http` nativo + Socket.IO +
onnxruntime-node + pg). **Zero Python, zero GTSAM/PyTorch.** Motor de análise = `server/analysis/*.js` + D-FINE ONNX
(ADR-009). Fusão tag↔pessoa atual = **heurística de 1 estação** (correlação RSSI×distância + "não sei"), SNR≈1 medido.
Não existem: harness de replay, dados rotulados, múltiplas estações, sincronização de relógio.

## Decisão

**Tratar a abordagem científica como TRILHA DE PESQUISA separada do MVP** — não reescrever o MVP em cima dela — e
**adotar já, no stack atual, apenas o subconjunto barato que eleva qualidade e cabe na doutrina** ("o básico bem
feito", anti-overengineering, anti-dependência supérflua). Especificamente:

1. **É viável em fases — não tudo, não agora, não no mesmo stack.** Três condicionantes duras:
   - **Física:** 1 estação + RSSI = distância ruidosa, não posição. Triangulação/sub-métrico exige **hardware**
     (multi-estação/UWB/AoA) + overlap de câmeras. Software não cria receptor que não existe.
   - **Stack:** GTSAM/GNN/torch são Python/C++. **Mas** a *mecânica* de cada painel do caderno já roda em **JS** em
     pequena escala (o HTML prova). A barreira Python só morde em **escala** (solver incremental, modelos treinados).
   - **Dados:** GP/Sinkhorn/GNN precisam de dados rotulados; o **harness de replay** (que não existe) é o pré-requisito
     e o de-risco nº1.

2. **Adotar AGORA (JS/Node, baixo custo, alto valor):** contrato de evidência (`{medição, covariância, ts_captura,
   fonte, qualidade}`), **gravação de dado bruto + harness de replay**, **set-membership** (anel BLE ∩ setor câmera via
   homografia ∩ região navegável → região garantida — reusa homografia + âncoras por vértice que já existem). Opcionais
   baratos: fusão por covariância (§1), Kalman 1-alvo (§2), Huber (§7).

3. **Adiar / condicionar a dados+hardware:** factor graph em escala (GTSAM, **serviço Python à parte** — nunca bolt no
   MVP), Sinkhorn-dentro-do-grafo, GP em escala, GNN de poda (§6), digital twin cognitivo. Só avançar quando o replay
   **provar** ganho e houver topologia de sensores que justifique.

4. **Regra de ouro:** nenhum stack novo entra em produção sem (a) dado que justifique e (b) o subconjunto barato já
   entregando lastro de medição. O spike GTSAM, se feito, é **isolado** do MVP (prova de conceito, não código de
   produto).

## Consequências

**Positivas:**
- O MVP ganha qualidade real **sem** virar duas stacks: incerteza honesta vira contrato; o replay transforma achismo em
  métrica (RMSE/IDF1/calibração); set-membership dá **garantia**, não aposta, usando o que já temos.
- Cria o **lastro** (dados + métricas) que é pré-requisito de qualquer componente aprendido — sem ele a pesquisa não
  converge.
- Preserva a doutrina e a arquitetura (ADR-009, anti-dep) enquanto mantém o norte de produto vivo e explícito.

**Negativas / custos:**
- O "leite de pedra" completo (associação conjunta patenteável, sub-métrico) **não** sai no curto prazo — depende de
  hardware e dados, não de esforço de código. Expectativa a alinhar com stakeholders.
- Manter a trilha de pesquisa viva exige disciplina para **não** deixá-la contaminar o MVP prematuramente.

**Riscos e mitigação:**
- *Risco:* investir no motor pesado antes dos dados → desperdício. *Mitigação:* gate por replay (regra 4).
- *Risco:* prometer triangulação com 1 estação → frustração. *Mitigação:* honestidade técnica ("não sei"; distância≠
  posição) já é invariante do produto.
- *Risco:* o caderno-HTML tem bugs de init corrigidos naquela conversa — validar antes de usar como material de fase.

**Encaminhamento:** Fase 0 = harness de replay (maior ROI) + contrato de evidência + set-membership. Fase 1 (research,
isolada) = spike GTSAM provando §1+§2. Fase 2+ só com pré-requisitos atendidos. Ver a avaliação completa que originou
este ADR (peça-a-peça) no histórico da conversa; `docs/cientifica/` é a fonte.
