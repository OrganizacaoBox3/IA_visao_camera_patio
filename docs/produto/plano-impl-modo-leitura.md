# Passo a passo de implementação — Modo "Leitura de código de barras"

> Análise do código atual + plano de alteração para o novo **modo de câmera (Leitura)**, no mesmo projeto. **Aditivo** (não quebra o modo Atividade). UI **minimalista, semântica e focada em performance**. Conceito em `plano-modo-leitura-codigo.md`.

> **STATUS (2026-06-09): F0 + F1 + F2 implementadas e build verde.** Arquivos F0/F1: `config.ts` (bloco `reading`), `cameraConfig.ts` (modo/ponto por câmera em localStorage), `reading/decoder.ts` (BarcodeDetector nativo + `@zxing/library` lazy — chunk separado, fora do bundle de atividade), `reading/cluster.ts` (dedup por ponto + métricas; `pushRead` retorna `{newBox,becameMulti}`), `ReadingView.tsx` (decode throttled, ROI visual, tile + console), `DashboardPage.tsx` (⚙ Câmeras, agrupamento por Ponto, card + console do ponto, `handleRead`=push+persist). **F2:** `store.ts` (VER 2 → `readingBuckets`+`readingEvents`; `recordReads`/`loadReadingDataset`/`loadReadingEvents`/`seedReadingDemo`; `clearAll` estendido), `mock.ts` (agregações de leitura + seed + `toReadingCSV`), `ReportPage.tsx` (seletor de modo Atividade|Leitura; hooks dos 2 modos no topo p/ ordem estável; KPIs caixas/leituras/multi%/ponto-top/pico; abas Quando=heatmap hora×ponto, Onde=ranking por ponto + contribuição por câmera, Tendência=14d+turno, Leituras=tabela; CSV/PDF). **VALIDAÇÃO DE DECODE (2026-06-09):** `BarcodeDetector` é ausente no Chrome/Edge desktop Windows → caminho real é ZXing. Round-trip funcional `server/_zxing_roundtrip_test.cjs` prova 1D **EAN-13 3/3** pela pipeline exata do app (`RGBLuminanceSource`→`HybridBinarizer`→`MultiFormatReader.decodeWithState` com `POSSIBLE_FORMATS`+`TRY_HARDER`); o caso scale=2 falhando confirmou que **baixa resolução** era a causa real do "não lê". Correções: (a) **captura hi-res por câmera de leitura** — central manda `set-capture` ao hub → nó eleva p/ 1280px q0.9 (atividade segue 480/0.6); (b) decoder usa `decodeWithState` (preserva hints; `decode()` os apagava) + mapeia formatos p/ `BarcodeFormat`. **F3 FEITA:** `ReadingView` detecta PASSAGEM (motion no ROI, borda de subida, debounce) → `onPass`; `cluster.pushPass` dedup por ponto → snapshot ganha `passages/noReads/readRatePct`; `store.recordPass`+`readingBucket.passages`; **taxa de leitura %** e **no-reads** no card/console/relatório; **alerta de queda de taxa** (toast, com volume mínimo + cooldown). **Próximo: F4 (acabamento: manuais de posicionamento, multi-unidade, polish).**

---

## 1. Abordagem (resumo)
- **Modo é config central por câmera** (`atividade` | `leitura`), persistida por `cameraId` em localStorage — **igual ao padrão das zonas**. O nó `/camera` e o **hub não mudam** (continuam só transmitindo frames; a decodificação roda na **central**, fiel a "central processa tudo").
- **Aditivo:** default `modo = "atividade"` → tudo que existe hoje segue intacto. Câmeras de leitura entram como caminho paralelo.
- **Sem nova rota:** leitura vive na **Central** (agrupada por *Ponto de Leitura*) e no **Relatório** (seletor de modo). `/camera` e o shell ficam iguais.

---

## 2. Pontos de impacto no código (mapa)
| Arquivo | Papel hoje | O que muda |
|---|---|---|
| `src/config.ts` | thresholds (detecção/zonas/rede) | **+ bloco `reading`** (formatos, cadência de decode, janela de dedup, throughput esperado, limite de taxa) e defaults de modo |
| **novo** `src/cameraConfig.ts` | — | store local por câmera: `{ modo, pontoLeitura }` (load/save em localStorage, padrão das zonas) |
| `src/CameraView.tsx` | pipeline de **atividade** (motion+coco-ssd+zonas+presença) | permanece o caminho **atividade**; extrair chrome comum (feed/tile/full) p/ reuso |
| **novo** `src/ReadingView.tsx` | — | pipeline de **leitura** reusando o shell de feed/tile/full: decodifica + emite `onRead` (sem coco-ssd) |
| **novo** `src/reading/decoder.ts` | — | wrapper `BarcodeDetector` (nativo) com fallback **`@zxing/library`** (lazy import) |
| **novo** `src/reading/cluster.ts` | — | agregador por **Ponto de Leitura**: dedup `(ponto,code,janela)`, taxa/throughput/no-reads/contribuição por câmera |
| `src/routes/DashboardPage.tsx` | grade única de câmeras | lê `modo/ponto` por câmera; **agrupa leitura por Ponto** (card do ponto + tiles); renderiza `CameraView` (atividade) ou `ReadingView` (leitura); wire `onRead`; setter de modo/ponto por câmera |
| `src/routes/ReportPage.tsx` | relatório (atividade) em abas | **+ seletor de modo**; modo Leitura com KPIs/abas próprios |
| `src/report/store.ts` | `buckets`+`events` (atividade) | **+ `readingBuckets`+`readingEvents`** (bump `VER`; upgrade cria stores) |
| `src/report/mock.ts` | agregações + seed (atividade) | **+ agregações de leitura** (taxa, no-reads, contribuição) + seed de leitura + tipos |
| `src/routes/CameraPage.tsx` | nó (webcam→frames) | **sem mudança** (opcional: rótulo "modo definido na central") |
| `src/main.tsx`, `AppShell.tsx` | rotas + shell | **sem mudança** (sem nova rota) |
| `server/index.js`, `rtsp.js` | hub (relé de frames) | **sem mudança** |
| `package.json` | deps | **+ `@zxing/library`** (fallback; carregado por import dinâmico — não pesa no bundle de atividade) |

---

## 3. Decisões-chave
1. **Onde mora o modo:** config central por câmera (`cameraConfig.ts`), setável na UI (tile/drill-in). Nó e hub intocados.
2. **Decodificação:** `BarcodeDetector` nativo (Chrome/Edge) quando disponível; **lazy-load `@zxing/library`** como fallback. Roda na central, **throttled** (ex.: ~8–10 decodes/s) e, idealmente, sobre um **ROI** (faixa da esteira) para performance.
3. **Performance:** câmera em leitura **não carrega/roda coco-ssd** (gate no efeito de modelo por modo) → menos CPU. Mantém só um **motion diff leve** (já existe) para "passou caixa" (no-read).
4. **Ponto de Leitura (cluster):** dedup `(ponto, code, janela)` → caixa lida se **qualquer** câmera leu. Métricas por ponto: taxa %, throughput, no-reads, multi-reads, contribuição por câmera.
5. **No-read:** cruzar **passagem de caixa (motion)** × **ausência de leitura** na janela → no-read (alerta). MVP pode começar só com taxa/throughput e ligar no-read na F3.
6. **Histórico:** stores separados de leitura (não polui os de atividade); relatório seleciona o modo.

---

## 4. Passo a passo (faseado, file-by-file)

### F0 — Modelo de modo (base, sem comportamento de leitura)
1. `config.ts`: adicionar bloco `reading` + `camera.defaultModo = "atividade"`.
2. `cameraConfig.ts` (novo): `getCameraCfg(id)`/`setCameraCfg(id, cfg)` em localStorage (`vp-camcfg-<id>`), `{ modo, pontoLeitura }`.
3. `DashboardPage`: ler cfg por câmera; **setter de modo/ponto** (controle discreto no tile ou no drawer de detalhes) — semântico e minimalista (um seletor pequeno). Ainda renderiza tudo como atividade.
   - *Critério:* dá para marcar uma câmera como "leitura" e atribuí-la a um ponto; persiste.

### F1 — Pipeline de leitura + central por ponto (primeiro valor)
4. `reading/decoder.ts` (novo): decode com BarcodeDetector/ZXing (lazy), por ROI, throttled.
5. `ReadingView.tsx` (novo): reusa o shell de feed/tile/full; roda o decoder; emite `onRead{cameraId,pontoLeitura,code,format,conf,ts}`; **tile minimalista** (último código mono + taxa + status); **full = console de leitura** (anel de taxa, lista de códigos ao vivo, ROI sutil).
6. `reading/cluster.ts` (novo): dedup por ponto + métricas; snapshots p/ a UI.
7. `DashboardPage`: separar câmeras por modo; **agrupar leitura por Ponto** (card do ponto agregando o cluster + tiles-membro); wire `onRead` → cluster; drill-in do ponto.
   - *Critério:* webcam apontada p/ um código impresso → aparece lido na central; várias câmeras no mesmo ponto → dedup + contribuição.
8. Extrair chrome comum de `CameraView` (feed/getContentRect/tile/full) p/ um util compartilhado, evitando duplicação com `ReadingView`.

### F2 — Histórico + relatório (modo leitura)
9. `store.ts`: `readingBuckets` (por ponto|hora: caixas, noReads, multiReads, contribuição) + `readingEvents` (code,ponto,câmera,ts); bump `VER`.
10. `mock.ts`: agregações de leitura (taxa, throughput, no-reads, por câmera) + seed.
11. `ReportPage`: **seletor de modo**; modo Leitura → KPIs (caixas lidas, **taxa %**, no-reads, throughput, multi-reads) + abas (Quando, Onde por ponto/câmera, Tendência, Leituras, No-reads). Reusa o shell de abas (anti-scroll).

### F3 — No-read + alertas de taxa
12. Cruzar motion×leitura no `ReadingView`/cluster → detectar no-read; **alerta** quando taxa cai abaixo do limite (toast, como hoje).

### F4 — Acabamento
13. Manuais (`docs/produto/manuais/`): formatos suportados, **posicionamento das câmeras** no ponto, ROI/iluminação.
14. Multi-unidade (ponto carrega CD), export CSV/PDF do modo leitura, polish.

---

## 5. UI por modo (minimalista · semântica · performance)
- **Tile de leitura:** super enxuto — **último código** (mono), **taxa de leitura %** (cor semântica: verde alto · âmbar caindo · vermelho crítico), dot de status. Sem gráficos pesados no tile.
- **Card do Ponto:** agrega o cluster (taxa, throughput, no-reads) numa linha; é a leitura "de relance".
- **Drill-in (console):** anel de taxa + **fluxo de códigos ao vivo** + **contribuição por câmera** (barras) + no-reads recentes. ROI desenhado sutil sobre o feed.
- **Relatório leitura:** mesmos princípios (topo fixo + abas; só a tabela rola).
- **Performance:** decode throttled + ROI; leitura **não** roda coco-ssd; ZXing por **import dinâmico** (não entra no bundle de atividade); dedup evita reprocessar; UI atualiza em throttle (já é o padrão).

---

## 6. Compatibilidade / retrocompatibilidade
- `modo` default = `atividade` → câmeras existentes e todo o fluxo atual **inalterados**.
- `store` ganha stores novos (upgrade não destrói os de atividade).
- Hub, `/camera`, shell e rotas **não mudam** → risco baixo, mudança isolada no caminho de leitura.

---

## 7. Riscos / atenção
- **Suporte a `BarcodeDetector`** varia por navegador → fallback ZXing obrigatório (lazy).
- **Resolução do frame:** o `net.frameWidth` atual (480) pode ser baixo para ler códigos pequenos → permitir frame maior **por câmera de leitura** (config) ou ROI em maior resolução. *(ponto a validar)*
- **Custo de N câmeras decodificando** no mesmo navegador (central) → throttle + ROI; medir. Em produção, decode poderia migrar p/ a borda (nó) — fica como evolução (alinha com task #28 edge/nuvem).
- **No-read** depende de detectar "passou caixa" — começar simples (taxa/throughput) e refinar.

---

## 8. Ordem sugerida
**F0 → F1** primeiro (modelo de modo + leitura ao vivo na central por ponto) — valida com webcam lendo código impresso, sem hardware. Depois **F2** (relatório), **F3** (no-read/alertas), **F4** (acabamento). Mantém a UI no mesmo padrão (tokens, sem scroll, abas) e o modo Atividade intacto.
