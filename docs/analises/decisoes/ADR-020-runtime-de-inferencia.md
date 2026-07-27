# ADR-020 — Runtime de inferência: vale um motor em outra linguagem (Python)?

Data: 2026-07-26 · **Status: proposto** (dois dos três eixos aguardam a medição da frente P1 —
os slots `[P1]` abaixo são placeholders, **nenhum número foi inferido**) · Complementa o ADR-009
(motor no hub) e o ADR-015 (ReID visual como pilar de identidade).

## Contexto

Pergunta do dono, literal: *"vale usar um motor em outra linguagem? acredito que Python possa ter
algo mais avançado."*

A pergunta é boa e a intuição tem fundamento — mas embrulha **três perguntas diferentes** que têm
respostas diferentes, custos diferentes e evidências diferentes. Separá-las é metade da decisão.

### Eixo (a) — VELOCIDADE de inferência: a linguagem quase não participa

O `onnxruntime-node` e o `onnxruntime` do Python **não são dois motores**. São dois *bindings finos*
sobre o **mesmo core C++** (`microsoft/onnxruntime`). Evidência local, verificada nesta máquina no
pacote instalado (`onnxruntime-node@1.27.0`):

| Plataforma (prebuilt no pacote) | core C++ | binding da linguagem |
|---|---|---|
| darwin/arm64 | `libonnxruntime.1.27.0.dylib` — **38,8 MB** | `onnxruntime_binding.node` — 267 KB |
| linux/x64 | `libonnxruntime.so.1` — 38,0 MB | 389 KB |
| win32/x64 | `onnxruntime.dll` — 26,0 MB (+ `DirectML.dll`) | 422 KB |

O trabalho pesado (`session.run`) roda em C++ **nos dois casos**. Trocar JS por Python **não move o
kernel de convolução**. O que a linguagem controla é a **borda**: decode do JPEG, montagem do tensor,
pós-processamento e IPC. E a borda deste worker é pequena por construção:

- `sharp` (decode/resize) já é **libvips em C++** — a mesma classe de biblioteca que Pillow-SIMD/OpenCV.
  Não há ganho de linguagem aqui, há troca de biblioteca C++ por biblioteca C++.
- `rgbToTensor` (`server/analysis/worker.js:77-86`) é o **único laço JS realmente grande**: a 640×640
  são 409.600 iterações e ~1,2 M escritas `float32` por inferência. Em Python isso viraria `numpy`
  (C). É o candidato mais plausível a ganho de linguagem — e é **exatamente um slot de medição**.
- `postprocess` (`worker.js:137-164`) varre 300 queries × 80 classes = 24.000 comparações. Ordem de
  grandeza irrelevante.

Medição **já existente** (spike-dfine-hub.md §3, D-FINE-N, ultrabook 4C): decode p50 **23-24 ms**
contra inferência p50 **120-132 ms** — a borda já era minoria. Com o default atual (D-FINE-S, ~2,4×
o CPU do N — `eval/MODELS.md`) a fatia de inferência **cresce** e a da borda encolhe. Mas esse número
é de outra máquina, outro modelo e outra época: **a fatia por etapa hoje é `[P1]`.**

> **A aritmética que decide este eixo é Amdahl, não preferência.** Se a fatia não-inferência é `f`, o
> teto de ganho ao zerá-la é `1/(1−f)`. Um teto que não chega a 2× não paga um segundo runtime.

### Eixo (b) — ACESSO A HARDWARE / execution providers: aqui há assimetria real, mas menor que a fama

A crença de que "Node não alcança GPU" é **falsa no geral e verdadeira em casos específicos**. O que o
prebuilt do `onnxruntime-node@1.27` declara (README do próprio pacote, tabela de EPs) e o que esta
máquina responde ao ser sondada:

```
node -e "require('onnxruntime-node').listSupportedBackends()"
→ [ {cpu, bundled:true}, {webgpu, bundled:true}, {coreml, bundled:true} ]   (darwin/arm64)
```

| EP | onnxruntime-node (prebuilt) | Python (`pip`) | Status NESTE projeto |
|---|---|---|---|
| CPU (MLAS, usa AVX-512/VNNI quando existe) | ✔ todas as plataformas | ✔ | **ponto de operação atual** |
| CoreML | ✔ macOS x64/arm64 (**sondado, presente**) | ✔ | nunca testado (macOS é dev, não produção) |
| DirectML | ✔ Windows (a `DirectML.dll` vem no pacote) | ✔ | **REPROVADO** — 25% mais rápido e **0 detecções** (spike §5) |
| WebGPU | ✔ experimental (win/linux-x64/mac) | — | **REPROVADO** — crash em `MatMul /model/decoder/integral/MatMul` (spike §5) |
| CUDA | ✔ Linux x64 (download pós-install) | ✔ `onnxruntime-gpu` | não testado — sem NVIDIA no alvo |
| **TensorRT** | ✘ ausente da tabela de prebuilts | ✔ | não testado |
| **OpenVINO** | ✘ sem prebuilt | ✔ `onnxruntime-openvino` | não testado |

**Leitura honesta:** a assimetria Node↔Python **existe** e se concentra em **TensorRT** (NVIDIA) e
**OpenVINO** (Intel). Os EPs mainstream (CPU, CoreML, DML, CUDA, WebGPU) estão nos dois lados. E o
alvo de hardware que a casa **já escolheu** (`docs/analises/hardware-ideal.md`) é **AMD Ryzen com
AVX-512 VNNI, sem GPU** — a linha "Nunca comprar" inclui GPU explicitamente. Sobre esse alvo:
TensorRT não se aplica (sem NVIDIA) e o valor do OpenVINO sobre uma CPU AMD é, no mínimo, discutível
(o plugin de CPU do OpenVINO é otimizado para Intel; o CPU EP do ORT já usa MLAS com AVX-512).

Duas notas que mudam o peso deste eixo:

1. **O multiplicador de 2-3× que o levantamento de hardware persegue é INT8/VNNI, e o CPU EP do Node
   executa modelo quantizado normalmente.** O que falta no Node **não é executar** INT8 — é a
   **ferramenta de quantizar** (`onnxruntime.quantization`, só Python). Isso é oficina, não linha de
   produção (ver eixo c). O `eval/reid.mjs:323` já declara essa lacuna com todas as letras.
2. **Qualquer EP acelerado carrega o mesmo risco que já nos mordeu uma vez.** O DML foi **mais rápido
   e errado** — o caso de livro do "falso-OK é pior que erro" do CLAUDE.md. Nenhum EP entra sem gate
   de **paridade de detecção**, em nenhuma linguagem.

### Eixo (c) — CAPACIDADE QUE HOJE NÃO EXISTE: o eixo que importa para o produto, e onde a resposta é estrutural

Este é o eixo onde a intuição do dono está **certa** — e onde, por sorte, a resposta **não exige um
runtime novo em produção**. As três lacunas nomeadas:

| Lacuna | Estado hoje | Como chega à produção |
|---|---|---|
| **ReID por aparência** | ADR-015 nomeia como pilar; o tracker é **só geometria** (limitação declarada no cabeçalho de `server/analysis/bytetrack.js` e do par TS) | **OSNet `.onnx`** rodando no worker Node. **Já está fiado**: `eval/reid.mjs` roda OSNet em `onnxruntime-node` CPU EP, com o crop pelo mesmo `sharp.extract` do worker |
| **Tracker com embedding** (BoT-SORT/StrongSORT) | ByteTrack-lite, sem aparência | É **algoritmo, não modelo**: IoU + cosseno de embedding. Some ao ByteTrack que já existe e já tem 48 testes. Reescrever em Python criaria um **TERCEIRO** ByteTrack para manter em paridade |
| **Detector de CAIXAS fine-tunado** | `pipeline.js:73` filtra `class !== "person"`; caixa só existe no navegador via OWL-ViT zero-shot (auditoria 2026-07-26 §3.2 — some com a aba fechada) | Fine-tune **já planejado em Python/Colab** (`docs/analises/reconhecimento-pessoas/08-finetune-colab-setup.md`) → `export_onnx.py` no mesmo shape → dropar em `server/models/` |

**A distinção que responde a pergunta do dono:**

> **Python já é obrigatório — na OFICINA (treino, quantização, export), não na LINHA DE PRODUÇÃO
> (inferência).** Treinar é Python e sempre foi (PyTorch, D-FINE, torchreid). Quantizar é Python
> (`onnxruntime.quantization`). O produto dessa oficina é um **arquivo `.onnx`** — e o worker Node
> executa `.onnx` desde o ADR-009. **Adotar tudo que Python "tem de mais avançado" no eixo de
> modelos custa ZERO runtime novo.**

O "algo mais avançado" do Python é, em ~90% dos casos, **um modelo ou um treino** — e esses atravessam
a fronteira como ONNX. A exceção seria uma capacidade cujo **único** caminho é uma biblioteca presa ao
runtime Python, sem export ONNX viável. **Nenhuma das três lacunas acima é desse tipo.**

### O que está em jogo do outro lado (o custo que a pergunta não vê)

- **O motor tem 425 testes** em `server/analysis/*.test.js` (1.344 no repo). Tracking, contagem,
  zonas, exclusão, alarme, autoscale, telemetria, pool/respawn — a parte **testada e cara** não é a
  inferência, é tudo o que está em volta dela.
- **A casa já paga um débito de paridade:** dois ByteTracks (TS no front, JS no hub) com paridade
  mantida "por revisão em par, **não por sensor**" — residual declarado no cabeçalho de
  `bytetrack.js`. Uma terceira implementação em Python é uma terceira fronteira do mesmo débito.
  *(Nota de integração, 2026-07-26: uma frente paralela está introduzindo o sensor de paridade
  cross-language — `bytetrack.parity.test.js`/`.ts` + fixtures. Se ele entrar, o débito vira
  **medido** para 2 lados; o argumento aqui não muda de sinal — passa a ser "cada fronteira nova
  custa mais um par de fixtures a manter", que é o custo real, não o risco silencioso.)*
- **O contrato IPC tem 6 consumidores:** o engine (via `worker-host.js`) + `eval/gate.mjs`,
  `eval/compare-models.mjs`, `eval/persons-cftv.mjs`, `eval/reid.mjs`, `eval/run-eval.mjs` (todos via
  `eval/lib.mjs startWorker`). É o mesmo processo do gate de acurácia da casa.

## Decisão

**1. Nada muda agora. O status quo (Node + `onnxruntime-node`, CPU EP, worker pool) permanece.**
Não porque seja obviamente o melhor, mas porque **não há número que justifique a troca**, e a casa não
troca arquitetura sem número (CLAUDE.md §5, §6).

**2. O eixo (c) está DECIDIDO, e a favor de Python — na oficina.** Fine-tune, quantização e export
são Python e devem ser Python. O contrato de entrega é o **arquivo `.onnx`**, executado pelo worker
Node que já existe. Isto **não é** um sidecar, não é um segundo runtime em produção e não muda
contrato nenhum. É o caminho que os documentos `05-*`/`08-*` já descrevem — este ADR apenas registra
que ele **responde a maior parte** da pergunta do dono.

**3. Os eixos (a) e (b) ficam ABERTOS, aguardando [P1], com o critério escrito ABAIXO — antes do
número.** É o mesmo padrão do "ponto de não-ir" de `spec-reid-visual.md §3`: o critério vale porque
foi escrito antes; escrito depois, ele vira racionalização.

**4. Nenhum EP acelerado — em qualquer linguagem — entra sem gate de paridade de detecção** no
`eval/` full-set. Consequência do DML (§eixo b): rápido e errado é pior que lento e certo.

## Critério de decisão (escrito ANTES da medição de P1)

### As quatro opções

| # | Opção | O que ganha | O que perde / passa a operar |
|---|---|---|---|
| **A** | **Manter tudo em Node** (status quo) | zero custo, zero risco, 425 testes intactos, um runtime, um gate (`npm run verify` + `npm audit`) | fica sem TensorRT/OpenVINO; INT8 depende de ferramenta externa (offline) |
| **B** | **Sidecar Python só de INFERÊNCIA** (tracking/contagem/zonas/alarme/contratos ficam em Node) | acesso a TensorRT/OpenVINO; ecossistema de EP melhor documentado | **transporte novo** (ver abaixo); supervisor de processo não-Node (spawn/respawn/backoff/health) fora do `worker-host.js`; **empacotar Python no release** (hoje o release é app Node + um binário Go estático; um bundle Python+numpy+ORT é outra ordem de grandeza — `[P1]` se virar candidato real); **segundo gate de supply-chain** (`npm audit` não vê `pip`); versionamento e deploy de dois runtimes |
| **C** | **Reescrever o motor inteiro em Python** | um runtime só na análise; ecossistema ML nativo ponta a ponta | joga fora **425 testes**; reimplementa tracking/contagem/zonas/exclusão/autoscale/telemetria/pool; **terceiro** ByteTrack a manter em paridade; reescreve os 6 consumidores do contrato IPC **e o gate de acurácia da casa**; hub passa a ser dois runtimes de qualquer jeito (Socket.IO/persistência/notificação continuam em Node) |
| **D** | **Investir no que a medição apontar** (modelo melhor, EP melhor, cadência, quantização) | ataca o gargalo real, dentro da arquitetura que já tem sensor | nada — é o caminho default da casa |

### Sobre o protocolo da opção B (importa mais do que parece)

O worker **já é** processo separado, então "sidecar" soa como troca de implementação do mesmo
contrato. **Não é** — e a diferença é o custo:

- **A forma da mensagem pode ficar idêntica** (`{type:"detect", id, cameraId, jpeg, ts, tiles?, input?}`
  → `{id, cameraId, ts, dets, decodeMs, inferMs, cpu}` — `worker.js:19-30`). Isso é bom: o engine e os
  5 scripts de eval não precisariam mudar de semântica.
- **O TRANSPORTE tem de ser novo.** O canal atual é `child_process.fork` com
  `serialization:"advanced"` — protocolo **interno do Node**, que um processo Python não fala. Um
  sidecar exige framing próprio (stdio com prefixo de comprimento, ou unix socket / named pipe;
  **não** TCP, para não abrir superfície de escuta). Isso significa: (i) uma camada de framing +
  testes; (ii) uma cópia extra do JPEG na serialização de ida (hoje o Buffer viaja como binário sem
  base64); (iii) `worker-host.js` — pool, roteamento por menor-carga, respawn individual com backoff,
  guarda de ordem por `ts` — é escrito contra `process.send`/`message`/`exit` do `fork`, e precisaria
  de um adaptador ou de um caminho paralelo.

Ou seja: **mesmo contrato lógico, transporte novo, supervisor novo, empacotamento novo.** Não é
"trocar o arquivo do worker".

### As condições (cada uma decide uma opção; ordem de avaliação)

**C1 — Mata a opção C (e todo argumento de velocidade), por aritmética.**
Se `[P1]` mostrar que a fatia **não-inferência** da rodada (decode + `rgbToTensor` + `postprocess` +
IPC) é **< 50%**, então o teto de ganho de qualquer troca de linguagem é **< 2×** (Amdahl), mesmo
zerando essa fatia. Um ganho abaixo de 2× **não** compra um segundo runtime, porque 2× é o degrau que
muda o dimensionamento de verdade (≈7 → ≈14 câmeras num hub de 8 cores, `eval/MODELS.md`).
→ **Se C1 dispara: opção C morta, e o eixo (a) fecha.** *(Sub-caso: se a fatia for grande e
concentrada em `rgbToTensor`, o conserto é uma otimização **dentro do Node** — buffer pré-alocado /
`sharp` entregando planar / batelada — não uma reescrita. Medir isso é mais barato que decidir.)*

**C2 — Única condição que faz a opção B vencer.** Exige as **três** simultaneamente:
  - **(i)** `[P1]` identificar um EP alcançável por Python e **não** pelo `onnxruntime-node` **na
    plataforma de produção real** (hoje: Linux x64 na VPS + Windows on-prem) — na prática,
    **TensorRT** ou **OpenVINO**; **e**
  - **(ii)** esse EP passar no **gate de paridade de detecção** do `eval/` full-set (o DML falhou
    exatamente aqui: mais rápido, zero detecção); **e**
  - **(iii)** o ganho medido na **rodada completa** ser **≥ 2×** (o mesmo degrau de C1 — o custo de
    operar dois runtimes é fixo, então o ganho precisa ser de patamar, não marginal).

  → **Falhou qualquer uma das três: opção B morta.** Nota de realismo: (i) já é improvável sobre o
  hardware que a casa escolheu comprar (AMD sem GPU — `hardware-ideal.md`); se o alvo mudar para
  NVIDIA, (i) passa a valer e C2 tem de ser reavaliada **antes** da compra, não depois.

**C3 — Ativa a opção D (o caminho esperado).** Se C1 dispara **ou** C2 falha, a resposta à pergunta
do dono é: **o motor fica em Node; o "algo mais avançado" do Python entra como `.onnx`.** O
investimento vai para o que `[P1]` apontar como gargalo real — que hoje as evidências existentes
sugerem ser **modelo/recall e cadência**, não linguagem:
  - recall em multidão satura no COCO genérico (`04-resultado-fullset-capacidade.md`) → **fine-tune
    person-only** (Python na oficina, ONNX na produção);
  - INT8/VNNI, o 2-3× do `hardware-ideal.md` → **quantizar em Python offline, executar em Node**;
  - ReID/BoT-SORT → **OSNet ONNX** no worker + cosseno no ByteTrack que já existe.

**C4 — Cláusula de reabertura (honestidade sobre o que não sabemos).** Se, ao implementar qualquer
capacidade futura, aparecer uma que **só** exista presa ao runtime Python (sem caminho de export ONNX
viável, verificado — não presumido), este ADR é reaberto **para aquela capacidade**, e a opção B é
reavaliada com C2. Nomear o caso concreto é obrigatório; "Python tem mais coisa" não reabre nada.

## Consequências

- **(+)** A pergunta do dono ganha uma resposta **acionável e não-defensiva**: *sim, Python entra — na
  oficina, onde ele é insubstituível; não em produção, onde ele não compra nada que o ONNX não
  atravesse.* Isso desbloqueia fine-tune, quantização e ReID **sem** discussão de arquitetura.
- **(+)** O eixo (b) sai da fama e vira tabela: os EPs mainstream **estão** no Node (CoreML sondado
  presente nesta máquina; DML e CUDA no prebuilt); a lacuna real é TensorRT/OpenVINO, e ela só importa
  se o hardware de produção mudar.
- **(+)** O invariante de paridade de EP fica escrito: **nenhum EP acelerado entra sem gate de
  detecção**. O DML vira precedente citável, não anedota.
- **(−)** Este ADR **não fecha** os eixos (a) e (b). Ele fecha o **critério**. Enquanto `[P1]` não
  medir, "manter em Node" é status quo por ausência de evidência contrária — não vitória demonstrada.
- **(−/risco) LGPD e segurança de um segundo runtime (se a opção B algum dia vencer):** o invariante
  do ADR-002 vale **igual** e é mais difícil de garantir. O worker Node tem **um** caminho de imagem
  (`sharp`, em memória, `worker.js:34`). Um sidecar Python traz uma árvore de dependências cujas
  bibliotecas gravam em disco por default e por hábito (caches de modelo em `~/.cache`, `imwrite`,
  temporários de codec). Exigências mínimas, não negociáveis, **antes** de qualquer sidecar:
  (i) auditoria explícita de todo caminho de escrita, com teste que falha se um arquivo de imagem
  nascer; (ii) transporte por stdio/socket local — **nunca** porta TCP de escuta; (iii) cache de
  modelo fixado em diretório do projeto, sem download em runtime; (iv) **um segundo gate de
  supply-chain** (`pip-audit`/lock), porque `npm audit` — hoje parte do `npm run verify` — passaria a
  cobrir só metade da árvore, e **um gate que cobre metade e diz "verde" é falso-OK institucional**.
- **(−/risco) Fronteira de paridade:** a casa já mantém 2 ByteTracks sem sensor cross-language
  (residual declarado). Qualquer lógica que atravesse para Python vira uma terceira fronteira do
  mesmo débito — por isso a opção B, **se** vencer, é **estritamente de inferência**: nada de
  tracking, contagem, zonas ou alarme cruza a fronteira.

## Residual declarado

1. **Os números dos eixos (a) e (b) não existem** — este ADR não os inventou e não os estimou. `[P1]`
   deve preencher: fatia por etapa da rodada (decode / tensor / inferência / pós / IPC), na máquina de
   produção, com o modelo default (S); e o inventário de EPs efetivamente carregáveis **por
   plataforma de produção** (não pela de desenvolvimento).
2. **`listSupportedBackends()` foi sondado em macOS/arm64 — plataforma de DESENVOLVIMENTO.** Produção
   é Linux x64 (VPS) e Windows (on-prem). A tabela de prebuilts do pacote diz o que esperar; a sonda
   por plataforma é `[P1]`.
3. **O custo de empacotamento de um sidecar Python não foi medido** (só apontado como outra ordem de
   grandeza que o binário Go do go2rtc). Só vira número se C2 chegar perto de passar.
4. **CoreML nunca foi testado neste projeto** — está no prebuilt e apareceu na sonda, mas macOS não é
   alvo de produção. Não é oportunidade; é apenas fato que contradiz "Node não alcança acelerador".
5. **A afirmação "o binding do Python é o mesmo core C++"** foi verificada **do lado Node** (tabela do
   eixo a, arquivos no `node_modules`). Do lado Python é a arquitetura declarada do upstream, não
   medida aqui. Se C2 chegar a ser avaliada, `[P1]` confirma com a mesma inspeção de artefato.
