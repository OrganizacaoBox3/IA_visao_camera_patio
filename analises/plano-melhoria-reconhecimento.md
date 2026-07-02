# Plano de melhoria — Relatório vazio + Reconhecimento de pessoas (jul/2026)

> Base: diagnóstico em **runtime real** (câmera pública de Pula, pedestres) —
> `analises/diagnostico-runtime-2026-07.md` (F1–F9 + screenshots) — cruzado com rastreio de
> código (arquivo:linha). As duas frentes CONVERGIRAM; causas confirmadas por execução.

## Causas confirmadas

### A) Relatório vazio (confirmado por execução)
- **43× `POST /api/ingest` → `200 {ok:true}` e mesmo assim `GET /api/data/* → []`.**
  Sem Postgres, `pgstore.ingest` é **no-op silencioso** (`pgstore.js:10-14`) e **não há fallback
  JSON para o histórico** (só alarmes/recipients têm). Hub logou `[db] Postgres NÃO configurado`;
  não há `.env`. A promessa do CLAUDE.md ("Postgres com fallback JSON") não vale p/ `ativ/read/obj/fad`.
- Agravante: a UI diz "Sem histórico ainda… deixe a Central rodando" — promessa que nunca se
  cumpre sem PG. Vazio **desonesto**.
- Estrutural: coleta nasce do rAF do navegador (aba aberta+logada+câmera na página visível).

### B) Pessoas não reconhecidas (confirmado: 2–4 pessoas visíveis × contagem 0 por ~60s; pico 4; sem caixas)
1. **Aritmética de pixels (causa-raiz):** 1080p → ffmpeg 720 (`RTSP_WIDTH` default) → decode tile 640
   → single-shot 512 → coco 300×300 ⇒ pedestre distante (20–40px) vira **5–11px** — abaixo do mínimo
   físico do SSD300 (~25–40px). Nenhum threshold salva.
2. **Longo alcance OFF por default** (opt-in por câmera) — sem ele, sem tiling na grade/limiares menores.
3. **Duplo corte de score:** `people.scoreThreshold 0.4` + **BUG**: ocupação da zona usa sempre
   `objectScoreThreshold 0.5` ignorando o valor LR 0.3 (`atividade.ts:249`; `objetos.ts:123` faz certo).
4. **Atribuição de zona errada:** contagem caiu na zona-semente "Espera", não na zona desenhada
   sobre a rua (`zoneAtAtiv` = primeira zona sobreposta).
5. **Backend tfjs cai p/ CPU silenciosamente** (sem WebGL → console.warn só; operador não vê).
6. `grabTile` nunca faz upscale ⇒ `detectTileWidth:640` é letra morta com fonte 720; e na grade a
   cadência 4s×rotação 16s × `trackMaxDist 0.12` torna o tracker inviável p/ quem anda.

## Plano (ondas; paralelizável por propriedade de arquivo)

### Onda 1 — P0: histórico confiável + vazio honesto
| # | Ação | Arquivos | Esf. |
|---|---|---|---|
| 1.1 | **Fallback JSON p/ histórico** no pgstore (espelha `events.js`): buckets/eventos em JSON com retenção (~30d) e flush atômico; PG continua preferencial | `server/pgstore.js` | M |
| 1.2 | **Vazio honesto:** `/api/data/*` expõe `{persistence:"pg"|"json"|"none"}`; ReportPage distingue "coletando…" × "histórico indisponível (sem banco)" × "sem dados no período"; toast/aviso 1× se ingest falhar (401/erro) | `server/routes/data.js`, `ReportPage`, `report/store.ts` | S |
| 1.3 | (Humano/ops) Configurar Postgres em produção (`PG*`/`DATABASE_URL`) — documentar no manual | docs | XS |

### Onda 2 — P1: reconhecimento (quick wins de maior alavanca)
| # | Ação | Arquivos | Esf. |
|---|---|---|---|
| 2.1 | **Fix bug limiar LR da ocupação**: `atividade.ts:249` usa `longRange.objectScoreThreshold` quando o perfil está ativo | `processors/atividade.ts` | XS |
| 2.2 | **Fix atribuição de zona**: pessoa/detecção atribuída à zona com MAIOR sobreposição (centro-na-zona), não à primeira | `CameraWorkspace` (zoneAtAtiv) | S |
| 2.3 | **Upscale controlado do tile** (`grabTile`/rasterize: dw=tileWidth mesmo com fonte menor) — faz o 640 do LR valer com fonte 720 | `vision/detect.ts` | S |
| 2.4 | **Backend visível**: badge/linha na telemetria da câmera quando detecção roda em CPU (aviso claro; hoje só console) | `CameraWorkspace` + `vision/detect.ts` (getDetectBackend já existe) | S |
| 2.5 | **Resolução por câmera de rua**: garantir campo width/fps/quality no cadastro "+ Câmera IP" (subir p/ 1280–1920 nas panorâmicas) + manual recomendando width+longRange p/ rua | `IpCameraDialog` (se faltar), docs | S |
| 2.6 | **Pessoas no relatório**: `peoplePeak` já persiste e é ignorado — mapear no `loadDataset` e exibir no painel Atividade | `report/store.ts`, `AtividadePanel` | S |

### Onda 3 — P2: grade/tracker (medir antes)
- 3.1 Cadência LR na grade: reduzir intervalo/mais tiles por rodada SÓ p/ câmeras LR; escalar `trackMaxDist` pela cadência efetiva (senão ID novo a cada rodada).
- 3.2 UX: sugerir "Longo alcance" quando a câmera parecer panorâmica (ou destaque no manual/cadastro).

### P3 — se P0–P2 não bastarem (maior)
- Spike **YOLO pequeno via onnxruntime-web** no worker (recall muito maior p/ pedestre pequeno a 640).
  Só depois de medir o efeito de 2.1–2.5 + width 1280 + LR ligado (o hipotético "1920+LR" já dá 20–40px no modelo).

## Validação
- Ondas 1–2: `verify` + e2e verdes; **re-rodar o diagnóstico de runtime** (mesmo método: Pula, zona na rua, 90s) e comparar: pessoas visíveis × contadas, relatório com dados após 2min, aviso de backend. Sem evidência não há pronto.
- Trade-offs a declarar: width 1280 sobe CPU do ffmpeg/decode (por câmera, não default global); upscale de tile aumenta custo por tile (~/proporcional à área).
