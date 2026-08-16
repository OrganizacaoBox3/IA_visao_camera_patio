# Plano — trazer as lições do `mvp_maos` para cá

> **STATUS — ONDA 0 CONCLUÍDA em 2026-08-16.** Os quatro itens estão fechados; o detalhe do que
> cada um virou e do veredito do tier N está em [§Execução da Onda 0](#execução-da-onda-0).
> Gate do estado combinado: **lint 0 erros · typecheck 0 · 1598 testes verdes** (eram 1566) ·
> build ok · `eval:counting` e `eval:gate-recall` verdes com **Δ 0,0pp**. O `audit` segue
> vermelho pelo motivo pré-existente do item 2.1 — nada disso foi commitado.

> Origem: [`comparativo-mvp-maos-2026-08-16.md`](comparativo-mvp-maos-2026-08-16.md) (medição) e
> [`runbook-feira-sick.md`](runbook-feira-sick.md) (o evento que define o prazo).
> **Restrição que organiza tudo: a feira é em menos de uma semana.** Nada que possa quebrar a
> demonstração entra antes dela. O corte não é por esforço nem por elegância — é por **risco**.

## Como este plano está ordenado

Três ondas, e a fronteira entre elas é a feira, não o calendário:

| Onda | Quando | Critério de entrada |
|---|---|---|
| **0 — Pré-feira** | Agora | Ataca latência percebida **e** é reversível numa linha. Nada estrutural |
| **1 — Pós-feira, produto** | Depois do evento | Corrige a causa raiz que a Onda 0 contorna com perfil de ambiente |
| **2 — Dívida e processo** | Quando houver folga | Não muda comportamento; muda o que o time consegue saber |

Cada item traz o **sensor** que prova que funcionou. Item sem sensor não entra — é a doutrina
dos dois repositórios (`CLAUDE.md` §6 aqui, `PROCESSO.md` lá).

---

## ONDA 0 — antes da feira

### 0.1 · Pedir buffer mínimo ao navegador `[S]`

**O problema.** `src/camera/playoutDelay.ts:15` faz `if (!pc || ms <= 0) return false;`. Com
`syncDelayMs = 0` — que é o valor agora — a função retorna antes de tocar em nada. Paramos de
pedir *atraso* e nunca chegamos a pedir *pressa*: o navegador fica com o buffer adaptativo
padrão. É a **causa nº 4** da §7.2 do comparativo, e é a metade que faltou da decisão de zerar
o atraso.

**O que fazer.** Separar *"não mexer"* de *"minimizar"*. `applyPlayoutDelay` passa a aceitar 0
como pedido explícito (`jitterBufferTarget = 0`, `playoutDelayHint = 0`) e só ignora `null`/
ausente. O efeito em `useWebrtcTransport` passa a rodar também quando `syncDelayMs === 0`.

**Sensor.** Cronômetro filmado: celular com relógio de milissegundos na frente da SEC110, foto
da tela mostrando relógio real × relógio no vídeo. Antes e depois, 5 medidas cada. É o mesmo
método que o `runbook` já exige para calibrar o atraso — aqui ele ganha um A/B.

**Risco.** Baixo, e reversível: buffer pequeno demais aparece como micro-travada na imagem sob
rede ruim. Na LAN do stand, com go2rtc local, é o cenário mais favorável que existe. Se travar,
volta a não chamar.

---

### 0.2 · Idade do quadro como sensor de primeira classe `[S]`

**O problema.** Este app mede dezenas de coisas e **não mede a idade do quadro que a inferência
recebeu**. É exatamente o número que separa *"o modelo está ruim"* de *"a rede está ruim"* — e
foi ele que, no `inspecao_biscoito`, revelou um atraso crescendo **+5,3 s em 12 s** que nenhuma
outra métrica denunciava.

**O que fazer.** O engine já tem `st.latest = { buf, ts }`. No despacho ao worker, calcular
`idade = now − ts` e publicar em `GET /api/analysis/status` (aditivo, por câmera): mediana e
p90 numa janela móvel. Consumir no painel de Saúde, que já existe e já tem lugar para isso.

**Sensor.** O próprio número. Critério de aceite: com a SEC110 ao vivo, mediana < 200 ms e p90
< 400 ms; **se crescer monotonicamente ao longo de 60 s, há fila** — que é precisamente o
diagnóstico que hoje não temos como fazer.

**Risco.** Nenhum: é leitura, não altera o caminho de decisão.

---

### 0.3 · Diagnóstico da fonte, fora do app `[S]`

**O problema.** `scripts/validate-streams.mjs` responde *"conecta?"*. Não responde *"chega em
dia?"*. Quando a imagem atrasa no stand, hoje não há como separar câmera, rede e motor sem
subir o produto inteiro.

**O que fazer.** Portar `inspecao_biscoito/fonte.py::diagnosticar()`: abre a fonte por N
segundos e imprime fps efetivo, **mediana e p90 da idade do quadro**, e quantos foram
descartados por antiguidade. Arquivo novo em `scripts/`, zero acoplamento com o runtime.

**Sensor.** Rodar contra a SEC110 e contra um stream de referência conhecido; os dois têm de
dar números plausíveis e distinguíveis.

**Risco.** Nenhum — não é chamado por nada em produção.

---

### 0.4 · Medir o tier N `[S]`

**O problema.** A causa nº 1 da latência percebida é o custo do detector (64 ms contra 8,9 ms do
`maos`). Existe um tier mais barato — `ANALYSIS_MODEL=n` — e ele **não está baixado nesta
máquina**, então a decisão "vale trocar para o stand?" está sem dado.

**O que fazer.** Baixar o `dfine_n_coco.onnx` e rodar o mesmo bench: ms, recall, precisão,
recall por tamanho, FP em cena vazia.

**Sensor.** A tabela da §2 do comparativo, com uma linha nova.

**Critério de decisão, escrito ANTES** (para não escolher olhando o resultado que se quer ver):
o N entra no perfil de feira **somente se** custar ≤ 30 ms **e** mantiver recall ≥ 85% no
balde L (pessoa grande — que é a população do corredor do stand) **e** não aumentar o FP em
cena vazia. Falhando qualquer um dos três, fica no S e a cadência resolve.

**Risco.** Nenhum na medição. A troca, se acontecer, é uma variável de ambiente.

---

### O que NÃO entra na Onda 0

- Mexer em dependência (`npm audit` vermelho, `node_modules` fora de sincronia). Trocar o
  `package-lock.json` a menos de uma semana de um evento é trocar risco teórico por risco real.
- Refatorar o caminho de vídeo, mexer no ByteTrack, ou tocar no tracker.
- Qualquer item da Onda 1 — todos são estruturais por definição.

---

## ONDA 1 — depois da feira: a causa raiz

### 1.1 · Cadência DERIVADA, não constante `[M]`

**O problema.** `ANALYSIS_FPS = 1` é uma constante escolhida para o pior caso (hub com 15–25
câmeras). Num stand com 1 câmera e 10 núcleos, ela joga fora 90% da máquina — e cadência é a
**causa nº 2** da latência percebida. Hoje o perfil de feira contorna isso por variável de
ambiente; isso é gambiarra consciente, não solução.

**O que fazer.** Derivar o alvo de `núcleos disponíveis ÷ (nº de câmeras ativas × custo medido
do tier)`, com o custo vindo de medição no boot (o worker já faz warmup — basta cronometrá-lo)
e não de tabela. Os tetos do motor (`4` base, `8` foco) continuam valendo. O autoscale existente
segue como rede de segurança, não como plano.

**Sensor.** `eval:counting` e `eval:gate-recall` verdes antes e depois; e um teste novo que,
dado (núcleos, câmeras, custo), trava o fps escolhido — a fórmula vira contrato.

**Cuidado declarado.** Cadência alta com muitas câmeras é exatamente o que o default de 1
protegia. A fórmula tem de ser **conservadora por construção** e ter piso e teto testados.

---

### 1.2 · Escolher o limiar pela CURVA, por caso de uso `[M]`

**O problema.** A 0,35, a precisão medida é **74,4%** — uma caixa errada a cada quatro. Isso é o
que o olho lê como *"o sistema está confuso"*, e é a diferença mais sólida da comparação (os
intervalos de Wilson não se tocam contra o YOLO). Há um sintoma estrutural disso no repo:
automask, zona de exclusão, gate de movimento, guarda de nascimento por contenção — um
subsistema inteiro cujo trabalho é limpar falso positivo.

**O que fazer.** O `eval/` já produz a curva score × precisão × recall. Falta **escolher o
ponto** — e o ponto não é único: "câmera aberta com alguém olhando" tolera menos falso positivo
que "contagem 24/7 sem espectador". Medir as duas curvas e deixar o limiar de nascimento
dependente do contexto, como a cadência.

**Sensor.** A curva inteira reportada (nunca o ponto — doutrina §6), com Wilson, e o `eval`
como gate de não-regressão.

---

### 1.3 · Reduzir saltos no caminho de vídeo — investigar `[?]`

**O problema.** A **causa nº 3** é estrutural: dois caminhos, dois relógios. O `maos` não pode
dessincronizar porque desenha nos pixels que inferiu.

**O que fazer — primeiro medir, depois decidir.** A latência do caminho de vídeo
(encoder → RTSP → go2rtc → WebRTC → jitter buffer) **nunca foi medida** — é a maior lacuna
declarada do comparativo. Antes de propor arquitetura, quantificar cada salto com cronômetro
filmado. Só então avaliar se, para o caso de UMA câmera focada, existe caminho com menos
relógios que valha o que se perde.

**Cuidado declarado.** É tentador concluir "então volta pro MJPEG" ou "então desenha no
servidor". Ambas trocam um problema conhecido por problemas novos (banda, CPU, LGPD de frame
anotado). **Sem a medição, qualquer decisão aqui é aposta** — e este item existe para produzir
a medição, não para pré-aprovar a conclusão.

---

## ONDA 2 — dívida e processo

### 2.1 · Destravar o gate `[M]`

`npm run verify` está vermelho no `audit`: exceção do `react-router` **vencida em 2026-08-15**
(por design — o gate força re-avaliação) mais `brace-expansion`, `nanoid` e `socket.io-parser`
sem exceção. E `node_modules` está **fora de sincronia com o `package.json`**
(`brace-expansion@5.0.6` contra override `^5.0.8`; `react-router@7.17.0` contra `^7.18.1`), com
`react-router-dom` declarado **duas vezes** (linha 51 em devDependencies, linha 83 em
dependencies). Ou seja: **o que roda localmente não é o que o `package.json` descreve.**

Ordem: remover a declaração duplicada → `npm install` → re-medir o `audit` → só então decidir
sobre as exceções que sobrarem. Fechamento = `verify` verde, não "menos vermelho".

### 2.2 · Ligar o hook local `[S]`

`git config core.hooksPath` está **vazio neste clone** — o gate de pre-push que o `CLAUDE.md`
§6 promete está desligado (o CI cobre, mas a doutrina promete duas camadas).
Comando: `git config core.hooksPath .githooks`.

### 2.3 · Adotar a Regra 3 do `PROCESSO.md` `[S]`

> *"Otimização que muda o resultado não é otimização."* — lá, duas tentativas de acelerar a
> máscara eram mais rápidas **e mudavam o veredito** (diferença de escore até 9,17 num limiar de
> +0,75). O que ficou foi a versão com **40/40 máscaras idênticas bit a bit**, ciclo 58 → 41,5 ms.

Este repo já tem os evals para fazer esse A/B; falta a **regra escrita** de que cronômetro
sozinho não aprova mudança no caminho de imagem. Vai para o `CLAUDE.md` §6, junto das regras de
medição.

---

## Quadro-resumo

| # | Item | Onda | Tam. | Causa que ataca | Sensor |
|---|---|---|---|---|---|
| 0.1 | Buffer mínimo no navegador | Pré-feira | S | nº 4 | Cronômetro filmado, A/B |
| 0.2 | Idade do quadro no status | Pré-feira | S | diagnóstico | Mediana/p90 ao vivo |
| 0.3 | Diagnóstico de fonte em `scripts/` | Pré-feira | S | diagnóstico | Números plausíveis em 2 fontes |
| 0.4 | Medir o tier N | Pré-feira | S | nº 1 | Linha nova na tabela + critério escrito |
| 1.1 | Cadência derivada | Pós-feira | M | **nº 2** | `eval:*` verdes + teste da fórmula |
| 1.2 | Limiar pela curva, por contexto | Pós-feira | M | precisão | Curva + Wilson + gate |
| 1.3 | Medir o caminho de vídeo | Pós-feira | ? | nº 3 | Cronômetro por salto |
| 2.1 | Destravar o `audit` | Dívida | M | — | `verify` verde |
| 2.2 | Ligar `core.hooksPath` | Dívida | S | — | Pre-push dispara |
| 2.3 | Regra 3 no `CLAUDE.md` | Dívida | S | — | Documental |

## Execução da Onda 0

Executada em 2026-08-16. As quatro frentes foram particionadas por **propriedade exclusiva de
arquivo** (CLAUDE.md §5) e despachadas em paralelo; as quatro travaram no watchdog do runner de
agentes sem escrever uma linha (falha de infraestrutura, não de tarefa — working tree verificado
limpo em cada caso). Foram então executadas em sequência, mantendo a mesma partição.

### 0.1 · Buffer mínimo no navegador — FEITO

`applyPlayoutDelay` passou a distinguir **"não mexer"** (ausente/negativo) de **"minimize"**
(`0` → `jitterBufferTarget = 0` e `playoutDelayHint = 0`). Os dois chamadores
(`useWebrtcTransport`, `TrackOverlay`) passaram a rodar o reaplicador também em 0. O modo
síncrono (`> 0`) ficou intacto — a mudança ACRESCENTA um pedido, não troca comportamento.
9 testes novos, incluindo o caso negativo que é o que separa os dois significados.

**Ainda pendente:** o sensor. O A/B com cronômetro filmado só existe com a SEC110 ao vivo — sem
ele, o ganho está **raciocinado, não medido**.

### 0.2 · Idade do quadro — FEITO, e com uma descoberta

`GET /api/analysis/status` ganhou, por câmera, o campo **aditivo** `frameAge`:

```
frameAge: { p50, p90, n, trend } | null
```

Medida no **despacho** (captura→despacho), de propósito: isso é o transporte puro, sem somar os
~64 ms da própria inferência (que já são o `lastMs`). Juntos, dão a decomposição. `trend` (2ª
metade da janela menos a 1ª, em ms) é o campo que decide, porque **fila é fenômeno cumulativo**:
não aparece na mediana, aparece na tendência. `null` = nada medido na janela — nunca 0.

**Descoberta que corrige a análise:** o número já era calculado. O `latencyMs`
(captura→resposta) existe no `worker-host` e viaja no `analysis-tracks` para o interpolador
extrapolar a caixa. O que faltava era **retenção, agregação e exposição** — ver a correção
registrada em `comparativo-mvp-maos-2026-08-16.md` §3.

No painel de Saúde: coluna "idade p50/p90", neutra por default ("going gray"), amarela acima de
200/400 ms e **vermelha quando `trend ≥ 250 ms`** — porque idade alta e ESTÁVEL é latência
constante (outro problema, outra ação), enquanto idade que SOBE é fila. Os limiares absolutos
são **escolhidos, não medidos em campo**; a coluna existe para produzir o número honesto.
8 testes, incluindo o de contrato aditivo e o de estado antigo sem `ageLog`.

### 0.3 · Diagnóstico de fonte — FEITO, e ele REPRODUZ o achado

`scripts/diagnose-source.mjs` não só porta o instrumento: ele **reproduz o defeito** com um A/B.
Um consumidor simulado gasta `--work-ms` (default 64 — o custo medido do D-FINE-S) e a flag
`--queue` troca último-vence por enfileiramento. Medido no mesmo stream:

| Regime | Idade mediana | Tendência na janela |
|---|---|---|
| último-vence (o que o motor faz) | **3 ms** | +1 ms |
| `--queue` (o que o ffmpeg faz sozinho) | **4.083 ms** | **+4.106 ms em 10 s** |

O `fonte.py` do repo irmão mediu **+5,3 s em 12 s**. Reproduzido aqui de forma independente,
mesma ordem de grandeza. O script sai com código 1 quando detecta fila. 15 testes na lógica pura
(`vitest.config.ts` passou a incluir `scripts/**/*.test.mjs` — lógica que decide código de saída
precisa de teste).

### 0.4 · Tier N — MEDIDO, e REPROVADO pelo critério

Modelo baixado pelo mecanismo do próprio projeto (sha256 conferido). N e S medidos em sequência,
sob a mesma carga (loadavg ~4), mesmo fixture, mesmo limiar de 0,35:

| Tier | ms (mediana) | Recall geral | Precisão | Balde L (pessoa grande) | FP em cena vazia |
|---|---|---|---|---|---|
| **N** | 38,5 | 28,4% [20,3–38,2] | 52,9% [39,5–65,9] | **18,2% [7,3–38,5]** | 0 |
| **S** | 81,1 | 91,6% [84,3–95,7] | 74,4% | **90,9% [72,2–97,5]** | 0 |

Contra o critério escrito ANTES:

| Critério | Alvo | N | Veredito |
|---|---|---|---|
| (a) custo | ≤ 30 ms | 38,5 ms | **falha** |
| (b) recall no balde L | ≥ 85% | 18,2% | **falha, e não por pouco** |
| (c) FP em cena vazia | ≤ 0 | 0 | passa |

**Veredito: FICA NO S.** O N reprova em dois dos três, e o (b) reprova por margem enorme — ele é
2,1× mais barato e acha um terço das pessoas. A cadência (item 1.1) continua sendo a alavanca
certa para sensação de tempo real, não a troca de tier.

*Ressalva honesta:* a comparação usou 0,35, que é o limiar de NASCIMENTO de track. O worker
devolve a partir de 0,25 e a 2ª passada do ByteTrack sustenta tracks abaixo do piso de
nascimento — o N poderia parecer melhor num limiar menor. Isso é um knob, não uma refutação: no
limiar que este produto de fato usa para fazer a pessoa APARECER, o N reprova.

## Residual deste plano

- **A Onda 0 inteira contorna, não corrige.** O perfil de feira é ambiente; a correção de
  verdade da cadência é a 1.1, e ela é deliberadamente pós-feira.
- **A causa nº 1 (custo do detector) não tem item de correção**, só de medição (0.4). É uma
  troca de produto — recall contra latência — e a decisão é do dono, não da engenharia.
- **A causa nº 3 não tem solução proposta**, de propósito: sem medir os saltos, propor
  arquitetura seria aposta.
- Estimativas `[S]`/`[M]` são de tamanho relativo, não de horas.
