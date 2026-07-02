# Diagnóstico de runtime — relatório vazio + pessoas não reconhecidas (2026-07-02)

> **Escopo:** diagnóstico com evidência, SEM correção (outra frente cruza com o código).
> Aplicação rodada DE VERDADE contra câmera pública real, via a infra do e2e (hub isolado
> na 4100, sem Postgres — igual ao ambiente de dev local, ver F1; vite na 5180; Chromium
> headless do Playwright). Spec temporário `e2e/diag.spec.ts` já **deletado** (dependia de
> stream externo; não foi commitado).

## 1. Setup do experimento

- Hub isolado do e2e (`e2e/global-setup.ts`): porta 4100, bootstrap `admin/admin@box3`, **sem PG**
  (env PG\* deletado) — _mesma condição do dev local: não há `.env` no projeto nem variáveis `PG*`/
  `DATABASE_URL` no ambiente do usuário, e `server/index.js` não carrega dotenv_.
- Câmera real: **HLS Pula (Croácia)** `https://cdn-004.whatsupcams.com/hls/hr_pula01.m3u8` (rua com
  pedestres), cadastrada via `POST /api/cameras` (201, id `cam-3739d7cab6`), ffmpeg resolvido pelo hub
  (winget, 8.1.2). Ficou **online em ~11s**, estabilizou em **10.4fps** no tile.
- Fluxo exercitado: login → tile online → workspace fullscreen → zona nova "Área 5" desenhada sobre a
  rua (total 5 zonas: 4 semente + 1) → 90s de coleta (painel a cada 15s, screenshot a cada 30s) →
  Relatório (1ª visita) → +60s de câmera → Relatório (2ª visita) → `GET /api/data/*` direto + teste
  de ingest sintético.
- Modo demo ("Limite curto (10s)"): **desligado** (`aria-checked=false`) durante todo o teste.
- Teste passou (3.1min), câmera removida ao final, portas 4100/5180 livres.

## 2. Evidências

Screenshots (scratchpad da sessão):
`C:\Users\crist\AppData\Local\Temp\claude\C--Users-crist-grendene-cd-inovacao-visao-computacional-mvp\4d25e2e4-e55e-413d-b81b-a5979604c8ef\scratchpad\diag\`

| Arquivo                      | O que mostra                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-tile-grade.png`          | Tile online · 10.4fps, vídeo nítido (rua 1080p). **≥3 pedestres visíveis** (2 cruzando junto ao carro branco); pills das 4 zonas: **todas `0p`**. |
| `02-camadas.png`             | Aba Camadas: "Caixas / detecções" **ON**, confiança 50%, toggle **"Longo alcance / Panorâmica" existe e está OFF** (default).                     |
| `03-workspace-t0s/30s.png`   | Workspace full, zona "Área 5" criada. Pedestres/carros visíveis na rua; **kpibar `0 pessoas · pico 0`**, nenhuma caixa de detecção desenhada.     |
| `03-workspace-t60s.png`      | Primeira contagem só após ~60s: `3 pessoas · pico 3` (Espera·3p). **"Área 5" (a zona sobre a rua) segue `0p`.**                                   |
| `03-workspace-t90s.png`      | `1 pessoa · pico 4` — contagem oscila 0→3→1 em 30s com fluxo contínuo de pedestres.                                                               |
| `04-relatorio-1a-visita.png` | Relatório após ~2,5min de câmera: **"Sem histórico de atividade ainda."** (estado vazio, sem erro).                                               |
| `05-workspace-final.png`     | Câmera reaberta +60s: **`0 pessoas · pico 0`** (pico 4 anterior foi perdido no fechar/reabrir), pedestres/ônibus visíveis.                        |
| `06-relatorio-2a-visita.png` | Relatório após ~4min de câmera + ↻ recarregar: **continua "Sem histórico"**.                                                                      |

Dump completo (console do browser, tráfego de API, amostras do painel):
`...\scratchpad\diag\diag-evidencia.json`

### 2.1 Relatório (o dado morre no servidor, sem aviso)

- O front **enviou 43× `POST /api/ingest`** durante o teste (1 a cada ~3s com a câmera aberta,
  como projetado) — **todos responderam `200 {"ok":true}`**.
- Ainda assim, **todos os 8 endpoints `GET /api/data/{ativ,read,obj,fad}/{buckets,events}`
  devolveram `[]`** (len=2), antes e depois. `GET /api/alarms` → `[]`.
- Prova direta: `POST /api/ingest` sintético (amostra ativ válida) → `200 {"ok":true}`; `GET
/api/data/ativ/buckets` imediatamente depois → `[]`. **O hub confirma sucesso e descarta o dado.**
- Log do hub no boot: `[db] Postgres NÃO configurado (defina PGDATABASE + PG* ou DATABASE_URL)` —
  única menção ao problema, invisível ao operador.
- Causa no código: `server/pgstore.js` — `ingest()` faz `if (!db.configured() || !p) return;` e
  `buckets()/events()` devolvem `[]` quando `!db.configured()`; `server/routes/data.js` responde
  `{ok:true}` mesmo assim. **Não existe o "fallback JSON" citado no CLAUDE.md §1 para o histórico**
  (o fallback JSON existe para recipients/users/alarmes, não para `pgstore`).
- Ambiente real de dev reproduz a condição: **não há `.env`** no repo nem `PG*`/`DATABASE_URL` no
  ambiente do usuário; o hub (`npm run hub`) não carrega dotenv. Ou seja, rodando como está, o
  relatório fica vazio **sempre**, com a UI dizendo apenas "Deixe a Central rodando para acumular
  indicadores" — promessa que nunca se cumpre.

### 2.2 Reconhecimento de pessoas

Console do browser (capturado desde o boot da página):

```
[log]  Could not get context for WebGL version 2
[warning] Initialization of backend webgl failed
[warning] Error: WebGL is not supported on this device
[warning] [detect] tfjs no worker caiu para backend CPU — detecção em CPU é uma ordem de
          magnitude mais lenta; verifique o suporte a WebGL/OffscreenCanvas no worker.
```

- O tfjs **caiu silenciosamente para CPU** no worker (neste ambiente headless não há WebGL; a
  telemetria de backend existe, mas só como `console.warn` — o operador não vê nada na UI).
- Série temporal do painel (câmera aberta, rua com pedestres o tempo todo, ~10fps de vídeo):

  | t    | kpibar (pessoas · pico)   | zonas com gente                       |
  | ---- | ------------------------- | ------------------------------------- |
  | 0s   | 0 · 0                     | todas 0p (≥2 pessoas visíveis)        |
  | 15s  | 0 · 0                     | todas 0p                              |
  | 30s  | 0 · 0                     | todas 0p (pedestres visíveis)         |
  | 45s  | 0 · 0                     | todas 0p                              |
  | 60s  | **3 · 3**                 | Espera·3p; **Área 5 (rua): 0p**       |
  | 75s  | 3 · 3                     | idem                                  |
  | 90s  | **1 · 4**                 | Espera·1p                             |
  | +60s (reaberta) | **0 · 0** (pico perdido) | todas 0p (ônibus+pedestres visíveis) |

- **Pessoas visíveis × contadas:** nos screenshots t0/t30/final há claramente 2–4 pedestres na rua
  e a contagem foi **0**; o pico do teste inteiro foi 4 numa cena com fluxo contínuo. Nenhuma caixa
  de detecção chegou a aparecer sobre pessoas nos screenshots (camada "Caixas" ligada, confiança 50%).
- **Primeira detecção só após ~60s** da câmera aberta (carga do modelo + inferência em CPU: a
  cadência alvo de 350ms/inferência no full não se sustenta; FPS da workspace oscilou 4–29).
- **"Longo alcance / Panorâmica" existe na aba Camadas e está OFF por default** — exatamente o
  perfil desenhado para cena de rua vista de cima (tiling 4×4, limiar 0.3). Não foi ligado no teste
  (conforme roteiro); com ele OFF, pedestres distantes ficam abaixo dos limiares
  (`people.scoreThreshold=0.4`, `objectScoreThreshold=0.5`).
- **Atribuição por zona:** quando houve contagem (3p), ela caiu na zona-semente "Espera", e a zona
  "Área 5" desenhada sobre a rua ficou 0p — `zoneAtAtiv()` (`CameraWorkspace.tsx:598`) devolve a
  **primeira** zona da lista que contém o centro da pessoa; zonas sobrepostas (as 4 sementes cobrem
  o frame) capturam a contagem antes da zona criada pelo usuário.

## 3. Falhas constatadas (sem proposta de solução aqui)

1. **F1 — Histórico é descartado silenciosamente sem Postgres (causa direta do "relatório vazio").**
   `POST /api/ingest` responde `200 {ok:true}` e joga o dado fora; `GET /api/data/*` responde `[]`;
   a UI conclui "sem dados ainda" e orienta a "deixar a Central rodando". 43 ingests reais perdidos
   no teste. Evidência: §2.1, `04/06-relatorio-*.png`, log `[db] Postgres NÃO configurado`.
2. **F2 — Ambiente de execução real roda nessa condição.** Sem `.env`/env `PG*` na máquina e sem
   carregamento de dotenv no hub — ou seja, F1 não é só o cenário e2e, é o default de quem clona e
   roda. (Divergência doc×código: CLAUDE.md promete "Postgres com fallback JSON"; `pgstore.js` não
   tem fallback.)
3. **F3 — Nenhum sinal na UI de que a persistência está desligada/degradada.** Único aviso é uma
   linha de log no terminal do hub. Relatório, Central e ingest não distinguem "sem dados" de
   "sem banco".
4. **F4 — Detecção de pessoas cai para CPU silenciosamente e fica lenta/intermitente.** Sem WebGL no
   worker, o backend vira CPU (aviso só no console). Primeira contagem levou ~60s; contagem oscilou
   0→3→1→0 numa rua com pedestres contínuos; pico global do teste = 4. Evidência: §2.2.
5. **F5 — Subcontagem severa com o perfil default em cena de rua/panorâmica.** Pessoas visíveis
   (2–4) contadas como 0 na maior parte do tempo; nenhuma caixa desenhada sobre pedestres com
   confiança 50%. O perfil "Longo alcance" (feito para essa cena) existe mas é opt-in e está OFF.
6. **F6 — Contagem atribuída à zona errada em zonas sobrepostas.** As 4 zonas-semente (Expedição/
   Carga/Estoque/Espera) cobrem o frame de toda câmera nova e capturam as pessoas antes da zona
   desenhada pelo usuário ("Área 5" sobre a rua ficou 0p enquanto "Espera" marcava 3p).
7. **F7 — Indicadores de presença (pico/permanência) zeram ao fechar/reabrir a câmera.** Pico 4
   observado aos 90s virou 0 ao reabrir (`05-workspace-final.png`) — sem persistência nem no
   cliente (e, por F1, nem no servidor).
8. **F8 (menor, estático) — Fallback main-thread usa modelo diferente do configurado.**
   `src/vision/model.ts` carrega `lite_mobilenet_v2` (recall menor) enquanto o worker usa
   `detection.base = "mobilenet_v2"` — justamente no caminho degradado (worker falhou) o modelo é
   mais fraco.
9. **F9 (menor, estático) — Erros de rota são mascarados como `400 "requisição inválida"`**
   (`server/index.js:105`): se o PG estiver configurado mas inacessível, `/api/data/*` responderia
   400 genérico (e o ingest fire-and-forget engole). Não exercitado no runtime (sem PG), registrado
   para a frente de código.

## 4. O que funcionou (para delimitar o problema)

- Ingestão HLS→ffmpeg→frames: câmera pública online em ~11s, 10.4fps estáveis, pílula de status ok.
- CRUD de câmera via API (201/DELETE ok), tile→workspace, desenho de zona, painel/telemetria ao vivo,
  navegação Central↔Relatório, estados de loading/vazio do relatório (sem erro JS).
- O front **envia** o histórico corretamente (43 ingests com payload válido) — o problema do
  relatório é 100% servidor/configuração, não o pipeline do navegador.

## Re-diagnóstico pós-correções (2026-07-02)

> **Objetivo:** medir o efeito das correções Rec-A..E (commits `b989065..c6524d6`) com o MESMO
> método do baseline acima. Spec temporário `e2e/diag2.spec.ts` (já **deletado**, não commitado).
> Hub isolado 4100 sem PG, mesma câmera HLS de Pula, Chromium headless (sem WebGL → detecção CPU,
> pior caso — igual ao baseline). Modo demo OFF (`aria-checked=false`). Zona "Área 5" desenhada
> sobre a metade inferior do frame. 1 teste, verde, 3.7min; câmera removida ao final.
>
> **Caveats de comparabilidade (declarados):** (1) a câmera de Pula é PTZ e **mudou de preset**
> entre os testes — a cena agora é ~2/3 telhado + faixa de rua à direita (pedestres menores e menos
> numerosos que no baseline; ~1–3 visíveis por screenshot contra 2–4 no baseline); (2) janela de
> observação de **60s por config** (5 amostras a cada 15s) contra 90s no baseline, por limite do
> runner. As conclusões abaixo consideram os dois fatores.

### A) Relatório (Rec-A/B) — antes × depois

| Item                        | Antes (baseline)                                   | Depois (Rec-A/B)                                                                                          |
| --------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /api/ingest`          | 43× `200 {ok:true}` e dado **descartado**          | 44× `200` e dado **persistido**                                                                            |
| `GET /api/data/status`      | (endpoint não existia)                             | `{"persistence":"json","counts":{"ativ":5,"read":0,"obj":0,"fad":0}}`                                      |
| `GET /api/data/ativ/buckets`| `[]` sempre                                        | **5 buckets** (1 por zona; ~1204 samples/zona; `peoplePeak` presente — "Área 5" com `peoplePeak: 1`)       |
| Relatório (UI)              | "Sem histórico de atividade ainda." sempre         | **Com dados**: Resumo com cards (50% tempo ativo, 9m parado, Destaques); Atividade com heatmap "Quando para" |
| KPI "pico de pessoas"       | inexistente                                        | presente na aba Atividade: **"1 · pico de pessoas"**                                                       |
| Fonte da persistência na UI | invisível (só log no terminal)                     | rodapé dos filtros: **"histórico: arquivo local"**                                                         |
| Log de boot do hub          | só `[db] Postgres NÃO configurado`                 | + **`[data] histórico em fallback JSON (sem Postgres)`**                                                   |
| `data-hist.json`            | não existia (sem fallback)                         | existe no dir do hub (`visao-e2e-*/data-hist.json`, 1.6KB, 5 buckets — flush atômico confirmado em disco)  |

**F1/F2/F3: corrigidas de ponta a ponta** (ingest→memória→arquivo→API→UI). Resíduo cosmético novo:
o rodapé INFERIOR do painel Atividade ainda diz "Histórico (Postgres)" hardcoded
(`src/routes/report/chrome.tsx`) enquanto o rodapé dos filtros diz "arquivo local" — inconsistência
de texto, não de dado. A telemetria de ingest (Rec-B) também funcionou: numa execução descartada
(com processos órfãos de um run anterior interferindo) o front avisou
`[ingest] hub sem confirmar 3 lote(s) de indicadores — permanecendo em fila local (últ. erro: HTTP 400)`
— o warn 1×-por-sequência existe e dispara; não ocorreu na execução limpa.

### B) Reconhecimento (Rec-C/D/E) — 3 configurações na mesma cena, antes × depois

Série do painel (5 amostras/60s por config; "visíveis" = contagem manual nos screenshots):

| Config                          | Pessoas visíveis | Contadas (t0→t60)  | Pico | Zona da contagem       | Badge backend       | FPS workspace |
| ------------------------------- | ---------------- | ------------------- | ---- | ---------------------- | ------------------- | ------------- |
| Baseline (default, 90s)         | 2–4              | 0,0,0,0,**3**,3,**1**| 4   | **"Espera" (errada)**  | inexistente         | 4–29          |
| 1. Default (width 720, LR off)  | ~1–3             | 0,0,0,0,0           | 0    | —                      | **"detecção: CPU ⚠"** (aparece ~t30) | 11–26 |
| 2. +LR (Longo alcance ON)       | ~1–3             | 0,0,0,0,0           | 0    | —                      | "detecção: CPU ⚠"   | **1–17** (LR pesa) |
| 3. +LR + width 1920 (PATCH ok, ffmpeg reiniciou) | ~1–3 | 0,0,0,0,**1**  | 1    | **"Área 5" (a desenhada!) · 1p** | "detecção: CPU ⚠" | **0–25** (quedas a 0–4) |

- **Fix da zona (Rec-C, F6): funcionou.** A única contagem do teste caiu na zona desenhada pelo
  operador ("Área 5 · ATIVA · 1p" na pill do canvas e `peoplePeak:1` no bucket da "Área 5"), não
  mais na zona-semente "Espera". Evidência n=1 — direção certa, amostra pequena.
- **Badge de backend (Rec-C, F4-visibilidade): entregue.** "detecção: CPU ⚠" visível na kpibar
  (saturado, com tooltip); o fallback deixou de ser invisível ao operador.
- **Console:** mesmos warns do baseline (WebGL indisponível → worker em CPU); **nenhum erro novo**.
- **Reconhecimento em si: AINDA FALHA no pior caso (CPU).** Mesmo na config 3 (a "receita"
  completa: LR + upscale de tile + 1920), foi **1 detecção em 60s** numa cena com ~1–3 pedestres
  visíveis; configs 1 e 2 ficaram em **0 absoluto**. LR + 1920 elevam o custo (FPS da workspace
  despenca a 0–4 em CPU) sem ganho material de recall neste ambiente. A cena PTZ menos favorável e
  a janela menor explicam parte da queda vs baseline (pico 4), mas **não** o padrão: coco-ssd/tfjs
  em CPU segue com subcontagem severa em cena de rua/panorâmica (F5 permanece).

### Veredito honesto

1. **Relatório vazio (F1–F3): resolvido.** Persistência JSON + status + vazio honesto + fonte na
   UI + pico de pessoas — confirmado por API, arquivo em disco e screenshot.
2. **Atribuição de zona (F6): resolvida** na evidência disponível (n=1).
3. **Invisibilidade do fallback de CPU (F4-UI): resolvida** (badge saturado na telemetria).
4. **Subcontagem (F5): NÃO resolvida em CPU — gatilho do P3/YOLO atingido.** As correções Rec-C/D/E
   são necessárias mas não suficientes: com tfjs/coco-ssd em CPU, nem a config completa conta
   pedestres de rua de forma utilizável. Recomendação: avançar o P3 (modelo de detecção melhor —
   YOLO-family — e/ou garantir backend GPU/WebGL no ambiente alvo). Ressalva: este re-teste rodou
   headless SEM WebGL (pior caso); vale UMA medição da config 3 em máquina com GPU/WebGL real antes
   de dimensionar o P3 — se com GPU o recall subir a nível utilizável, o P3 vira otimização, não
   correção.
5. **F7 (pico zera ao reabrir) e F8 (modelo do fallback main-thread): não endereçadas nesta onda**
   (fora do escopo Rec-A..E), seguem em aberto.

Evidências: screenshots + `diag2-evidencia.json` (console, 44 ingests, série completa do painel,
respostas de API) em
`...\scratchpad\diag2\` (sessão): `00-zona-area5-criada.png`, `01-cfg1-default-t{0,30,60}s.png`,
`02-cfg2-lr-ligado.png`, `02-cfg2-lr-t{0,30,60}s.png`, `03-cfg3-lr1920-t{0,30,60}s.png`,
`04-relatorio-resumo.png`, `05-relatorio-atividade.png`.

## Re-diagnóstico fluxo (2026-07-02) — onda "flow" (persistência + ByteTrack + pé/histerese)

> **Objetivo:** medir a onda "flow" (evento por cruzamento persistido + ByteTrack + pé/histerese +
> contadores que sobrevivem) com o MESMO método dos diagnósticos acima. Spec temporário
> `e2e/diag3.spec.ts` (já **deletado**, não commitado). Hub isolado 4100 sem PG (persistência
> **json**), mesma câmera HLS de Pula (`cam-b6b681d19f`), Chromium headless — **sem WebGL ⇒
> detecção em CPU, pior caso CONHECIDO**. Por isso o teste tem duas partes: a **cadeia de
> persistência** (determinística, via `POST /api/ingest` direto com ids REAIS de câmera e linha —
> independe de detecção) e a **observação com pedestres reais** (dependente). 1 teste, verde,
> 3.8min; câmera removida ao final; portas 4100/5180 livres.
>
> **Caveat de cena (declarado):** a PTZ de Pula mudou de preset de novo — a cena agora é ~80%
> parede/toldo em primeiro plano com faixa estreita de rua à direita; **pedestres ~0–1 visíveis
> por screenshot** (contra 2–4 no baseline). A Parte 2 fica POUCO informativa sobre recall nesta
> rodada; a Parte 1 não depende disso.

### Parte 1 — Cadeia de persistência: TUDO VERDE

Linha desenhada por drag real no `.cam-stage` (editor "⇄ Linha") → tripwire
`cam-b6b681d19f-twmr3nmg0j1` salvo no backend → 5× `POST /api/ingest` `{kind:"flow", op:"cross"}`
com cameraId/tripwireId REAIS (3 `in`, 2 `out`, ts=agora).

| Passo                                       | Resultado                                                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Câmera HLS cadastrada + online              | 201; pílula `online · fps`; FPS da workspace 8–16 durante o teste                                                                                                            |
| Tripwire por drag + `GET /api/tripwires/:id`| **PASS** — 1 linha, coords normalizadas coerentes com o drag (a≈{0.343,0.420}, b≈{0.657,0.579})                                                                              |
| 5× ingest flow/cross (3 in, 2 out)          | **PASS** — 5× `200`; `GET /api/data/flow/buckets` → **1 bucket hora×câmera×linha `{in:3, out:2}`**; `/api/data/flow/events` → **5 eventos crus** (3 in, 2 out, só metadados) |
| `GET /api/data/status`                      | `{"persistence":"json","counts":{...,"flow":1}}` — kind `flow` presente no status e no fallback JSON                                                                         |
| FECHAR e REABRIR a câmera                   | **PASS** — painel "Linhas": **3 entradas hoje / 2 saídas hoje**; HUD no canvas: **"L1 in 3 out 2"** (acumulado do dia vindo do servidor via `loadFlowToday`)                 |
| RELOAD da página inteira + reabrir          | **PASS** — **3 / 2 de novo** — "nunca mais perder" PROVADO (o acumulado vive no hub, não na sessão)                                                                          |
| Relatório → Atividade → seção "Fluxo"       | **PASS** — "FLUXO DE PESSOAS — LINHAS DE CONTAGEM": **3 entradas · 2 saídas · saldo 1 · 1 linha** + gráficos por hora; rodapé "histórico: arquivo local"                     |
| CSV (⬇ CSV do relatório)                    | **PASS** — blocos `FLUXO DE PESSOAS (linhas de contagem)` (Entradas 3; Saídas 2; Saldo 1) e `FLUXO POR LINHA` presentes no arquivo baixado                                    |
| Nota menor                                  | ingest direto sem `shift` → gravado `shift:null` (contrato tolera; o caminho real do front, `recordFlow`, envia `shiftFor(ts)`) — sem impacto na agregação                    |

### Parte 2 — Pedestres reais em CPU (~90s, honesta)

Zona "Área 5" desenhada sobre a faixa inferior (persistiu junto às 4 sementes), camada **Caixas
ON**, Longo alcance **OFF** (default). Série a cada 15s (7 amostras):

| t      | kpibar (pessoas · pico) | badge backend        | in/out "hoje" | flow/events (total) | zonas                          |
| ------ | ----------------------- | -------------------- | ------------- | ------------------- | ------------------------------ |
| 0s     | 0 · 0                   | (ainda não reportou) | 3 / 2         | 5                   | todas VAZIA                    |
| 15s    | 0 · 0                   | —                    | 3 / 2         | 5                   | Espera:ATIVA · Área 5:ATIVA    |
| 30–45s | 0 · 0                   | **detecção: CPU ⚠**  | 3 / 2         | 5                   | Área 5:ATIVA                   |
| 60–90s | 0 · 0                   | detecção: CPU ⚠      | 3 / 2         | 5                   | Área 5:LENTA/ATIVA (movimento) |

- **Nenhum cruzamento real** (flow/events ficou em 5 = só os sintéticos; in/out não mudou) —
  esperado: 0 pessoas detectadas em CPU numa cena onde pedestres mal aparecem (PTZ na parede).
  A cadeia detecção→ByteTrack→pé/histerese→`recordFlow` **não foi exercitada com gente real**
  nesta rodada.
- O que a Parte 2 confirmou: badge "detecção: CPU ⚠" visível na kpibar, atividade por movimento
  na zona desenhada (Área 5 ATIVA/LENTA), acumulado 3/2 estável nos 90s, FPS 8–16, **nenhum erro
  novo de console** (mesmos warns de WebGL do baseline).

### Veredito honesto

1. **PROVADO (determinístico): a cadeia de persistência do fluxo funciona de ponta a ponta.**
   Cruzamento (`flow:cross`) → bucket hora×câmera×linha no hub (fallback JSON, mesmo sem PG) →
   API (`/api/data/flow/*`, `status` com `flow`) → HUD/painel "hoje" ao reabrir → **sobrevive a
   fechar/reabrir E a reload** → Relatório (seção Fluxo + por hora + por linha) → CSV. O
   "contador que sobrevive" do plano 1.2/1.3 está entregue e verificado com ids reais.
2. **NÃO PROVADO nesta rodada (depende de detecção): o cruzamento REAL vindo do vídeo.** Em CPU
   (headless, pior caso conhecido) e com a PTZ na parede, houve 0 detecções em 90s — ByteTrack +
   âncora no pé + histerese não chegaram a ser exercitados com pedestres reais. É o MESMO gargalo
   F5 já medido acima, não uma regressão da onda "flow".
3. **Conclusão operacional:** a entrega da onda "flow" (persistência/contadores) está sólida; o
   elo que falta para o fluxo contar sozinho é o motor de detecção — segue valendo o gatilho da
   **Onda 3 (D-FINE-N via onnxruntime-web / backend GPU-WebGL)** e a medição única em máquina com
   GPU real antes de dimensioná-la.
4. **F7 fica parcialmente endereçada:** o fluxo (in/out) agora sobrevive a fechar/reabrir/reload;
   o **pico de presença da sessão** continua zerando ao reabrir (fora do escopo desta onda; o
   pico horário persiste via `peoplePeak` nos buckets ativ).

Evidências: screenshots + `diag3-evidencia.json` (console desde o boot, tripwire salvo, buckets/
eventos/status de flow, série completa) + `relatorio-atividade.csv` em `...\scratchpad\diag3\`
(sessão): `01-linha-desenhada.png`, `02-linhas-hoje-apos-reabrir.png`,
`03-linhas-hoje-apos-reload.png`, `04-relatorio-fluxo.png`, `05-obs-t{00,15,30,45,60,75,90}s.png`,
`06-workspace-final.png`.
