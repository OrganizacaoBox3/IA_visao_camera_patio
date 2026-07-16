# ADR-018 — Separação de domínios: o BLE sai do repo de visão

> Data: 2026-07-16 · Status: aceito · Decisor: dono do produto ("misturamos os dois em diversos
> pontos; quero voltar atrás dessa interação por enquanto").
> Fonte da verdade da mudança: `docs/analises/separacao-dominios/spec-separacao-dominios.md`
> (+ `inventario.md` e `lista-de-corte.md`, com call-sites verificados arquivo:linha).

## Contexto

O MVP acumulou DOIS produtos num repo só: **visão computacional** (câmeras: detecção/rastreio
24/7, alarmes, relatórios, calibração de distância) e **localização BLE** (tags/estações/
fingerprint/planta 2D/mapa AirTag + o app Android da estação). A fusão câmera+BLE (rótulo de tag
na pessoa, anéis de distância, vista 2D, aba "Por quê", gravador de sessão) ligava os dois.

A doutrina da casa (contratos aditivos, pastas por domínio) concentrou o acoplamento em POUCOS
pontos: **um tipo** (`BtReading` em `src/api.ts`), **um evento de socket** (`bt-readings`,
emitido só por `server/routes/bt-station.js`) e **uma prop** (`getReadings`, injetada do
DashboardPage para baixo). O motor de análise tinha UM gancho câmera→BLE
(`analysis/pipeline.js` → `bt/session-recorder`); o servidor BLE não conhecia a câmera.

## Decisão

1. **Dois repositórios.** Este repo (`visao_computacional_mvp`) vira a app de **visão pura**;
   TODO o BLE e TODA a fusão migram para `C:\...\mvp_trilateracao_BLE` (clone com histórico
   completo, porta default 4001 para coexistir na mesma máquina).
2. **Preservação, não perda.** O estado fundido está no commit `6a2f1ca` de AMBOS os históricos
   e na tag **`pre-separacao-2026-07-16`** criada NOS DOIS repos. Reativar a interação no futuro
   = **reverter esta série de commits (ou cherry-pick da tag)** — nunca reescrever. A fusão, se
   voltar, volta por PR dedicado contra os dois contratos da época, não por cópia manual.
3. **O que saiu daqui** (Onda 2, lista-de-corte Parte A): 5 rotas/telas BLE + menu; `src/fusion`,
   `src/planta`, `src/spatial` (seam), `src/routes/ble`, `src/localizacao`, Vista 2D/Mapa 2D/
   aba "Por quê"; superfície `/api/bt*`+floorplan+fingerprints do `api.ts`; `server/bt/*` e
   `server/routes/bt-*`; passos BLE da calibração (âncoras/estação/tag de referência); tabelas
   `bt_*` do `schema.sql` (só param de ser criadas — **sem DROP**); deps `leaflet`; scripts
   `family`/`funnel`; `tc22-scanner/` (o app da estação mora no repo BLE).
4. **O que FICOU** (fallbacks conscientes):
   - o rótulo da pessoa volta ao genérico **"Pessoa"** — `personLabel(undefined, id)`; o
     invariante "a caixa da pessoa nunca exibe número" e seus gates
     (`drawTracks.test.ts`/`personLabel.test.ts`) permanecem;
   - a **calibração de DISTÂNCIA inteira** (4 cantos + L×C + homografia + grade de conferência +
     medir) — medir é da câmera; `calibrationRev` agora refresca a malha da câmera
     (`useCalibrationOverlay`), preservando o sync ao vivo ADR-006;
   - o motor poligonal voltou de `src/spatial` para `src/camera/usePolygonEditorCore.ts` e o
     `pointInPolygon` de `fusion/floor-polygon` para `src/zones.ts` (espelho do hub intacto em
     `server/analysis/zones.js`; fixtures compartilhadas CA-4 intactas);
   - home `/` → `<Navigate to="/monitoramento" replace />` (a Central é a home; url canônica única).

## Contratos alterados (o motivo de este ADR existir)

- **O evento de socket `bt-readings` DEIXA DE EXISTIR na visão** — morreu na origem (o emissor
  `server/routes/bt-station.js` saiu). Nenhum consumidor externo conhecido além do próprio front.
  A lista de contratos do CLAUDE.md §3 foi atualizada no mesmo PR.
- **Os endpoints `/api/bt/*`, `/api/bt-tags`, `/api/bt-stations`, `/api/floorplan` e
  `/api/fingerprints` saem do hub** (404). O invariante do `BT_STATION_TOKEN` migra junto (vale
  no repo BLE). `single-hub.test.js` (gate do ingest BLE) morre com a feature.
- **`CameraCalibration` perde os campos BLE** (`mac` por vértice, `station`, `stations`,
  `refTag`). A allowlist do hub (`camcfg.cleanCalibration`) é ADITIVA: payload antigo com esses
  campos segue VÁLIDO — eles só deixam de ser persistidos (round-trip pinado em
  `camcfg.test.js`).
- **Schema aditivo respeitado**: as tabelas `bt_*` existentes em instalações reais NÃO são
  dropadas — ficam dormentes; o repo BLE é o novo dono delas (com banco próprio ou
  JSON-fallback; nunca o MESMO Postgres nas duas apps — risco 3 da spec).

## Consequências

- **+ Simplicidade real**: ~28k linhas a menos; o hub não paga init/persistência BLE; a Central
  abre sem nenhum vestígio do outro domínio; cada repo tem UM produto.
- **− Custo assumido**: manutenção dupla da base compartilhada (auth/UI kit/persistência) —
  mitigada por commits pequenos e cherry-pickáveis (mesma história git); horizonte declarado
  "por enquanto".
- **Gravações de campo (invariante append-only)**: os `server/bt/fusion-session*.jsonl` (81
  arquivos) **continuam no disco** deste repo (nunca foram rastreados) e têm cópias em
  `gravacoes-campo-ble/` e no repo BLE. A remoção local só após conferência de hash/contagem
  (incidente 2026-07-10) — fora do escopo desta onda.
- **Critério de retorno da fusão**: se o híbrido câmera+BLE voltar (norte jul/15 — câmera dá
  X,Y; BLE dá identidade/zona), a reintegração se faz por PR dedicado revertendo esta série (ou
  repo/pacote de fusão próprio consumindo os DOIS contratos) — decisão nova, com ADR novo.
