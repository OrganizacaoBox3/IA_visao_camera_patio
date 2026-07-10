# Relatório consolidado — estado real da trilha científica (para o especialista)

> **Para:** o especialista/consultor que redigiu `base.md`, `exploracao.md`, `pedido_caderno.md`,
> `dev.md` e o `caderno-provas-visuais.html`. **Pedido do dono do produto:** um resumo único, honesto,
> de tudo que foi implementado até agora nessa trilha e do que falta da parte científica — **para
> reavaliação**. Este documento substitui a necessidade de ler o histórico completo de commits; os
> relatórios/matrizes anteriores (`relatorio-especialista-2026-07-10.md`, `status-implementacao.md`,
> `PENDENCIAS.md`) continuam existindo como detalhe, referenciados aqui.
>
> **Compromisso de honestidade:** cada afirmação abaixo foi conferida contra o código atual (não
> contra o que a documentação *diz* que deveria estar acontecendo). Onde há diferença entre "existe
> como código" e "está de fato ligado numa tela que alguém usa", isso é dito explicitamente — é a
> parte que mais importa para não superestimar a maturidade do sistema.

## 1. As DUAS trilhas — e por que isso precisa ficar claro primeiro

Existem duas implementações de "localizar uma tag" no repositório, nascidas de um mal-entendido de
escopo que foi corrigido no meio do caminho:

| | Trilha A — `src/localizacao/` | Trilha B — `src/fusion/` |
|---|---|---|
| Modelo | **AirTag/GPS**: posição = GPS do celular que carrega a tag | **Científico indoor**: posição = câmera (homografia), identidade = BLE (correlação) |
| Para quem serve | Produto — veículo/pátio externo, sem câmera | O que os seus documentos descrevem (fusão BLE+visão) |
| Está em produção? | **Parcialmente — só o merge simples** (ver §2) | **Sim, com ressalvas** (ver §2) |

A trilha A foi construída primeiro (Fases 0–3, motores v1/v2/v3/`guardedEngine`, um harness de replay
inteiro com torneios e benchmarks) **antes** de perceber que o problema real era outro. Ela não foi
descartada — vira produto para pátio/veículo — mas **não é** a resposta aos seus documentos. A trilha
B foi construída depois, reapontada para o modelo certo.

## 2. O que está DE FATO ligado numa tela hoje (a parte mais importante deste relatório)

Isto é o resultado de uma auditoria de código, não de intenção documentada:

| Mecanismo | Estado real | Evidência |
|---|---|---|
| `src/localizacao/` — motores v1 (`fusionEngine`), v2 (`motionEngine`), v3 (`guardedEngine`) | ❌ **Nenhum está em produção.** A tela real (`TagsMapPage.tsx`) consome só `fromTagLocations` — um merge heurístico simples (última posição GPS + leituras ao vivo), que **não invoca nenhum dos motores**. Os motores só existem dentro do próprio harness/benchmark (`*.test.ts`). Onde a documentação interna diz "v1 é o default", isso é o default **do benchmark sintético**, não de produção. | Busca de imports fora de testes: zero resultados |
| `src/fusion/associate.ts` (câmera=onde, BLE=quem) | ✅ **Em produção**, consumido por `useTagFusion`→`useCameraTagLabels`, usados em `CameraWorkspace.tsx` (câmera aberta) e `CameraTile.tsx` (grade). Defaults atuais: `minMargin=0.1` (guarda de ambiguidade, LIGADA), `optimal=false`, `maxDistRatio=0`, `distWeight=0` (evidência de distância absoluta, DESLIGADA) | `associate.ts:96-104` |
| Exclusão de âncoras (`excludeTags`) | ✅ **Ligado por default** — tags-âncora cadastradas nunca viram candidatas a pessoa | fiado em `useCameraTagLabels.ts`→`useTagFusion.ts`→`frame.ts` |
| Plotagem de tags no chão (`floor-plot.ts`/`useFloorTags.ts`) | ✅ **Ligado por default** em `CameraWorkspace.tsx` e `CameraTile.tsx` (grade), com uma assimetria **declarada**: o tile MJPEG da grade (fallback quando WebRTC falha) ainda não mostra a camada | comentários de código nos 2 arquivos |
| Auto-diagnóstico por âncora (resíduo) | ✅ Ligado — âncora "discordando" do próprio modelo ganha indicador visual (anel laranja) | `useFloorTags.ts`, `draw.ts` |
| `floor-polygon.ts` (recorte do anel por chão navegável) | ❌ **Código morto.** Zero consumidores fora do próprio teste — é matemática pronta, sem UI para desenhar/persistir o polígono, sem wiring em `useFloorTags.ts`/`draw.ts` | busca de imports: só o teste |
| Harness de campo real (`session-recorder.js` + `session-loader.ts`) | 🟡 **Ferramenta pronta, nunca usada fim-a-fim.** Existe uma gravação real de hoje (`fusion-session.jsonl`, não commitada/LGPD, ~6h+ de captura contínua), mas nenhuma tabela de verdade (trackId→pessoa) foi anotada nem processada por `replayFusionSession`. A única validação com dado real feita até agora foi **parcial**: só o modelo de propagação RSSI das 4 âncoras (ver §4), não a identidade tag↔pessoa completa | grep por `SessionTruth`/`replayFusionSession`: só em teste sintético |

**Resumo em uma frase:** o sistema que localiza posição via câmera e decide identidade via BLE está em
produção e foi medido rigorosamente em cenários **sintéticos**; a parte que ficou só no papel/harness
foi tudo que tentava ir além disso (motores de extrapolação, distância absoluta, set-membership
completo) — e a validação com **pessoas reais** ainda não aconteceu.

## 3. O que foi medido e decidido (o trabalho de verificação em si)

- **Harness determinístico construído do zero** (`src/fusion/sim.ts`, `replay-fusion.ts`,
  `identity-metrics.ts`): mede o algoritmo de produção real, não uma cópia, alimentado exatamente
  como a tela real alimenta (tick de 500 ms, pula quando não há leitura). Seguiu à risca a ordem que
  `dev.md` pede ("harness antes de qualquer algoritmo sofisticado").
- **Guarda de ambiguidade top-2** (abster quando dois candidatos empatam): torneio com regra definida
  *antes* de rodar → reduziu o erro da suíte em 46%, virou default.
- **Hungarian/atribuição ótima global**: medido e **rejeitado** — sozinho, piora o guloso (maximizar a
  soma força pares medíocres). Fica como knob desligado.
- **v4 — evidência de distância absoluta via tags-âncora** (a tentativa mais próxima de operacionalizar
  LANDMARC/fingerprinting, GP-kriging de ordem zero): promovida por torneio (ganho de +4,6 pontos de
  precisão), depois **revertida** por revisão adversarial que provou **circularidade** entre o
  simulador e o modelo de calibração — com viés corporal realista simulado, o mecanismo ligado
  derrubou a precisão de ~72% para 26%. É o achado científico mais relevante até agora: um torneio com
  regra a priori **não substitui** um teste adversarial que injeta o mundo real no cenário sintético.
  Detalhe completo: `harness-associacao-indoor.md` §v4, `relatorio-especialista-2026-07-10.md` §4.
- **172 testes** cobrindo as duas trilhas (17 arquivos), todos verdes — mas isto mede **consistência
  interna em cenários sintéticos**, não acurácia validada em campo.

## 4. Validação com dado REAL (parcial, sem pessoas)

Sem esperar o teste de campo formal, usamos as 4 tags-âncora (posição-mundo conhecida na calibração) +
~6h de RSSI real já gravado para validar o modelo de propagação sozinho:

- Ruído real medido (~5,6 dB) é **pior** que o assumido no experimento que derrubou a v4 (4 dB) —
  reforça, não enfraquece, a decisão de manter os knobs de distância absoluta desligados.
- O `rssi0` implícito varia **16 dB** entre as 4 âncoras — evidência real de que um modelo único de
  propagação para todo o espaço é um ajuste pobre; cada ponto tem condição de rádio própria.
- Uma âncora (`…CE:3C`) destoa consistentemente em dois métodos de ajuste diferentes — ação sugerida
  ao dono: checar obstrução física perto desse canto.

Isto valida uma fatia real do sistema (propagação RSSI), mas **não** valida a parte mais importante —
identidade tag↔pessoa — porque isso exige gente andando na cena com verdade anotada, que é justamente
o item pendente.

## 5. O que NUNCA foi tentado (honesto, sem eufemismo)

Nada disto tem sequer um protótipo:

- **Factor graph / GTSAM** — zero código. Adiado de propósito (stack é JS-first; GTSAM é Python/C++).
- **Sinkhorn / transporte ótimo com modelo de ambiguidade** — só o Hungarian *puro* foi tentado (e
  rejeitado). A peça que você aponta como "a fronteira patenteável" nunca chegou a ser testada na
  forma que você descreveu (combinado com mixture factors).
- **Gaussian Process completo** para o mapa de propagação — existe só um ajuste paramétrico simples
  (log-distância, 1-2 parâmetros) pelas 4 âncoras.
- **Multi-estação / trilateração** — o sistema usa 1 estação BLE só; gated por hardware (o dono tem
  um TC22 só).
- **Smoother** (estimativa consolidada retroativa) — só há filtro "ao vivo", nada de suavização offline.
- **Kalman / filtro de partículas** no associador indoor — não existe (só o tracker de caixas da câmera
  tem modelo de movimento próprio, independente da fusão BLE).
- **Kernels robustos (Huber/Cauchy)** contra outlier de RSSI — o sistema usa guardas discretas
  (mínimo de amostras, movimento mínimo, margem de ambiguidade), não kernel robusto.
- **GNN de reconstrução de trajetória** (o paralelo com CERN) — gated por escala (poucas tags hoje).
- **Fatores de mapa/planta** (paredes/corredores como restrição) — nada usa a planta ainda; a
  geometria pura para isso (`floor-polygon.ts`) existe mas está desconectada (ver §2).
- **Python** em qualquer parte do pipeline de fusão/associação — não existe; há só um script de spike
  de física de RSSI (`spike-scanner.py`), não um algoritmo de localização.

## 6. Avaliação honesta de maturidade

Isto é pesquisa aplicada com harness rigoroso, não um produto de identidade pronto. Números concretos
(pinos medidos em `replay-fusion.test.ts`, cenários sintéticos, associador de produção real): quando o
sistema **fala**, a precisão vai de **45,9%** (câmera não calibrada + estação sem ponto marcado — o
pior caso, `grade-sem-station`) a **100%** (pessoa parada — só abstém, nunca fala errado); no caso mais
comum sem calibração especial (`canonico`) fica em **82,5%**. A **cobertura** (fração das vezes que ele
decide falar, em vez de abster) vai de **0%** (parado, que é abstenção pura por desenho) a **~34%**
(canonico) — na maioria dos cenários fica entre 12% e 30%. Isto é o resultado desejado da invariante
"rótulo errado é pior que nenhum" — o sistema é conservador de propósito — mas significa que hoje ele
identifica corretamente uma **minoria** das oportunidades, não a maioria, mesmo nos cenários mais
favoráveis. Nenhum desses números foi confirmado em campo real com pessoas.

## 7. Backlog daqui pra frente (por ordem de valor/esforço, não por ambição)

1. **Executar o teste de campo com pessoas** (protocolo pronto, deferido pelo dono por disponibilidade,
   não por bloqueio técnico) — é o único caminho para saber se os números sintéticos se sustentam.
2. **Ligar `floor-polygon.ts`**: falta só a UI de desenhar/persistir o polígono navegável — a
   matemática já está pronta e testada.
3. **Corrigir a assimetria MJPEG** da plotagem de tags na grade (declarada, não corrigida).
4. **Multi-estação** — gated por hardware (segunda antena).
5. **Sinkhorn com modelo de ambiguidade explícito** — só depois de entender por que o Hungarian puro
   piorou (pergunta aberta para o especialista).

## 8. Perguntas abertas para o especialista

Mantidas do relatório anterior (`relatorio-especialista-2026-07-10.md` §6) — ainda sem resposta:
Sinkhorn sem modelo de ambiguidade vale a pena? GP completo faz sentido com o span estreito de
distância das âncoras atuais? Set-membership ∩navegável é mesmo a prioridade antes de multi-estação?
Qual viés corporal realista validar em campo? Vale desenhar a arquitetura do smoother antes de ter
dado acumulado?

## 9. Onde encontrar mais detalhe

- Narrativa completa do dia, com o experimento de circularidade passo a passo: `relatorio-especialista-2026-07-10.md`
- Matriz linha-a-linha sugerido×feito×pendente cruzando todos os seus documentos: `status-implementacao.md`
- Backlog vivo com limites honestos: `docs/analises/tags-bluetooth/PENDENCIAS.md`
- Números por cenário, reproduzíveis: `npx vitest run src/fusion/replay-fusion.test.ts --reporter=verbose`
