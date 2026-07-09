# Diagnóstico — o marcador ANDA ATRÁS da pessoa (overlay lag)

> Sintoma real do dono (2026-07-08): "a pessoa sai andando na frente e o marcador fica pra trás,
> acompanhando ela." **NÃO é** detecção (o servidor detecta — ver `06-*`), **nem** vídeo travando: é o
> **overlay atrasado** — a caixa é desenhada onde a pessoa ESTAVA, não onde ESTÁ. Causa no código, barato
> de consertar (front + cadência + latência), **sem tocar em modelo/GPU/fine-tune**.

## Cadeia da latência (por que a caixa fica atrás)
1. **Cadência base 1fps** (`engine.js:44` `ANALYSIS_FPS=1`). Câmera ABERTA sobe pra `FPS_FOCUS=6`
   (`engine.js:54`, contrato `analysis-focus`) — MAS o fps ALCANÇADO é limitado pelo tempo de inferência.
2. **Latência de inferência ~350-680ms/frame** (medido no eval, S@640/896 em 1080p). Se uma inferência
   leva ~350ms, o pool não sustenta 6fps p/ aquela câmera → **efetivo ~2-3fps**, e cada caixa chega
   **~350-680ms velha** (a pessoa já andou nesse tempo).
3. **A interpolação ancora a caixa na CHEGADA, não na captura** (`interpolate.ts:131` `t: recvT`). A bbox
   é a posição da CAPTURA, mas é ancorada no instante em que CHEGOU — a caixa **nasce ~meio segundo atrás**
   e a extrapolação parte daí, sem compensar a latência do pipeline.
4. **Extrapolação capada em `maxExtrapMs: 500`** (`interpolate.ts:71`). A 1fps (payload a cada ~1000ms),
   na **2ª metade de cada intervalo a caixa CONGELA** na predição de +500ms enquanto a pessoa segue →
   fica pra trás, e "pula" pra frente no próximo payload. (A capa existe pra não disparar quando a pessoa
   PARA — tradeoff real.)

**Soma:** 1fps (ou ~2-3 efetivo) + caixa nasce ~0,5s atrás + extrapolação congela após 0,5s = marcador
visivelmente atrás de quem anda. Quanto mais rápida a pessoa, pior.

## O que MEDIR primeiro (doutrina: medir antes de mexer)
- **fps ALCANÇADO da câmera focada** (o `achievedFps`/`targetFps` do autoscale/status já existe): a aberta
  chega a ~3-6 ou está presa em 1? (autoscale pode ter rebaixado sob carga das 4-5 câmeras do DVR.)
- **idade da caixa** (`interpolate.ts` já expõe `ageMs` no `sample()`): quantos ms atrás a caixa exibida está.
- **inferMs real na máquina do CD** (não a de dev contida) — define o piso da latência.

## MEDIDO (2026-07-08, frame MOT20 1080p, motor real, cena COM movimento)

Cadência REAL do overlay (analysis-tracks/s emitidos) — `scripts/measure-focus.cjs` adaptado p/ 1080p:

| Modelo | câmera fundo | câmera FOCADA (alvo 6fps) | intervalo da caixa (focada) |
|---|---|---|---|
| **S** (produção) | 1,0 fps | **1,4 fps** | **~727ms** |
| **N** (rápido) | 1,0 fps | **3,9 fps** | **~258ms** |

**Achado central:** mesmo FOCADA, a S entrega só **1,4fps** — o alvo de 6fps é **inalcançável** porque a
inferência (~640ms/frame em 1080p) **serializa por câmera** (uma em voo por vez → teto ~1/inferMs). A caixa
nasce a cada ~727ms E ~640ms atrasada. **A latência de inferência é o teto do frescor do overlay.** O
modelo N (mais leve) quase **triplica** a cadência (1,4→3,9fps; caixa 727→258ms) — prova que aliviar a
inferência da câmera OLHADA é a maior alavanca do "marcador atrás".
*(Artefato evitado: alimentar frame ESTÁTICO faz o gate de movimento pular a inferência → sondagem 6s/2s;
medido com sequência de frames DIFERENTES p/ o gate sempre disparar, como pessoa andando.)*

## Correções (ranqueadas, todas de baixo/médio custo — front + cadência)
1. **Compensar a latência na extrapolação** (`interpolate.ts` + contrato aditivo): o hub manda o timestamp
   da CAPTURA (ou o inferMs) no payload; o cliente prevê a caixa p/ o `now` REAL (`dt = now - captura`),
   não p/ a chegada. **Maior redutor do atraso.** Médio (mexe no contrato `analysis-tracks` — ADITIVO).
2. **Subir `maxExtrapMs`** p/ cobrir o intervalo REAL entre payloads (derivar do intervalo observado, ou
   ~1000ms a 1fps) — a caixa segue prevendo o gap inteiro em vez de congelar em 500ms. Baixo custo; o
   Kalman leva v→0 quando a pessoa para, então o risco de overshoot é contido. Só afinar `maxExtrapMs`.
3. **Garantir que o boost de foco REALMENTE aplica** na câmera aberta (o `analysis-focus` é emitido e
   honrado? o autoscale não rebaixou?). Se estiver preso em 1fps, corrigir isso sozinho já ajuda muito.
4. **Cortar a latência da câmera OLHADA**: p/ a câmera focada, input/modelo menor = inferência mais
   rápida = caixa mais fresca. Na câmera que se OLHA, frescor > recall (tradeoff invertido do eval).

## Reenquadramento honesto do arco
O incômodo real do dono ("não reconhece / trava / marcador atrás") é, na experiência dele, **em boa parte
LATÊNCIA/CADÊNCIA DE OVERLAY** — barato (front + cadência), **não** o fine-tune caro. O eval de recall
(`00`–`05`) segue válido p/ multidão, mas a prioridade #1 do que o DONO vê é **este atraso**. Consertar o
overlay lag provavelmente resolve a maior parte da percepção de "ruim".
