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
