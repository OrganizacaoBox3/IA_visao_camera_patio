# O que o `mvp_maos` faz melhor — e o que disso serve aqui

> Pergunta do dono (2026-08-16): *"nos testes que fiz a performance ficou absurdamente melhor
> no reconhecimento de pessoas — o que exatamente impactou?"*
>
> Este documento responde **por medição**, no fixture de aval do próprio projeto
> (`eval/fixture/`: 21 imagens com 95 pessoas anotadas em pixels + 8 cenas vazias), com o
> matching da casa (guloso por score, IoU ≥ 0,50) e o limiar que decide se a pessoa aparece
> na tela (0,35 — nascimento de track). Todas as rodadas nesta máquina (Apple M5, 10 núcleos),
> sequenciais, máquina ociosa.

## 1. As três hipóteses óbvias — e o que sobrou delas

| Hipótese | Veredito | Evidência |
|---|---|---|
| "O Python usa a GPU (MPS) e o Node não" | **REFUTADA** | `ultralytics.select_device("")` devolve **`cpu`** nesta máquina. Só o MiDaS vai para MPS explicitamente (`.to("mps")` em `detector_profundidade.py`). Os dois lados rodam em CPU. |
| "YOLO reconhece pessoa melhor que o D-FINE" | **REFUTADA no que importa aqui** | D-FINE-S: recall **91,6%** · YOLOv8s-seg: **80,0%** · YOLOv8s-pose: **50,5%**, mesmo conjunto |
| "O motor do app atual é lento" | **REFUTADA** | D-FINE-S no worker de produção: **68,6 ms/quadro** = teto de **14,6 fps** para uma câmera. Ele roda a **1 fps** por configuração, não por limite |

**O modelo do app atual é o melhor dos três em achar gente.** Então a explicação da diferença
percebida não está no modelo — está em como cada um é operado.

## 2. A medição, completa

Recall = das 95 pessoas anotadas, quantas foram encontradas. Precisão = das caixas emitidas,
quantas eram pessoa de verdade. **FP em cena vazia** = caixas inventadas nas 8 imagens sem
ninguém — o defeito mais visível numa demonstração.

| Motor | ms (mediana) | fps teto | Recall | Precisão | Pessoa pequena | FP em cena vazia |
|---|---|---|---|---|---|---|
| **D-FINE-S** ONNX, squash 640, 2 threads *(produção deste app)* | 68,6 | 14,6 | **91,6%** | 74,4% | **89,7%** | **0** |
| **YOLOv8s-seg** ultralytics, letterbox 640, CPU | 51,8 | 19,3 | 80,0% | **91,6%** | 69,2% | 0 |
| **YOLOv8s-pose** ultralytics, letterbox 640, CPU | 55,2 | 18,1 | 50,5% | 84,2% | — | 0 |

Com intervalo de Wilson 95% (n = 95 pessoas — **13/13 não é 100%**, e 87/95 também não é 91,6%
com certeza):

| Proporção | Ponto | Wilson 95% |
|---|---|---|
| D-FINE recall | 91,6% | [84,3 – 95,7] |
| YOLO-seg recall | 80,0% | [70,9 – 86,8] |
| D-FINE precisão | 74,4% | [65,8 – 81,4] |
| YOLO-seg precisão | 91,6% | [83,6 – 95,9] |

**Leitura honesta:** a diferença de **precisão** é sólida (os intervalos **não se tocam** —
o YOLO erra menos). A diferença de **recall** aponta forte para o D-FINE mas os intervalos
**se sobrepõem** entre 84,3 e 86,8: com n=95, é indício robusto, não prova fechada. Em pessoa
pequena a mesma coisa (89,7% [76,4–95,9] contra 69,2% [53,6–81,4]).

### 2.1 A curva de input — e uma escolha minha refutada

| `ANALYSIS_INPUT` | ms | Recall | Precisão | FP em cena vazia |
|---|---|---|---|---|
| 512 | 48,1 | 90,5% | 72,3% | 1 |
| **640** | 68,6 | 91,6% | 74,4% | **0** |
| 896 | 131,2 | 93,7% | 73,6% | **4** |

Eu havia colocado **896** no perfil de feira por inferência ("+5-8pp de recall em cena densa",
número herdado de outro contexto). Medido: compra **2,1 pontos** de recall por **+91% de CPU**
e leva o falso positivo em cena vazia de **0 para 4**. Corrigido para 640 em `scripts/feira.sh`,
com a curva registrada no próprio arquivo.

## 3. Então por que parece absurdamente melhor? Quatro causas reais

### Causa 1 — CADÊNCIA. É a dominante, e é escolha, não limite

O `mvp_maos` roda o detector numa thread que consome o quadro mais recente **o tempo todo**:
~18 fps de detecção, contínuos. Este app amostra a **1 fps** (`ANALYSIS_FPS`), 2 com linha de
contagem, 6 na câmera focada.

A conta que importa: uma pessoa andando a 1,4 m/s percorre **1,40 m entre duas observações a
1 fps** e **8 cm a 18 fps**. Todo o resto — rastreador perdendo identidade, caixa "pulando",
marcação atrás da pessoa, o modo síncrono de 2 s que existia para esconder isso — é
consequência aritmética dessa única linha de configuração.

E o default de 1 fps **está certo para o que ele foi feito**: um hub com 15-25 câmeras, 24/7,
onde 1 câmera ≈ 1 núcleo no pico. O erro não foi escolher 1; foi **1 ser constante** quando o
custo real é `nº de câmeras × custo do modelo ÷ núcleos`. Num stand com uma câmera e 10
núcleos, 1 fps joga fora 90% da máquina.

> Já aplicado no perfil de feira: base 3 fps, foco 8 fps (o teto do próprio motor).

### Causa 2 — PRECISÃO. É o que o olho lê como "o sistema está confuso"

A 0,35, o D-FINE emite **1 caixa errada a cada 4**; o YOLO, 1 a cada 12. Numa tela grande, com
alguém olhando por 15 segundos, caixa fantasma não é "menor precisão": é o sistema parecendo
não saber o que está vendo.

E há um sintoma estrutural disso neste repo: existe um subsistema inteiro — automask, zona de
exclusão, gate de movimento, guarda de nascimento por contenção, refutação por realocação —
cujo trabalho é **limpar falso positivo estático**. O `mvp_maos` não tem nada disso e não
precisa. Parte da complexidade deste motor é dívida paga a um limiar de precisão baixo.

### Causa 3 — SALTOS E RELÓGIOS

```
mvp_maos:   câmera → numpy → modelo → desenha → tela          1 processo, 1 relógio
este app:   SEC110 → ffmpeg → go2rtc → RTSP → ffmpeg → MJPEG → hub → IPC(fork) →
            sharp → ONNX → IPC → socket.io → navegador → canvas sobre vídeo WebRTC
                                                          ~10 saltos, 3 relógios
```

Os três relógios (vídeo, overlay, análise) são a razão de existir o `syncDelayMs`. O
`mvp_maos` não precisou inventar isso porque desenha o overlay **no mesmo array que acabou de
inferir** — a sincronia é por construção, não por compensação.

Isso **não é argumento para jogar a arquitetura fora**: ela existe porque este produto tem N
câmeras, 24/7, sem espectador, com persistência, RBAC e LGPD. É argumento para saber que cada
salto tem um custo que o protótipo não paga.

### Causa 4 — O QUADRO QUE CHEGA (o achado mais transferível de todos)

`inspecao_biscoito/fonte.py` é o melhor arquivo dos dois repositórios. Ele mede o que este app
não mede:

> *"O buffer mente. Num stream de rede o FFMPEG enfileira quadros. O app leva ~50 ms por quadro;
> se a câmera entrega 30 fps, a cada segundo sobram ~10 quadros na fila e o atraso CRESCE sem
> limite."* — **medido: +5,3 s de atraso em 12 s sem descarte; 15-20 ms estáveis com descarte.**

O que ele faz e este app não faz:

- Uma thread lê continuamente e guarda **só o último quadro**; `ler()` nunca devolve o mesmo
  quadro duas vezes, e devolve `None` (não um quadro velho disfarçado) quando a fonte cai.
  *(Este app já fazia o último-vence — `st.latest` no engine. O que faltava era **provar** que
  estava funcionando em campo.)*
- `idade_ms()` — **quanto tempo o quadro entregue levou para chegar**. É o número que separa "o
  modelo está ruim" de "a rede está ruim".
  > **Correção (feita ao implementar):** a primeira redação dizia que este número "não existe"
  > aqui. Existe **em trânsito**: o `latencyMs` (captura→resposta) é calculado no `worker-host`
  > e vai no `analysis-tracks` para o interpolador extrapolar a caixa. O que não existia era
  > **retenção, agregação e exposição** — ninguém conseguia responder "o quadro está chegando
  > em dia?" sem abrir o navegador, e o `lastMs` do `/status` é a duração da INFERÊNCIA, outro
  > número. Fechado em 2026-08-16 (§9).
- `python fonte.py rtsp://...` roda 8 segundos e imprime fps efetivo, mediana e p90 da idade
  do quadro, e quantos foram descartados. **Diagnóstico de fonte antes de acusar o motor.**
- Detalhe que só se aprende apanhando: `timeout` **e** `stimeout` nas opções do ffmpeg (o nome
  mudou na versão 6 e o antigo foi removido) — sem isso, stream morto trava a abertura por 30 s.

## 4. Qualidade do código — avaliação honesta dos dois lados

### O que o `mvp_maos` faz melhor

1. **Todo comentário traz o PORQUÊ e o NÚMERO.** `SUAVIZACAO_ALPHA = 0.5` vem com *"testei com
   simulação de grade de parâmetros (70/140/220 px por quadro): 0.5 aguenta até 140 px/quadro
   sem trocar de instancia_id"*. Aqui os knobs também têm dono (`precision.js`), mas lá a
   justificativa está **na linha da constante**, onde quem for mexer vai ler.
2. **Módulo pequeno com uma responsabilidade.** `gemeo_virtual` faz detecção + pose +
   profundidade + luz + ponto de fuga + reconstrução 3D + servidor WS + servidor web em
   **2.711 linhas / 10 arquivos**. `server/analysis/` aqui tem **5.745 linhas / 21 arquivos**
   para menos escopo funcional.
3. **Documenta o que NÃO funcionou, com ordem de não repetir.** "Esqueleto detalhado — tentado
   e revertido (não retentar sem ler isto)", com as duas causas e o que precisaria mudar. Isso
   é mais valioso que documentar o que funcionou.
4. **Fallback obrigatório em toda troca** — virou regra depois que a reversão do MediaPipe
   mostrou que "mais fidelidade, às vezes" é pior que "menos fidelidade, sempre".
5. **Instrumentação como cidadão de primeira classe.** `log.jsonl` + prints pareados, e a regra
   que veio de erro: **print é o quadro LIMPO**, porque HUD queimado na imagem contaminou a
   reclassificação (mediana −6,57 contra −1,16, e 7 de 33 vereditos mudaram — pior, a *cor* do
   retângulo correlacionava com o rótulo).
6. **`PROCESSO.md` é melhor que a maioria dos manuais de engenharia que eu li.** Dez regras,
   cada uma com o incidente numerado que a gerou. A regra 3 ("otimização que muda o resultado
   não é otimização" — 40/40 máscaras idênticas bit a bit, ciclo 58 → 41,5 ms) devia valer aqui
   também.

### Onde o `mvp_maos` é pior — e não é pouco

1. **Sem git.** Declarado como residual desde o início, com quatro fases de experimento e
   reversões documentadas. É exatamente o cenário onde versionamento paga, e é a maior
   fragilidade do workspace.
2. **Sem teste automatizado e sem CI.** As "bancadas" são scripts rodados à mão. Este app tem
   **122 arquivos de teste, 1.566 testes** e um gate que roda em CI — e foi justamente o
   `eval/` daqui que permitiu produzir toda a medição acima em vinte minutos. Sem ele, esta
   análise seria opinião.
3. **Duplicação assumida** (`rastreamento.py` copiado entre `cubagem/` e `gemeo_virtual/`, com
   instrução de "replicar a mão"). Honesto, mas é dívida.
4. **Constantes duplicadas entre Python e JS** (`SALA_LARGURA` em `app.py` e `index.html`) — o
   próprio doc admite "mudou num lugar, muda no outro".
5. **Inconsistência de encoding** — parte dos arquivos sem acento (`fonte.py`), parte com.
6. **É protótipo por declaração** ("não é produção, não tem gate de CI, coleira longa por
   design"). Comparar as duas bases sem isso na frente seria desonesto: elas não estão
   resolvendo o mesmo problema.

## 5. O que eu traria para cá — em ordem de retorno

| # | O quê | Por quê | Custo |
|---|---|---|---|
| 1 | **Cadência derivada, não constante** — fps em função de `núcleos ÷ (câmeras × custo do modelo)`, com o teto medido (14,6 fps/câmera nesta classe de máquina) | É a causa dominante da diferença percebida, e hoje é uma constante escolhida para o pior caso | Já feito no perfil de feira; virar produto é ~meio dia |
| 2 | **`idade_ms()` do quadro como sensor de primeira classe** no `analysis-status` e no painel de Saúde | É o número que separa "modelo ruim" de "rede ruim". O app mede dezenas de coisas e não mede esta | Pequeno |
| 3 | **Comando de diagnóstico de fonte** — portar `fonte.py::diagnosticar()` para `scripts/` (fps efetivo, mediana/p90 da idade, descartados) | Hoje `validate-streams.mjs` responde "conecta?", não "chega em dia?" | Pequeno |
| 4 | **Escolher o limiar pela curva, para o caso "câmera aberta"** | 74,4% de precisão a 0,35 é o que faz a tela parecer confusa; a curva existe no `eval/` e ninguém escolheu o ponto para este uso | Meio dia de medição |
| 5 | **Regra 3 do `PROCESSO.md` como gate** — toda otimização de imagem carrega A/B contra a versão anterior | Este repo já tem os evals; falta a regra escrita de que cronômetro sozinho não aprova | Documental |

## 6. O que NÃO copiar

- **Trocar D-FINE por YOLO "porque o Python usa".** Medido: o D-FINE tem +11,6 pontos de recall
  e ganha em **pessoa pequena** (89,7% contra 69,2%) — exatamente o caso de pátio e corredor de
  CD, onde a pessoa está longe. A troca custaria justamente onde o produto vive. O que vale
  copiar do YOLO é a **precisão**, e isso se persegue por limiar e por pós-processamento, não
  por troca de modelo.
- **Abandonar hub/multi-câmera/persistência.** A arquitetura daqui existe por requisitos que o
  protótipo nunca teve.
- **Rodar sem git e sem CI.** É a parte do `mvp_maos` que este repo já resolveu melhor.

## 7. Latência PERCEBIDA — o orçamento medido

> Pergunta do dono, depois da primeira rodada: *"na prática o maos é muito mais rápido na
> percepção do usuário final. O que causa isso?"* — a §2 mede **acurácia**, não latência.
> Esta seção mede a segunda.

### 7.1 A conta, lado a lado

| Etapa | `maos/main.py` | Este app (perfil de feira) |
|---|---|---|
| Espera pela próxima inferência | **0** — infere todo quadro | 0–125 ms @8 fps foco · **0–1000 ms @1 fps** (default) |
| Decode do quadro | 0 (numpy em memória) | **4 ms** (medido) |
| Inferência | **8,9 ms** (medido) | **64 ms** (medido) |
| Entrega do resultado | escreve no mesmo array | IPC → socket.io → navegador |
| Caminho do VÍDEO que o usuário olha | **não existe** — é o mesmo array | H.264 na SEC110 → RTSP → go2rtc → WebRTC → jitter buffer do navegador (**não medido**) |
| Dessincronia vídeo ↔ caixa | **0 por construção** | inevitável — dois relógios |

### 7.2 As quatro causas, em ordem de tamanho

1. **Detector 7× mais barato.** `person_detector.tflite` (EfficientDet-Lite0 int8) custa **8,9 ms**
   contra os **64 ms** do D-FINE-S. Não é otimização, é **troca**: o barato acha 42,1% das
   pessoas, o caro 91,6%. Na cena do `maos` — uma pessoa, perto, ocupando o quadro — perder
   pessoa pequena não custa nada. É a própria tese do `PLANO_DEMO_PALLET.md` deles: *"flawless
   vem de estreitar o domínio, não de melhorar o estimador"*.
2. **Cadência.** A 1 fps o quadro espera 0–1000 ms (média 500) **antes de qualquer inferência
   começar**. Esse tempo morto é maior que todo o resto somado.
3. **Dois caminhos, dois relógios.** No `maos` a caixa é pintada nos pixels que o modelo acabou
   de ver — não *pode* dessincronizar. Aqui vídeo e caixa viajam por rotas independentes; o
   `syncDelayMs` nunca reduziu latência, só **escondia** o descasamento atrasando o vídeo até
   ele encontrar a caixa. E o piso é o transporte: mesmo com inferência instantânea, o usuário
   olharia um stream que passou por encoder, rede e buffer de jitter. O `maos` não paga nada
   disso porque **não tem transporte de vídeo**.
4. **Nunca pedimos baixa latência ao navegador.** `src/camera/playoutDelay.ts:15` tem
   `if (!pc || ms <= 0) return false;` — com `syncDelayMs = 0` a função **retorna antes de tocar
   em nada**. Paramos de pedir *atraso* e nunca chegamos a pedir *pressa*: o navegador fica com
   o buffer adaptativo padrão. `jitterBufferTarget = 0` é o pedido explícito de mínimo, e hoje
   ele não sai.

### 7.3 Hipóteses descartadas nesta rodada

- **Decode/serialização de JPEG**: 4 ms de 68. Não é o gargalo — o transporte de bytes entre
  hub e worker está barato.
- **Threads**: 8 threads ficou **pior** que 2 (109,4 ms contra 68,6) — oversubscription no
  Apple Silicon. `ANALYSIS_INTRA_THREADS=2` está certo, e não por acaso.
- **GPU**: nenhum dos dois lados usa.

## 8. Residual declarado

- **n = 95 pessoas em 21 imagens.** Wilson reportado acima; a diferença de recall entre D-FINE e
  YOLO-seg **não** é conclusiva nesse n (intervalos se tocam). A de precisão é.
- **COCO não é o CD nem a feira.** Todo número aqui é sobre o dataset de aval, não sobre a cena
  real do cliente. Deriva de domínio não medida.
- **Medições sequenciais, máquina ociosa, uma câmera.** No stand haverá ffmpeg, go2rtc e
  navegador competindo — o teto de 14,6 fps é otimista.
- **YOLOv8s-pose comparado como detector de pessoa é levemente injusto** (ele é modelo de pose;
  o `mvp_maos` usa pose porque quer esqueleto, não porque quer recall).
- **Medi a INFERÊNCIA, não o caminho ponta a ponta.** A latência percebida no navegador inclui
  os ~10 saltos da Causa 3, que não estão neste número.
- **Não rodei o `mvp_maos` ao vivo.** A comparação é dos motores no mesmo conjunto, não das duas
  aplicações rodando lado a lado — que é o teste que fecharia a pergunta de vez.

- **A latência do caminho de VÍDEO não foi medida** (§7.1) — exige a SEC110 ao vivo e cronômetro
  filmado. Todo número de vídeo aqui é estrutural ("existe encoder, rede e jitter buffer"), não
  quantificado. É a maior lacuna desta análise.
- **O tier N não foi medido** — `server/models/` só tem S e M nesta máquina. A comparação
  custo×recall do N contra o `person_detector.tflite` fica em aberto, e é ela que decidiria se
  vale trocar de tier para ganhar sensação de tempo real.

## 9. Plano de adoção

O que fazer com tudo isto, em ondas, está em
**[`plano-melhorias-latencia-2026-08-16.md`](plano-melhorias-latencia-2026-08-16.md)**.

## 10. Reprodutibilidade

Scripts de medição em `scratchpad` desta sessão (não versionados):
`bench-dfine.mjs <threads>` (usa `eval/lib.mjs` e o worker REAL de produção),
`bench_yolo.py <pesos> <device> <imgsz>` e `bench_mediapipe.py` — todos no mesmo fixture, mesmo
matching, mesmo limiar. Imprimem JSON com tempo, recall, precisão, recall por tamanho e FP em
cena vazia. `ANALYSIS_INPUT` e `ANALYSIS_MODEL` no ambiente variam a configuração do primeiro.
