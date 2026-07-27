# Vale trocar o motor de linguagem? — MEDIÇÃO (2026-07-27)

> **Frente P1.** Pergunta do dono: _"vale trocar o motor para outra linguagem? acredito que Python
> possa ter algo mais avançado."_ Este documento é **medição**, não opinião. Nenhum arquivo de código
> do projeto foi alterado — o caminho de produção (`server/analysis/worker.js`) foi **lido** e
> replicado numa cópia instrumentada no scratchpad; o teste de escala **forka o `worker.js` real**.

---

## ⚠️ PONTO CEGO — leia antes dos números

**Tudo aqui foi medido numa máquina de dev Apple Silicon. O alvo de produção é outro hardware.**

| | Bancada desta medição | Alvo de produção (citado nos docs) |
| --- | --- | --- |
| CPU | Apple M5, 10 cores **heterogêneos** (4 P + 6 E) | homolog **4-core x86** |
| ISA | arm64 (NEON) | x86-64 (AVX2/VNNI) |
| SO | darwin 25.4.0 | Windows/Linux |

**O que NÃO transfere:**

1. **O ponto de saturação da §4 é artefato de core heterogêneo.** Saturar em 2 workers × 2 threads
   coincide com os 4 P-cores do M5 — isso é _inferência_ sobre a medição, não medição. Num x86
   homogêneo de 4 cores a curva é outra e **tem de ser remedida lá**.
2. **Os tempos absolutos de `session.run`.** O kernel do ORT em AVX2/VNNI tem perfil diferente do
   NEON. Já há precedente registrado no repo: o INT8 **reprovou no custo** em ARM e o próprio doc
   declarou que "AVX2/VNNI pode inverter o sinal" (`docs/analises/spec-overlay-tempo-real.md` §3).
3. **DML não é testável aqui** (é Windows). A nota do projeto sobre "DML retorna saída errada"
   **permanece não-verificada** nesta bancada — não a confirmo nem a refuto.

**O que transfere** (é propriedade do software, não do silício): a **decomposição relativa** do custo
(§1), a **identidade bit-a-bit** entre os runtimes (§2) e a **contagem de testes/LOC** (§5).

**Bancada:** Node v26.5.0 · `onnxruntime-node` **1.27.0** (dylib `libonnxruntime.1.27.0.dylib`
empacotada) · `sharp`/libvips · Python 3.14.6 · `onnxruntime` (PyPI) **1.27.0** — versão **pinada
para casar com a do Node**, senão o A/B teria confundido runtime com versão.
**Modelo:** `dfine_s_obj2coco.onnx` (39,6 MB — o default de produção, `ANALYSIS_MODEL=s`).
**Knobs:** lidos de `precision.js` — input 640, scoreMin 0,25, nmsIou 0,6.
**Fixtures:** os 29 JPEGs de `eval/fixture/img` (COCO, ~0,29 MP) **e** os mesmos 29 reescalados para
1920×1080 q80 (~2,07 MP) — porque o custo de decode escala com o pixel de origem e o frame de CFTV
real não é COCO.

---

## 1. Decomposição real do custo por frame

D-FINE-S · CPU EP · `intraOpNumThreads=2` · input 640 · **N = 145 frames por linha** (29 imgs × 5 reps).

### 1a. Fixture COCO (~0,29 MP)

| Etapa | Onde executa | p50 (ms) | p95 (ms) | % do frame (p50) |
| --- | --- | ---: | ---: | ---: |
| decode + resize (`sharp`) | **C++** (libvips) | 3,716 | 4,531 | 5,59% |
| `rgbToTensor` | **JS** | 0,596 | 0,721 | 0,90% |
| **`session.run`** | **C++** (ORT) | **62,274** | **64,805** | **93,67%** |
| `postprocess` + NMS | **JS** | 0,029 | 0,057 | 0,04% |
| **total** | | **66,479** | **69,107** | 100% |

### 1b. Mesmas imagens a 1920×1080 (~2,07 MP) — mais perto do frame real

| Etapa | Onde executa | p50 (ms) | p95 (ms) | % do frame (p50) |
| --- | --- | ---: | ---: | ---: |
| decode + resize (`sharp`) | **C++** (libvips) | 6,435 | 7,744 | 9,22% |
| `rgbToTensor` | **JS** | 0,591 | 0,750 | 0,85% |
| **`session.run`** | **C++** (ORT) | **62,823** | **70,661** | **89,97%** |
| `postprocess` + NMS | **JS** | 0,031 | 0,058 | 0,04% |
| **total** | | **69,824** | **79,085** | 100% |

### Fração de inferência medida **por frame** (não razão de p50s)

| Fixture | p50 | p95 | **mín** | **máx** | N |
| --- | ---: | ---: | ---: | ---: | ---: |
| COCO | 93,56% | 95,25% | 91,92% | 95,90% | 145 |
| 1080p | 89,96% | 90,87% | **88,17%** | 91,73% | 145 |

**Repetibilidade** (3 execuções independentes, 1080p, N=87 cada): total p50 = 70,5 / 71,2 / 71,5 ms
(dispersão ~1,5%); fração de inferência = 90,005% / 90,088% / 90,104% (dispersão <0,1 pp). **A fração
é muito mais estável que o tempo absoluto.**

> ### ✅ VEREDITO — a afirmação "89–97% do custo do frame" **CONFIRMA-SE**
>
> Origem da afirmação: `docs/analises/retrofit-2/02-motor-analysis.md:182` (era estimativa de
> hot-path, não medição). Medido aqui: **89,96%** (1080p) e **93,56%** (COCO) na mediana.
> **Ressalva honesta:** o **piso por frame** medido a 1080p é **88,17%**, marginalmente **abaixo** do
> "89" declarado. A faixa medida completa é **88,2%–95,9%**, não 89–97%.

**O achado que a decomposição revela e que a pergunta original não previa:** a fatia de pré/pós
**não é JavaScript**. O decode+resize — 5,6% a 9,2%, ou seja **86–94% de todo o pré/pós** — já roda
em C++ (libvips). O que de fato executa em JS é `rgbToTensor` + `postprocess` = **0,622 ms = 0,89%**
do frame a 1080p (0,625 ms = 0,94% no COCO).

---

## 2. Teto do que a linguagem poderia ganhar (aritmética sobre a medição acima)

Amdahl sobre o p50 medido. Duas leituras — a honesta e a generosa.

### 2a. Leitura honesta: acelerar o que **realmente é JS** (0,622 ms = 0,89% @1080p)

| Cenário | Novo total | **Ganho no frame** | Speedup |
| --- | ---: | ---: | ---: |
| JS 5× mais rápido | 69,33 ms | **0,71%** | 1,007× |
| JS 10× mais rápido | 69,26 ms | **0,80%** | 1,008× |
| JS com **custo ZERO** (teto absoluto) | 69,20 ms | **0,89%** | 1,009× |

### 2b. Leitura generosa: acelerar **todo** o pré/pós, incluindo o decode do libvips

Cenário deliberadamente favorável ao Python — assume que numpy/OpenCV bateriam o libvips em 5–10×,
o que a §2c mostra ser falso. Serve como **limite superior inatingível**.

| Cenário | 1080p: novo total / ganho | COCO: novo total / ganho |
| --- | ---: | ---: |
| pré+pós 5× | 64,18 ms / **8,09%** | 63,01 ms / **5,22%** |
| pré+pós 10× | 63,47 ms / **9,10%** | 62,57 ms / **5,88%** |
| pré+pós **custo ZERO** | 62,77 ms / **10,11%** | 62,14 ms / **6,53%** |

### 2c. A premissa "numpy é 5–10× mais rápido" foi **MEDIDA e REFUTADA**

Implementei o pós-processamento em numpy **vetorizado** (argmax sobre (300,80), sigmoid e corte
sem laço Python). Não ganhou — **perdeu**:

| Etapa | Node (JS) p50 | Python (numpy) p50 | **py/node** |
| --- | ---: | ---: | ---: |
| `rgbToTensor` / `to_tensor` | 0,596 ms | 0,706 ms | **1,19× mais lento** |
| `postprocess` + NMS | 0,029 ms | 0,093 ms | **3,21× mais lento** |

O laço JS de 1,2 M floats é JIT-compilado e já opera perto da banda de memória; o numpy paga
overhead de interpretador no NMS (laço sobre dicts) e nas conversões. **A fatia que a troca de
linguagem moveria não fica mais rápida em Python — fica mais lenta.**

---

## 3. Execution providers **disponíveis nesta máquina**

`ort.getAvailableProviders()` **não existe** no `onnxruntime-node` 1.27.0 (essa é a API do pacote
Python). O equivalente é `ort.listSupportedBackends()`:

```
node   → [{"name":"cpu"},{"name":"webgpu"},{"name":"coreml"}]   (todos bundled:true)
python → ['CoreMLExecutionProvider', 'AzureExecutionProvider', 'CPUExecutionProvider']
```

**Sim, o CoreML EP está disponível pelo `onnxruntime-node`** — e mais: o Node traz **WebGPU**, que
o wheel Python **não** traz. Nesta máquina o Node tem acesso a **mais** EPs que o Python.

### Medição — D-FINE-S, COCO, 2 threads, N=145

| EP | infer p50 (ms) | total p50 (ms) | loadMs | CPU core·s/frame | **Paridade de saída** |
| --- | ---: | ---: | ---: | ---: | --- |
| **cpu** | **62,274** | **66,479** | 145 | 0,1398 | referência |
| **coreml** | 103,695 (**+66%**) | 107,999 | 1.750,9 (**12×**) | 0,1838 (+31%) | ❌ **REPROVA** |
| **webgpu** | — | — | — | — | ❌ **CRASHA** |

**CoreML — reprovação dupla.** Não só é 66% mais lento e 31% mais caro em CPU: **muda a saída.**
Contra o CPU EP nas mesmas 29 imagens — 594 detecções (cpu) vs 596 (coreml), **591 casadas** a
IoU≥0,5, **3 perdidas**, **5 inventadas**, divergência de score p95 = 0,0082 e **máx = 0,1145**,
**4/29 imagens divergem**. Pela regra do enunciado, saída diferente é reprovação — e aqui nem
haveria o que ponderar, porque também perdeu em tempo.

**WebGPU — falha dura, a nota do projeto segue verdadeira em ORT 1.27.0:**

```
[E:onnxruntime:, sequential_executor.cc:620 ExecuteKernel] Non-zero status code returned while
running MatMul node. Name:'/model/decoder/integral/MatMul' Status Message: ...
Invalid dimension of 18446744073709551615 for SizeToDimension. Tensor has 1 dimensions.
```

**DML:** não aplicável em darwin/arm64. **Não verificado** — a afirmação do projeto continua de pé
sem confirmação desta bancada.

> **Conclusão do item 3:** a escolha "CPU EP apenas" documentada em `worker.js:336` e no
> `README.md` §Dimensionamento **é a escolha correta nesta máquina, e por evidência nova** (o CoreML
> nem existia na análise original). Nenhum EP alternativo muda o quadro a favor.

### 3b. A/B DIRETO Node × Python — o teste decisivo do reenquadramento

Mesmo `.onnx`, mesmo ORT **1.27.0**, mesma máquina, mesmas imagens, mesmos knobs, CPU EP, 2 threads.

| Etapa | COCO node p50 | COCO py p50 | py/node | 1080p node p50 | 1080p py p50 | py/node |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| decode+resize | 3,716 | 2,138 | 0,58× | 6,435 | 6,760 | 1,05× |
| tensor | 0,596 | 0,706 | 1,19× | 0,591 | 0,690 | 1,17× |
| **`session.run`** | 62,274 | 63,706 | **1,02×** | 62,823 | 62,622 | **1,00×** |
| postprocess | 0,029 | 0,093 | 3,21× | 0,031 | 0,089 | 2,87× |
| **total** | **66,479** | **66,758** | **1,004×** | **69,824** | **70,210** | **1,006×** |

**Diferença total: 0,4% (COCO) e 0,6% (1080p) — dentro da dispersão run-to-run de 1,5% medida na §1.
Isto é empate, não vantagem.**

#### Prova de que é a mesma biblioteca: **saída bit-a-bit idêntica**

Dumpei o tensor de entrada do Node (`[1,3,640,640]` fp32) para disco e rodei o **mesmo tensor** nos
dois runtimes:

```
logits  : idênticos bit-a-bit? True | max|diff| = 0.0
pred_boxes: idênticos bit-a-bit? True | max|diff| = 0.0
```

**O reenquadramento está CONFIRMADO por medição, não por argumento:** `onnxruntime-node` e
`onnxruntime` (Python) são binding da mesma lib C++ e produzem saída **exatamente igual**.

#### Mas atenção — a porta para Python **não seria neutra na acurácia**

Rodando cada runtime com **sua própria** biblioteca de imagem (sharp/libvips vs PIL), as detecções
**divergem muito mais** que entre EPs: 594 dets (node) vs 605 (python), **apenas 521 casadas**
a IoU≥0,5, **73 perdidas**, **84 inventadas**, **14 divergências de classe**, **21/29 imagens
diferem**.

Causa medida (não suposta): é o **resize**, não o runtime. Comparando o tensor do PIL contra o do
sharp na mesma imagem, **>1/255 de diferença em ~82% dos pixels — com qualquer kernel**:

| Kernel do PIL | max\|Δ\| | mean\|Δ\| | pixels com Δ > 1/255 |
| --- | ---: | ---: | ---: |
| BILINEAR | 0,5412 | 0,0378 | **81,84%** |
| LANCZOS | 0,5569 | 0,0406 | **82,88%** |
| BICUBIC | 0,5608 | 0,0396 | **82,46%** |

Ou seja: uma reescrita em Python **teria de repassar o gate `eval/` inteiro** (detecção + contagem),
porque a acurácia mudaria — sem nenhum ganho de tempo em troca.

---

## 4. Escala por processo (`worker-host`)

Forkando o **`worker.js` de produção** pelo protocolo IPC real. 2 `cameraId` por worker (a fila é
último-vence com profundidade 1 **por câmera**; com 2 câmeras e re-envio na resposta a fila nunca
esvazia → mede **teto**). Fixture 1080p, D-FINE-S, 20 s por ponto, `dropped=0` e `errors=0` em todos.

| K workers | threads | frames | **fps agregado** | fps/worker | lat p50 (ms) | lat p95 (ms) | %CPU (soma dos filhos) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2 | 284 | 14,20 | 14,20 | 139,0 | 149,4 | 201% |
| **2** | 2 | 423 | **21,15** | 10,57 | 184,9 | 204,8 | 393% |
| 4 | 2 | 427 | 21,35 | 5,34 | 360,7 | 496,8 | 770% |
| **5** ← default aqui | 2 | 420 | 21,00 | 4,20 | 430,9 | 883,4 | 940% |
| 8 | 2 | 413 | 20,65 | 2,58 | 759,1 | 875,9 | 970% |

Varredura de threads (15 s por ponto):

| K | threads | fps agregado | lat p50 | %CPU |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 2 | 19,73 | 197,2 | 402% |
| 4 | 1 | 19,40 | 353,0 | 403% |
| 1 | 4 | 15,40 | 122,8 | 396% |
| 1 | 8 | **descartado** | — | — |

> _K=1/t8 descartado como **artefato de instrumento**: o wall-clock deu 116 s para 15 s pedidos — o
> `setTimeout` do processo **pai** não disparou por fome de CPU. A medida de fps é inválida; não a
> reporto como resultado._

**Onde satura: em K=2.** De K=2 → K=5 o CPU sobe **2,4×** e o throughput fica em **0,99×** — zero
ganho — enquanto a latência p50 **piora 2,3×** (185 → 431 ms) e a p95 **4,3×** (205 → 883 ms).
Teto agregado da máquina ≈ **21 fps** com S@640 — ou seja **~21 câmeras @1fps**, ~7 @3fps.

**Dispersão:** o mesmo ponto K=2/t2 deu 21,15 fps (corrida de 20 s) e 19,73 fps (corrida de 15 s) —
**~7% de variação run-to-run**. Toda diferença menor que isso na tabela é ruído; o contraste
K=2 vs K=5 (2,4× de CPU por 0% de throughput) está muito acima dela.

### Achado operacional colateral (fora do escopo da pergunta, mas medido)

`resolveWorkerCount` (`worker-host.js:44`) = `min(floor(cores/2), câmeras)`, piso 1. Nesta máquina
`os.cpus().length` = 10 → **5 workers** no boot (quando `cameras=0`) ou com ≥5 câmeras. **5 é o pior
ponto medido da tabela em latência** por throughput idêntico ao de 2. No homolog 4-core x86 a mesma
função resolve **2** — que aqui é justamente o ótimo. **Isto é observação desta bancada, e a §Ponto
Cego se aplica: a curva tem de ser remedida no x86 antes de mexer em qualquer default.** Registro
como pista para outra frente, não como recomendação de mudança.

---

## 5. O que Python NÃO resolveria — o custo da reescrita, em número

`npx vitest run server/analysis` → **462 testes / 21 arquivos, 21 passed, 2,43 s.**

| | Testes | % |
| --- | ---: | ---: |
| Fatia que uma porta para Python substituiria (pré/pós do detector — `worker.test.js`) | **18** | **3,9%** |
| **Tudo o mais — teria de ser reescrito e revalidado do zero** | **444** | **96,1%** |

Os 18 de `worker.test.js` cobrem exatamente `iouXYWH`, `postprocess`, `nmsPerClass`, `containment`,
`fuseTiles`, `tileGrid` — isto é, **a fatia de 0,89% do frame** da §2a.

Detalhamento dos 444 que **não são inferência**:

| Módulo | Testes | Responsabilidade (nada disso é inferência) |
| --- | ---: | --- |
| `bytetrack` (+`.parity`) | 48 + 37 = **85** | tracking, associação, guarda de nascimento |
| `zones` | 45 | zonas, polígonos, ocupação |
| `counting` | 43 | contagem fim-a-fim, tripwires |
| `pipeline` | 37 | orquestração da rodada |
| `engine` | 30 | motor, tick, despacho, camcfg |
| `autoscale` | 29 | troca de tier em runtime |
| `worker-host` (+`.pool`) | 29 + 5 = **34** | pool, spawn/respawn, roteamento |
| `presence-alert` | 23 | alarme de presença |
| `automask` / `motion` / `telemetry` | 16 + 16 + 16 = **48** | máscara, gate de movimento, telemetria |
| `focus` | 14 | cadência/foco |
| `go2rtc-source` | 12 | ingest RTSP/WebRTC |
| `precision` | 10 | painel de knobs |
| `inflight` | 9 | slots de concorrência |
| Fadiga (`risk`/`worker`/`host`) | 9 + 9 + 7 = **25** | modo especializado (outro modelo) |

**Superfície de código** em `server/analysis/`: **5.752 LOC** de código + **5.403 LOC** de teste.
`worker.js` — o **único** arquivo que toca o ORT — tem **354 LOC (6,2%)**, e dentro dele apenas
~190 LOC são pré/pós. Os outros **93,8%** (`engine.js` 873, `bytetrack.js` 558, `worker-host.js` 378,
`zones.js` 369, `counting.js` 361, `go2rtc-source.js` 355 …) não têm relação com a linguagem em que
a inferência roda.

E isso é só `server/analysis/`. Fora dele e igualmente fora do alcance de um ganho de inferência:
os **contratos socket** (`analysis-status`, `analysis-tracks`, `frame`, `alarm-event` — invariante do
`CLAUDE.md` §3), a persistência Postgres, o alarme/Andon/WhatsApp e o front React que espelha tudo.

---

## Conclusão

**Sobre trocar a linguagem do motor — a medição não sustenta a troca, e o número é o seguinte:**

1. **A inferência já é C++, e isso está provado por igualdade bit-a-bit**, não por argumento:
   mesmo tensor → `logits` e `pred_boxes` idênticos (max|Δ| = 0,0) entre `onnxruntime-node` e
   `onnxruntime` Python, ambos 1.27.0. O A/B fim-a-fim deu **1,004×/1,006×** — empate dentro do
   ruído de 1,5%.
2. **A linguagem move 0,89% do frame** (1080p; 0,94% no COCO). Mesmo com custo **ZERO** — teto
   inatingível — o frame melhora **0,89%**. Com a hipótese generosa (5–10× em *todo* o pré/pós,
   incluindo o decode que já é libvips C++), o teto vai a **8,1–9,1%**.
3. **E a premissa do ganho foi refutada na medição:** o pós-processamento em numpy vetorizado ficou
   **3,2× mais lento** que o laço JS, e a conversão de tensor **1,19× mais lenta**. A fatia não fica
   mais rápida em Python.
4. **Custo do outro lado da balança: 444 testes (96,1% da suíte de `server/analysis`) e ~5.400 LOC**
   que não são inferência e teriam de ser reescritos e revalidados — mais o gate `eval/` inteiro,
   que **mudaria de resultado** por causa da troca de libvips por PIL (82% dos pixels diferem,
   521/594 detecções casadas).
5. **"Algo mais avançado" existe, e foi testado: não é a linguagem, é o execution provider — e os
   dois disponíveis aqui reprovaram.** CoreML: +66% de latência **e** saída diferente. WebGPU:
   crash. A escolha "CPU EP apenas" do projeto está correta nesta máquina.

**A alavanca real que a medição encontrou não é linguagem: é dimensionamento.** A §4 mostra
throughput saturando em K=2, com K=5 (o default resolvido aqui) gastando 2,4× de CPU por 0% de
ganho e 2,3× de latência. Isso é ~140% de CPU desperdiçado — ordens de grandeza acima do 0,89% que
a troca de linguagem disputa. **Mas veja a ressalva do item seguinte antes de agir.**

### O que esta medição NÃO permite concluir (e onde teria de ser medido)

- **Nada sobre o desempenho no alvo de produção.** Todos os tempos absolutos e o ponto de saturação
  são de um M5 4P+6E arm64. **A medição que falta é a §1 e a §4 repetidas no homolog 4-core x86** —
  e só lá se pode decidir qualquer default de pool. A hipótese de que a saturação em K=2 vem dos 4
  P-cores é **inferência**, não medição: eu não isolei afinidade de core.
- **Nada sobre DML** (Windows) — não testável aqui. A afirmação do projeto segue não-verificada.
- **Nada sobre caminhos que exigiriam hardware ou download pesado que não fiz:** TensorRT/CUDA
  (exige NVIDIA), OpenVINO EP (x86, e é justamente o EP que o wheel Python tem e o Node não —
  **essa é a única vantagem plausível de Python que esta bancada não pôde medir**, e ela só existiria
  no x86 de produção), e PyTorch/MPS. Se alguém quiser reabrir a pergunta com honestidade, **o
  experimento certo é OpenVINO EP no homolog x86 — não "reescrever o motor em Python"**, porque
  esse EP se avalia sem trocar linguagem nenhuma para a parte que importa.
- **Acurácia:** a paridade aqui foi medida em **29 imagens** do fixture, não no full-set. Uma
  reprovação de EP (CoreML) é conclusiva, mas uma *aprovação* nesse N não seria.

### Scripts (reproduzíveis)

Em `/private/tmp/claude-501/.../scratchpad/`: `bench-decompose.mjs` (decomposição, cópia
instrumentada do `worker.js`), `bench_py.py` (mesmo pipeline em Python/numpy), `bench-scale.mjs`
(forka o `worker.js` real, throughput por K), `parity.mjs` (paridade de detecções entre dois runs),
`dump-tensor.mjs` (teste bit-a-bit). Saídas em `out-*.json` e `scale-*.json`.
