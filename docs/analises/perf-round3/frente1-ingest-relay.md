# Perf round 3 — Frente 1: Ingest/Relay (o que desperdiça CPU ao redor da inferência)

> **Missão:** medir o que está AO REDOR da inferência (ingest ffmpeg, demux, tee, relé socket, shed)
> desperdiçando CPU ou causando o serrote 0–100%. Inferência em si (D-FINE S ≈ 400ms/frame, ~1 core/câmera
> no pico @1fps) é física já documentada em `docs/analises/hardware-ideal.md` — fora do escopo.
> **Regra de honestidade:** achado sem número = HIPÓTESE declarada. Todos os números abaixo têm método.

## 0. Veredito em 5 linhas

1. **O relé/demux/tee do hub NÃO é o problema**: 0,012 cores/câmera @10fps (medido). A suspeita de
   `Buffer.concat` O(n²) foi **refutada**: 1,00 chunk/frame — o concat roda 1×/frame, 1,7 ms/s.
2. **A hipótese central era certa em FRAMES e errada em CPU**: sem espectador, 90% dos frames do ffmpeg
   não têm consumidor (10 produzidos vs 0,97 analisados/s — medido), **mas** só ~25–35% do CPU do ffmpeg
   é recuperável baixando o fps de saída: **o decode do stream nativo 25fps é ~70–75% do custo** e não cai
   com `-vf fps`.
3. **fps dinâmico sem viewer (10→2fps): −35% do CPU do ffmpeg por câmera (medido, réplicas ±0,01)** — vale
   fazer, mas é a alavanca nº 2.
4. **A alavanca nº 1 é o SUB-STREAM da câmera (config, não código): −60% no ingest inteiro (medido)** —
   o decode cai 3–5×.
5. **O serrote é o duty cycle do worker de inferência** (0↔1,94 cores com período ~1s — medido em série de
   250ms). Hub e ffmpeg são PLANOS. Não há vazamento oscilante "ao redor" — ao redor há um **custo contínuo**
   (ffmpeg) que soma baseline, e as rajadas de inferência serram por cima.

---

## 1. Bancada e método

| Item | Valor |
| --- | --- |
| Fonte RTSP | MediaMTX `:8556/bench` (bancada pré-existente) — `clipe.mp4` **1280×960 @25fps H.264 (~2 Mbps, GOP 50 = 2s)**, loop, cena CFTV com pessoas |
| Hub de teste | **Cópia isolada** de `server/` no scratchpad (junctions p/ `node_modules` e `models`), porta 4977, `ANALYSIS_ENABLED=1`, `ANALYSIS_MODEL=s` (pin), `ANALYSIS_WORKERS=1` (exceto H3), fallback JSON, go2rtc OFF. **Nenhum código/dado de produção alterado.** |
| Máquina | i7-11390H, **4C/8T** (laptop — turbo/thermal variável, ver caveat) |
| Medição de CPU | Delta de `TotalProcessorTime` por processo (cores usados); séries de 250 ms para a FORMA (serrote) |
| Contadores de frames | Instrumentação no **rtsp.js da cópia** (chunks/frame, kB/frame, ms de demux) + `GET /api/analysis/status` (fps analisado, pulos do gate) + dashboard sintético (socket.io-client) contando frames/bytes |

**Caveat de método (importante):** medições sequenciais de variantes do ffmpeg se mostraram **inúteis**
neste laptop — a mesma variante variou 0,062↔0,212 cores entre janelas (turbo + complexidade do trecho do
clipe em loop; a sequência "decode-only > pipeline completo" chegou a aparecer, o que é fisicamente
impossível). **Toda comparação entre variantes abaixo é SIMULTÂNEA (mesma janela de 60s, mesmo conteúdo),
com réplicas onde a diferença era pequena.** Razões dentro da mesma janela são estáveis (réplicas ±0,01);
valores absolutos entre janelas não são comparáveis.

---

## 2. Cenário base (H1): 1 câmera RTSP @10fps, motor S @1fps, SEM espectador

Configuração de produção-like: `RTSP_FPS=10` (default), 720p, `-q:v 4`, gate de movimento ON.

| Processo | CPU médio (60s, amostras 250ms) | Forma |
| --- | --- | --- |
| **worker (D-FINE S)** | **1,128 cores** (p10 0,51 · p50 1,18 · p90 1,65 · máx 1,94) | **SERROTE** período ~1s: inferência 669–721 ms ocupando ~2 threads + folga até a próxima rodada |
| **ffmpeg (ingest)** | **0,315 cores** (janelas posteriores: 0,241 / 0,226 — varia com o trecho do clipe) | plano (sd 0,14) |
| **hub node (demux+tee+relé)** | **0,012 cores** | plano |

Contadores (instrumentação + status):

- ffmpeg produz **10,0 fps** (~30 kB/frame, ~300 kB/s no stdout); motor analisa **0,97 fps** (alvo 1);
  gate pulou 3 rodadas/min (cena com movimento quase contínuo — pior caso p/ o gate, realista p/ corredor
  movimentado). → **~90% dos frames produzidos não têm NENHUM consumidor** (0 espectadores; engine é
  último-vence @1fps).
- Demux no hub: **1,00 chunk/frame** (frame de ~30 kB cabe no chunk de 64 kB do pipe) → `Buffer.concat`
  roda **1×/frame**, custo total **1,5–1,8 ms/s** (0,17% de um core). **O(n²) refutado** no perfil atual.
  (Viraria 2+ chunks/frame se o frame passasse de 64 kB — largura/qualidade maiores que o default.)
- Com **1 espectador legado** (H4): hub sobe p/ 0,019 cores (**+0,007 cores/viewer**); o viewer recebe
  9,85 fps / **301 kB/s por câmera**. O relé socket é barato em CPU; o custo real de viewer é banda
  (e um dashboard LEGADO recebe TODAS as câmeras — N×300 kB/s).

**Conclusão H1:** fora do worker, o único custo contínuo relevante é o **ffmpeg: 0,2–0,3 cores/câmera,
24/7** — e com o motor ligado o shed **nunca** o pausa (câmera analisada conta como espectador, ADR-009;
`idleSource` vira no-op de fato). Em N câmeras, esse é o baseline sobre o qual as rajadas de inferência
serram.

## 3. Anatomia do custo do ffmpeg (variantes SIMULTÂNEAS, mesma janela)

Réplicas 3×3 (mesma fonte, mesma janela de 60s):

| Variante | Cores (média das réplicas) | Δ vs fps10 |
| --- | --- | --- |
| `-vf fps=10,scale=720:-2 -q:v 4` (produção) | **0,188** (0,184/0,180/0,199) | — |
| `-vf fps=2,scale=720:-2 -q:v 4` | **0,123** (0,126/0,121/0,120) | **−35%** |

Outra janela (2 réplicas cada):

| Variante | Cores | Razão vs full |
| --- | --- | --- |
| full fps10 | 0,062 | 1,00 |
| **decode-only** (`-f null`, sem filtro/encode) | 0,045 | **0,73** |
| `-skip_frame nokey` (decode só keyframes → 0,5 fps @GOP 2s) | 0,017 | 0,27 |

Janela única (6 variantes simultâneas — direção consistente com as réplicas):
decode_only 0,160 · full_fps10 0,212 · full_fps2 0,174 · full_fps1 0,157 · dec+scale sem encode 0,180 ·
**hwaccel d3d11va 0,209 (≈ nada)** · skipnokey 0,121.

**Leitura:** o decode do stream nativo (25fps, 1280×960) é **~70–75%** do custo; `fps=` só corta
scale+encode (**25–35%**). `-hwaccel d3d11va` não ajudou nesta máquina (iGPU; upload/download anula).
`skip_frame nokey` corta 43–73% mas entrega 0,5 fps (< FPS_LINE=2) — só serviria como "modo vigília".

## 4. Resolução da fonte — a alavanca nº 1 (mesma janela, simultâneo)

Fontes auxiliares servidas por um MediaMTX próprio (porta 8560): `main1080` (1920×1080 re-encode do mesmo
clipe) e `sub360` (640×360, ~0,5 Mbps — perfil típico de sub-stream de câmera IP).

| Fonte | full fps10 (cores) | decode-only (cores) |
| --- | --- | --- |
| 1080p | 0,208 | 0,126 |
| 960p (original) | 0,174 | 0,222* |
| **360p (sub-stream)** | **0,083 (−60% vs 1080p)** | **0,046 (3–5× menor)** |

\* o par 960p destoa porque o clipe original tem encoding mais complexo que os re-encodes `veryfast`
(decode depende de bitrate/perfil, não só de resolução) — reforça que em **câmeras reais** (main-stream
1080p/4MP com bitrate alto) o ganho do sub-stream tende a ser **maior** que o medido aqui.

**Trade-off declarado:** o frame do ingest é o que o motor vê (eixo nº 1 de precisão — comentário no
próprio `rtsp.js`). Trocar p/ sub-stream exige validar recall de pessoa nas câmeras do CD antes de
generalizar (o D-FINE reduz p/ ~640px de entrada de qualquer forma; 640×360→720 upscale pode até ser
neutro, mas **não medi precisão** nesta rodada).

## 5. E2E com fps=2 (H2) — o fix prototipado como estado estável

Hub reiniciado com `RTSP_FPS=2` (mesma câmera, mesmo motor):

- ffmpeg: **0,226 cores** (vs 0,241–0,315 @10fps em janelas próximas) — coerente com −25/−35% da §3.
- Demux no hub: 0,5 ms/s. Análise **seguIU funcionando end-to-end** (gate, tracker, ingest de indicadores).
- **Degradação leve e real**: análise alcançou **0,78 fps** (alvo 1,0) vs 0,97 @10fps — com frame novo só a
  cada 500 ms, rodada + inferência de ~800 ms perdem janelas. **Piso recomendado: 2× a cadência efetiva da
  câmera** (normal 1fps → ingest ≥ 2–4fps; com tripwire FPS_LINE=2 → ≥ 4fps; foco 6fps → volta a 10).

## 6. O serrote (a queixa) — de onde vem, com número

- Série de 250 ms do worker (H1): **0,00 ↔ 1,94 cores, período ~1 s** (p10 0,51 / p90 1,65). É o duty
  cycle da rodada: ~700 ms de inferência ocupando ~2 threads, folga, repete. Hub (0,012) e ffmpeg (~0,3,
  sd 0,14) são **planos** — nada "ao redor" oscila.
- Multi-câmera (H3: 4 câmeras, pool auto = 4 workers): a máquina foi a **100% total** e a análise colapsou
  em fila — inferência **4,9–7,6 s** (vs 0,7 s), análise alcançada **0,17–0,2 fps** (alvo 1), e até o
  ffmpeg foi estrangulado (produziu 4–5 fps dos 10 pedidos). **CAVEAT: janela contaminada por ~2–3 cores de
  carga ambiente de outros processos da máquina** — vale como retrato qualitativo do modo de falha
  (demanda > cores ⇒ tudo serra e a análise afunda), não como benchmark limpo.
- **Implicação:** o serrote em si é o formato natural do motor por rodadas — "consertá-lo" de verdade é
  reduzir o trabalho por rodada (tier/INT8/hardware — round anterior) ou o baseline contínuo ao redor
  (este documento). *Hipótese (não medida):* espalhar a FASE das rodadas entre câmeras (stagger) reduziria
  o pico simultâneo sem mudar a média.

## 7. Fixes propostos → ganho (MEDIDO vs estimado)

| # | Fix | Ganho | Status do número |
| --- | --- | --- | --- |
| 1 | **Sub-stream da câmera p/ o ingest de análise** (config da URL; zero código) | **−60% do CPU do ffmpeg/câmera** (0,208→0,083 cores; decode 3–5× menor) | **MEDIDO** (mesma janela; em câmera real tende a mais). Pré-requisito: validar recall. |
| 2 | **fps dinâmico do ffmpeg** = `max(fps_análise_efetivo×2, fps_espectadores)` — sem viewer 2–4fps; com viewer/foco volta ao cfg (10) | **−25/−35% do CPU do ffmpeg/câmera sem espectador** (0,188→0,123 cores, réplicas ±0,01). Em 10 câmeras sem viewer: ~0,7 core contínuo recuperado | **MEDIDO** nos dois estados estáveis (10fps e 2fps e2e). A mecânica runtime reusa `idleSource`/`wakeSource` (respawn já existe — o shed já religa por audiência); o "piso 2×cadência" precisa de validação (degradação 0,97→0,78 fps medida a 2fps) |
| 3 | Consumidores verificados p/ o corte seguro (pré-requisito do #2) | Gate de movimento consome na cadência da rodada (1fps normal) ✓ · cine-loop é buffer **no navegador** (sem viewer não existe consumo; `useCineLoop`/`cineBuffer.ts`) ✓ · overlay `analysis-tracks` só emite com viewer ✓ · dashboards contam por room (`cam:<id>`/`dash-legacy`) ✓ | Verificado no código + bancada |
| 4 | `-skip_frame nokey` como "modo vigília" | −43/−73% MEDIDO, mas 0,5 fps < FPS_LINE | **Não recomendado** agora (quebra contagem; ganho já coberto por #1+#2) |
| 5 | `-hwaccel d3d11va` | 0,209 vs 0,212 = **zero** | **MEDIDO** — não perseguir nesta classe de máquina |
| 6 | Otimizar demux/concat/tee do hub | — | **Não fazer**: 0,012 cores/câmera; O(n²) refutado (1,00 chunk/frame) |

**Não-achados que valem registro:** relé socket.io por viewer é barato (+0,007 cores); emit volatile p/
rooms vazias é ~zero; `analysisTee` passa referência (custo imensurável no perfil). *Hipótese declarada
(não medida):* em produção o go2rtc mantém uma 2ª sessão RTSP por câmera (WebRTC), mas remuxa sem decode —
custo esperado baixo; medir se a rodada 4 precisar.

## 8. Reprodução

- Scripts e dados brutos da rodada: scratchpad da sessão (`sample-cpu.ps1`, `ffmpeg-simul.ps1`,
  `ffmpeg-rep*.ps1`, `ffmpeg-res.ps1`, CSVs `h1/h2/h3/h4-cpu.csv`) — efêmeros; método completo na §1.
- Hub de teste: cópia de `server/` + `RTSP_SOURCES=bench=rtsp://127.0.0.1:8556/bench`, `PORT=4977`,
  `ANALYSIS_ENABLED=1`, `ANALYSIS_MODEL=s`, `GO2RTC_ENABLED=0`, sem PG (fallback JSON).
- Instrumentação usada (só na cópia): contadores no `proc.stdout.on("data")` do `rtsp.js`
  (chunks/frame, kB/frame, ms de demux por segundo).
