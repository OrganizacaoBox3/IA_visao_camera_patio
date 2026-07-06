# Fix do rastro de tracking (stream que salta) — SENSORES e BANCADA

> Frente de QUALIDADE do fix em curso nas frentes F1 (hub, `server/analysis/`) e F2 (front,
> `src/vision/`). Este doc registra: o bug, o contrato do fix, os sensores novos (como rodar,
> resultado pré-fix REGISTRADO) e a bancada visual do salto. Propriedade desta frente:
> `eval/counting.mjs`, `scripts/make-jumpy-clip.mjs` e este doc — nada em `server/analysis/` nem `src/`.

## 1. O bug

Stream RTSP que **engasga/salta** (frames descartados, conteúdo teleporta) quebra a associação
por IoU do ByteTrack-lite: a pessoa reaparece longe da bbox predita → **nasce id novo** a cada
salto, e o track velho fica **coasting** (sem detecção, congelado na última posição observada)
sendo **emitido no payload `analysis-tracks` até o TTL (~8s = ~16 rodadas @2fps)**. Sintoma no
painel: a mesma pessoa vira vários ids + um **rastro de máscaras fantasmas**; risco no KPI:
travessia perdida ou fragmentada.

## 2. O contrato do fix (o que os sensores medem)

1. **Salto moderado** (gap ≤ ~2,5s, deslocamento ≈ vx·dt): **MESMO id** e a **travessia conta**
   (a contagem sobrevive ao salto).
2. **Salto extremo** (deslocamento incompatível com a velocidade): **id novo é OK**, mas o track
   velho **some do payload em ≤1–2 rodadas** (estado LOST **não-emitido**) — nunca >1 track
   emitido para 1 pessoa.
3. Oclusão longa (5s) idem: id novo aceitável; o track antigo **para de ser emitido em ≤2
   rodadas** após sumir, em vez de coastar até o TTL.

## 3. Sensores (eval/counting.mjs)

`npm run eval:counting` (determinístico, exit 0/1). O harness agora roda cada cenário pelo
**`pipeline.processRound` de produção** (filtro de classe → exclusão/automask no-op → bytetrack →
counting → **montagem do payload `analysis-tracks`**) e captura o payload emitido por rodada —
mede o que o front recebe, **onde quer que a F1 implemente o filtro de LOST** (tracker ou pipeline).

Cenários novos (além dos 9 legados, todos verdes):

| Cenário                                | Assert                                                                    | Pré-fix (registrado 2026-07-06) |
| -------------------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| `salto moderado (stream engasga ≤2.5s)` | 1 travessia **e** nº de ids distintos emitidos == 1                       | **OK** (guarda de regressão¹)    |
| `salto extremo 3× (não vira rastro)`    | em nenhuma rodada >1 track emitido (é 1 pessoa)                           | **FALHOU** — 4 tracks simultâneos (r12) |
| `oclusão longa (5s) e reaparece longe`  | track antigo some do payload em ≤2 rodadas após sumir (id novo é OK)      | **FALHOU** — emitido até r19 (limite r6) |

¹ A predição linear do tracker **atual** já cobre o salto moderado (deslocamento ≈ vx·dt cai na
bbox predita). O assert existe para a F1 **não quebrar** esse caso ao filtrar LOST — p.ex., se o
LOST sair também da *associação* (e não só da emissão), o id fragmenta e este cenário acusa.

**Prova de sensibilidade**: os dois FALHOU acima reproduzem exatamente o mecanismo do bug
(rastro por coasting emitido). Quando a F1 aterrissar, `npm run eval:counting` deve ficar
**verde nos 12** — rode antes/depois.

> **CI**: o job `eval` do CI roda `eval:counting` — estes sensores são **vermelhos por design
> até a F1 aterrissar**. Commitar os sensores **junto com (ou depois de) o fix da F1**, nunca
> isolados na `main`.

Knobs: espelho dos defaults de produção (`server/analysis/precision.js` + TTL derivado 8000ms),
fixos no harness de propósito — mudou o default lá, atualize o `KNOBS` do `eval/counting.mjs`.

## 4. Bancada visual do salto (clipe jumpy)

Reprodução VISUAL do bug/validação do fix no painel, com clipe de CFTV real:

```
node scripts/make-jumpy-clip.mjs        # defaults: --seed 42 --window 4 --cut 1
```

Gera `C:\Users\crist\bench-visao\clipe-jumpy.mp4` a partir de `clipe.mp4` removendo **1s de
conteúdo a cada 4s** em offsets sorteados por **seed fixa** (mesmo seed = mesmos cortes —
determinístico) e re-estampando os frames contíguos: o clipe toca fluido e o conteúdo
**teleporta** a cada ~3s. O script **valida com ffprobe** (codec/duração/frames) e só sai 0 com
clipe válido. Gerado e validado em 2026-07-06: **71,4s (esperado 71,4s), 1785 frames, h264
1280×960, 23 saltos** (fonte: 94,4s @25fps).

Publicar no MediaMTX da bancada (porta **8556** — convenção de
`analises/plano-teste-camera-real.md`; a 8554 é do go2rtc). Em `mediamtx-bench.yml`:

```yaml
paths:
  bench-jumpy:
    runOnInit: ffmpeg -re -stream_loop -1 -i C:\Users\crist\bench-visao\clipe-jumpy.mp4 -c copy -f rtsp rtsp://localhost:8556/bench-jumpy
    runOnInitRestart: yes
```

Cadastrar em `/cameras`: `rtsp://127.0.0.1:8556/bench-jumpy`.

**O que observar** — pré-fix: a cada salto, pessoa ganha id novo e a máscara antiga fica
congelada ~8s (rastro). Pós-fix: salto moderado mantém o id; salto extremo troca o id mas a
máscara antiga some em ≤1–2 rodadas; contadores de travessia seguem coerentes.
