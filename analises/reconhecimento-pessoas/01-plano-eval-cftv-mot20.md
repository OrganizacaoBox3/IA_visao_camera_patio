# Plano — Eval de reconhecimento de pessoas em CFTV (MOT20)

> Sensor que faltava (diagnóstico `00-diagnostico-atual.md` §3): medir os DOIS sintomas — **perde
> pessoa andando** e **inventa pessoa** — contra **ground-truth rotulado à mão**, no pipeline REAL
> (worker.js + bytetrack.js), sem câmera. Antecede qualquer mexida no motor (doutrina: sensor antes do
> fix). Formato spec→plan→tasks (MANIFESTO §5). Não altera o motor — só cria `eval/` novo.

## 1. Objetivo e mapeamento sintoma→métrica

| Sintoma (do teste real) | Métrica que o mede |
|---|---|
| **Perde pessoa enquanto anda** | **recall** (GT detectado) + **ID-switches** + **fragmentação** de track |
| **Inventa pessoa (não-pessoa)** | **precisão** / **taxa de FP** (detecção sem GT correspondente) |
| **Custo da cadência (hipótese nº1)** | as métricas acima **varridas a 1 / 4 / 8 fps** — vira NÚMERO |

Bônus (régua da indústria): **MOTA** e **IDF1** (agregam recall+FP+ID-switch).

## 2. Dataset

- **MOT20** (motchallenge.net) — **escolhido**: multidão DENSA em ângulo de vigilância (estático,
  elevado) — o mais próximo de um CD lotado. Train (4 sequências: MOT20-01/02/03/05) tem **GT rotulado
  à mão** (`gt/gt.txt`: `frame,id,x,y,w,h,conf,class,vis`). 25 fps.
- **Complemento leve (opcional):** CAVIAR (já temos `bench-visao/clipe.mp4`) — corredor de shopping,
  poucas pessoas, pra sanidade rápida.
- **Qualitativo (não-medível):** streams públicos validados (`analises/cameras-publicas/`) — ver com
  os olhos, não entra no número.

## 3. Fora de escopo (explícito)

- Treinar/fine-tunar modelo (é a fase DEPOIS, guiada por estes números).
- Alterar `precision.js`/`worker.js`/`bytetrack.js` (o motor não muda até o eval existir e medir).
- Câmera-classe (MOT20 é câmera fixa de rua/praça; ângulo de CD real vem no eval de câmera quando
  houver acesso). MOT20 mede DOMÍNIO de vigilância + densidade, não o ângulo exato do CD.
- Latência/CPU (é o eval de perf; aqui é acurácia).

## 4. Abordagem (como os frames passam pelo pipeline REAL — paridade de produção, lição 02.3)

1. Carrega uma sequência MOT20: lista de frames (JPEG) + `gt.txt` (só `class=1 person`, `conf=1`).
2. **Amostra na cadência alvo**: MOT20 é 25 fps → 1 fps = 1 a cada 25 frames; 4 fps = 1 a cada ~6;
   8 fps = 1 a cada ~3. (Espelha o `ROUND_MS` que o engine usa.)
3. Cada frame amostrado → **worker.js de produção** (fork + IPC, o MESMO de `eval/gate.mjs`) → dets
   COCO → filtra `person` (como `pipeline.js:60`).
4. Alimenta o **bytetrack.js de produção** (knobs derivados do `precision.js`, como fiz no
   `eval/counting.mjs`) com `dt` = intervalo real da cadência → tracks emitidos por rodada.
5. **Casa** tracks emitidos × GT por frame (IoU ≥ 0.5, atribuição gulosa/Hungarian) e acumula:
   - recall = GT casado / GT total; precisão = casado / emitido; FP = emitido sem GT.
   - **ID-switch** = quando um GT-id, já casado a um track-id, passa a casar com OUTRO track-id
     (a assinatura de "perdeu e re-IDou a pessoa andando").
   - fragmentação = nº de interrupções na trajetória de cada GT.
6. Repete p/ fps ∈ {1,4,8} e por sequência; tabela `fps × sequência × métrica`.

## 5. Critérios de aceite (Given/When/Then)

- **G/W/T — mede recall real:** *Dado* uma sequência MOT20 com N pessoas-GT, *Quando* rodo o pipeline
  a 1 fps, *Então* reporto recall/precisão/FP com o número de GT e de dets (não sintético — dets do
  worker real sobre os JPEGs).
- **G/W/T — mede a continuidade:** *Dado* pessoas andando no GT, *Então* reporto **ID-switches por
  pessoa-minuto** a 1 fps — a métrica direta do "perde andando".
- **G/W/T — quantifica a cadência:** *Dado* a mesma sequência a 1/4/8 fps, *Então* a tabela mostra como
  recall e ID-switch **variam com o fps** (confirma ou refuta a hipótese nº1 do diagnóstico com número).
- **G/W/T — paridade de produção:** *Dado* o eval, *Então* ele usa o MESMO `worker.js` + `bytetrack.js`
  + knobs do `precision.js` (fonte única) — nunca reimplementa detector/tracker.
- **G/W/T — reprodutível:** *Dado* mesmo dataset + modelo, *Então* mesmos números (determinístico, CPU EP).

## 6. Riscos e mitigações

- **Download grande (MOT20 ~5 GB).** → Começar por 1 sequência (ex.: MOT20-02); provar o harness; só
  então rodar as 4. Baixa pra fora do repo (dataset não versiona — `.gitignore`).
- **Domínio ≠ CD exato** (MOT20 é rua/praça, não galpão). → Declarado no escopo; mede vigilância+
  densidade, não o ângulo do CD. O eval de câmera do CD entra quando houver acesso — este é o proxy
  medível agora.
- **Custo de rodar o detector em milhares de frames.** → A amostragem por cadência já corta (1 fps =
  4% dos frames); rodar por sequência, tempo declarado.
- **Métrica MOT tem sutilezas** (matching, vis threshold). → Começar com recall/precisão/ID-switch
  (claras e suficientes p/ os 2 sintomas); MOTA/IDF1 como bônus, com a fórmula citada.

## 7. Tarefas

- **[S] T1** Baixar MOT20 (1 sequência primeiro → depois as 4) p/ fora do repo; `.gitignore` do dataset.
- **[S] T2** `eval/persons-mot.mjs`: loader (frames + gt.txt), amostrador por cadência, fork do worker
  (reusa o padrão do `gate.mjs`), tracker de produção (knobs do `precision.js`), matcher IoU, métricas.
- **[S] T3** Rodar 1 sequência a 1/4/8 fps; conferir sanidade (recall plausível, ID-switch cai com fps).
- **[P] T4** Escalar p/ as 4 sequências; consolidar tabela.
- **[S] T5** Registrar resultados em `02-resultado-eval-mot20.md` (re-medição): tabela + leitura honesta
  (o que os números CONFIRMAM/REFUTAM do diagnóstico) + próximas alavancas priorizadas PELOS números.
- **[P] T6** (opcional) sanidade CAVIAR + olhada qualitativa nos streams públicos.

## 7.1 Execução — nota de bloqueio (2026-07)

**T1 travou:** `motchallenge.net` (fonte canônica do MOT20) dá **timeout na 443** deste ambiente
(control host github = HTTP 200 em 1,2s → é o host do MOT20, não a rede). Mirrors só no **Kaggle**
(`ismailelbouknify/mot-20`) atrás de login+reCAPTCHA — sem token de API não é scriptável. Saídas:
(a) token Kaggle → `kaggle datasets download -d ismailelbouknify/mot-20` (MOT20 direto, scriptado);
(b) download manual (navegador) → apontar a pasta; (c) **CAVIAR primeiro** (clipe local + GT de
Edinburgh, host que já respondeu) p/ provar o harness e ter os PRIMEIROS números hoje — MOT20 entra
depois (loader plugável). O harness é agnóstico ao dataset (loader por formato); a densidade do MOT20
é upgrade, não pré-requisito das 3 métricas.

## 7.2 Execução — resolução do bloqueio (2026-07, decidido)

MOT20-com-GT **indisponível neste ambiente**: motchallenge.net = timeout; Kaggle `ismailelbouknify/
mot-20` = **só o split TEST** (04/06/07/08, **sem GT** — o MOT20 esconde o GT do test de propósito, arXiv
2003.09003); sem mirror HF/GitHub baixável com train+GT. Auth do Kaggle **funciona** (username
`cristhyano` + token KGAT), mas o dado rotulado não está lá. **Decisão: CAVIAR primeiro** (clipe local +
GT de Edinburgh) p/ ter os primeiros números hoje; o harness é plugável → MOT20 entra quando o train+GT
for obtido (motchallenge de volta, ou download manual do `MOT20.zip`). Loader do harness nasce
**MOT-nativo** (`frame,id,x,y,w,h`) — CAVIAR é adaptado a esse formato; MOT20 encaixa direto depois.

## 8. Próximo passo

Baixar MOT20-02 + montar o `persons-mot.mjs` e rodar a 1/4/8 fps numa sequência — a primeira tabela
`fps × recall × ID-switch` já responde "quanto a cadência custa". Depois escala e registra o resultado.
