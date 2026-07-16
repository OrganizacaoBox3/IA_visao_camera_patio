RELATÓRIO — LISTA DE CORTE câmera↔BLE (call-sites vivos verificados por grep, arquivo:linha)

═══════════════════════════════════════
PARTE A — REMOVER O BLE DA APP DE VISÃO (sem quebrar o build)
═══════════════════════════════════════

A ponte inteira entre os domínios passa por UM tipo (`BtReading` em api.ts), UM evento de socket (`bt-readings`, emitido em `server/routes/bt-station.js:75` — não em sockets/dashboard.js, que está limpo), e UMA prop (`getReadings`) injetada de DashboardPage para baixo. Cortando esses três, o resto cai por gravidade.

**1. Rotas — `src/main.tsx`**
- :11-14 — remover imports `BlePage`, `TagsMapPage`, `PlantaBlePage`, `ReplayPlayerPage` (a bancada /replay é 100% fusão: importa `fusion/replay-fusion`, `fusion/sim`, `fusion/session-loader`, `fusion/player/*` — ReplayPlayerPage.tsx:24-56).
- :36 — home `/` é `TagsMapPage` (mapa BLE). Fallback: home vira `<DashboardPage />` ou `<Navigate to="/monitoramento" replace />`.
- :48 (`/tags-ble`), :50 (alias `/mapa`), :56 (`/planta-ble`), :63 (redirect `/estacoes`), :65 (`/replay`) — remover as 5 rotas.

**2. Menu — `src/components/AppShell.tsx`**
- :233 — item "Mapa" (home BLE): remover ou reapontar à nova home.
- :244 — item "BLE" (`/tags-ble`): remover.
- :247 — item "Planta" (`/planta-ble`): remover. Remover junto os ícones `Bluetooth`, `Map`, `MapPin` do import de lucide.

**3. Superfície de API — `src/api.ts`**
- :342-358 — tipo `BtReading` + `getBtReadings` + `getBtReadingsAll`: remover (é O tipo-ponte; importado por CameraWorkspace.tsx:33, CameraTile.tsx:4, useDashboardSocket, camera/useBleReadings.ts:14).
- :366-375 — `TagLocation` + `getBtLocations`: remover.
- :380-393 — `BtTag` + CRUD `/api/bt-tags`: remover.
- :402-417 — `BtStation` + CRUD `/api/bt-stations`: remover.
- :420-454 — `FloorplanConfig` (`/api/floorplan`) + `Fingerprint` (`/api/fingerprints`, importa de `fusion/fingerprint` na :453-454): remover.
- :303-327 — no tipo `CameraCalibration`, remover os campos BLE `mac` (âncora por canto), `station` (:325), `stations` (:326), `refTag` (:327). O H/L×C/points FICAM (calibração de distância é feature de câmera). O contrato do hub é aditivo — remover do cliente não quebra nada.

**4. Socket — `src/routes/dashboard/useDashboardSocket.ts`**
- :14 — remover import `mergeSourceBatch`/`source-pool`.
- :82-86 — remover `btReadingsRef`/`btSourcesRef`.
- :164-167 — remover o handler `socket.on("bt-readings", …)`.
- :249, :48, :258 — remover `getBtReadings` (callback, tipo e retorno).
- MANTER :196 e `calibrationRevByCamera` (re-busca do H é da câmera).

**5. `src/routes/DashboardPage.tsx`**
- :287 e :333 — remover a prop `getReadings={socket.getBtReadings}` (tile e fullscreen). É o único ponto de injeção.

**6. `src/CameraWorkspace.tsx` (fullscreen)**
- :33 — tirar `type BtReading` do import; :34-35 — remover `useCameraTagLabels`/`useFloorTags`; :70 — `drawFloorTags`; :78 — `Vista2DStage`; :89 — `useFunnelDiagnosis`.
- :150 e :176 — remover a prop `getReadings`.
- :348-358 — remover `useCameraTagLabels`. **Fallback do rótulo:** `drawTracks` passa a receber `labelFor` undefined e `personLabel(undefined, id)` já devolve o genérico "Pessoa" (`src/camera/draw.ts:269-273`) — os gates `drawTracks.test.ts`/`personLabel.test.ts` FICAM.
- :363-371 — remover `useFunnelDiagnosis` (aba "Por quê" morre junto).
- :379-392 — remover `useFloorTags` + estado `floorOn`/`floorOnRef`/`setFloorOn`.
- :1260-1266 — remover o bloco de anéis (`drawFloorTags`) do drawScene.
- :1566 — remover a prop `floor={…}` passada ao ExibicaoPopover.
- :295, :1538-1539, :1675 — remover `mapaOpen`, props `mapaOpen`/`onToggleMapa` e o render de `<Vista2DStage>`.
- Ajustar o ratchet `src/CameraWorkspace.size.test.ts` (:66 documenta essa fiação).

**7. Painel/abas**
- `src/camera/CamDrawer.tsx` — :25 import `Vista2DTab`; :35 tipo `DrawerTab` perde `"porque" | "vista2d"`; :105-108 itens de aba; :116-126 os dois `TabsContent` (+ import do `PorQueTab`): remover.
- `src/camera/CamHeader.tsx` — :73-75 props `mapaOpen`/onToggle; :280-286 o Toggle "Mapa 2D": remover.
- `src/camera/ExibicaoPopover.tsx` — :40 prop `floor`; :84; :129-137 bloco "Anéis das antenas": remover (ajustar `ExibicaoPopover.test.tsx`).
- `src/camera/draw.ts` — :33 import type `FloorTagsView`; :597+ `drawFloorTags` (e o desenho de âncora/MAC da camada de calibração em :543-548): remover. **MANTER** `personLabel` (:269) e o parâmetro opcional `labelFor` de `drawTracks` (:284) — são o fallback e o gate do invariante "a caixa nunca exibe número".

**8. Editor de calibração (mantém cantos + medir; perde os 3 passos BLE)**
- `src/camera/useCalibrationEditor.ts` — :35-38 imports (`useStationHealth`, `useStationNames`, `station-geometry`, `useBleReadings`); :40-45 `station-points`; :48 e :119-128 estados `cornerMacs`/`anchorCorner`/`pts`/`selStation`/`refTag`; :150-156 leituras vivas; :167-175 adoção de `station`/`stations`/`refTag`/`mac` da calibração salva; :276-337 (distância de referência, `liveStationIds`, `stationMarks`, `geometryHints`, transições de estação, `useStationHealth`); :375-427 hit-test/drag de station/reftag/âncora; :459 undo do `cornerMacs`. O save deixa de enviar `station`/`stations`/`refTag`/`mac`.
- `src/camera/tabs/CalibracaoTab.tsx` — :15-17 imports (`StationHealthChip`, `TagPicker`, `takenTags`); :34-37 lista de passos (ficam só "Cantos" e o medir L×C); :161-171 textos por passo; :186-238 painel "Estação"; :240-265 painel "Tag ref." (chips de saúde :247-257); :267-305 painel "Âncoras": remover.
- `src/camera/CalibrationLayer.tsx` — remover as marcas de estação/refTag/âncora (props vindas do editor).
- DELETAR: `src/camera/TagPicker.tsx`, `src/camera/takenTags.ts(+.test.ts)`, `src/camera/station-points.ts(+.test.ts)`, `src/camera/useBleReadings.ts`.
- `e2e/calibracao.spec.ts` NÃO muda (verificado: só exercita cantos/medir/grade).

**9. Grade — `src/routes/dashboard/CameraTile.tsx` e `TrackOverlay.tsx`**
- CameraTile.tsx — :4-6 imports; :62-63 e :259-260 prop `getReadings`; :157-172 `useCameraTagLabels`+`labelFor`; :175-183 `useFloorTags`+`getFloorTags`; :192-193 props ao overlay: remover.
- TrackOverlay.tsx — :4 tirar `drawFloorTags` do import (manter `personLabel`); :6 import `FloorTagsView`; :27-30 props `labelFor`/`getFloorTags`; :86-87 desenho do chão; :111 vira `personLabel(undefined, t.id)` (→ "Pessoa"); :131 deps.

**10. Deleções em bloco (front)**
- `src/fusion/` INTEIRO (verificado por glob: associate, frame, distance, labelMemory, useTagFusion, useCameraTagLabels, useFloorTags, floor-plot, floor-polygon, useFunnelDiagnosis, stationHealth*, useStationNames, StationHealthChip, station-geometry, source-pool, sim, replay-fusion, session-loader, player/*, world-spec, families, identity-metrics, shuffle-baseline, topdown, fingerprint, floorplan, continuous-position, motion-filter, work-area, zone-presence, localization-eval + todos os .test) — nada ali serve à câmera pura.
- `src/planta/`, `src/spatial/`, `src/routes/ble/`, `src/routes/TagsMapPage.tsx`, `src/routes/PlantaBlePage.tsx`, `src/routes/ReplayPlayerPage.tsx`.
- Vista 2D (BLE-only dentro de src/camera): `src/camera/Vista2DStage.tsx`, `src/camera/tabs/Vista2DTab.tsx` (importa useTopdownView/TopdownCanvas — Vista2DTab.tsx:8-9), `src/camera/TopdownCanvas.tsx`, `src/camera/useTopdownView.ts` (usa useBleReadings/useStationNames — :7-8, :42-43), `src/camera/drawTopdown.ts`, `src/camera/tabs/PorQueTab.tsx(+.test.tsx)`.
- `src/config.ts` :171-185 — remover `overlay.floorTagsOn`; deletar `src/config.overlay.test.ts` (gate desse default).
- `src/index.css` — remover as seções das telas BLE (planta/mapa/floor). O `.np-tag` de NotificacoesTab NÃO é BLE (verificado — falso positivo da classificação; UsersPage/NotificacoesTab não têm acoplamento).

**11. Server**
- `server/index.js` — :14-18 e :26 requires (`bt-tags`, `stations`, `floorplan`, `fingerprints`, `bt-locations`, `discovery`); :36-38 requires de rotas bt; :115-117 dispatch das 3 rotas; :258-262 inits; :275-278 persistence (`bt-tags`, `bt-stations`, `floorplan`, `fingerprints`); :304-312 warn do `BT_STATION_TOKEN`; :325 `discovery.start`: remover tudo.
- DELETAR `server/bt/` (bt-readings, bt-tags, stations, floorplan, fingerprints, bt-locations, discovery, recorder, session-recorder + tests) e `server/routes/bt-station.js`, `bt-stations.js`, `bt-tags.js` (+tests). O emit `bt-readings` morre na origem (`server/routes/bt-station.js:75`) — remoção de evento de contrato: registrar em ADR.
- `server/routes/config-routes.js` — :7 e :10 requires; :119-152 bloco `/api/floorplan` (+ emit `floorplan-updated` :146); :155-198 bloco `/api/fingerprints` (+ emit :178, :198): remover. Na allowlist de calibração, os campos `station`/`stations`/`refTag`/`mac` podem simplesmente sair (aditivo).
- `server/analysis/pipeline.js` — :39 require `../bt/session-recorder` e :163 `sessionRecorder.recordTracks(...)`: remover — é o ÚNICO gancho câmera→BLE dentro do motor de análise.
- `server/schema.sql` — :107 `bt_tags`, :120 `bt_stations` (+ alters :133-134), :141 `bt_floorplan`, :152 `bt_fingerprints`, :159 `bt_tag_locations`: parar de criar (remover os blocos). NÃO fazer DROP automático em instalações existentes.
- `server/sockets/dashboard.js` e `server/control-plane-forwarder.js` — verificados: ZERO referência bt. Nada a fazer.
- `server/bt/fusion-session*.jsonl` — INVARIANTE CLAUDE.md: artefato de campo imutável/append-only. Não deletar no corte; arquivar fora do diretório de runtime.

**12. E2E**
- DELETAR `e2e/ble.spec.ts` e `e2e/planta-ble.spec.ts`.
- `e2e/a11y.spec.ts` — :34-35 (gate `tags-ble`/`planta-ble`), :45 (home = "Mapa de tags" → nova home), :136 (região "Mapa das tags"), :151-166 (testes `/tags-ble` e `/planta-ble`), :173-174 (replay): remover/ajustar.
- `e2e/app.spec.ts` — :12 (home) e :197-226 (teste da aba "Por quê"): remover/ajustar.
- `e2e/mobile.spec.ts` — :9 e :26 (home "Mapa de tags"): reapontar.

**Fallbacks que FICAM (resumo):** rótulo da pessoa = "Pessoa" via `personLabel(undefined,…)` (draw.ts:269-273, gates drawTracks.test/personLabel.test intactos); calibração de distância (H, L×C, grade de 1 m, medir) fica inteira; `calibrationRevByCamera` fica; home vira a Central.

═══════════════════════════════════════
PARTE B — CAMINHO INVERSO (app SÓ-BLE remove a câmera) — alto nível
═══════════════════════════════════════

- `src/main.tsx` — remover rotas `/monitoramento` (:39), `/cameras` (:41), `/relatorio` (:44, alarmes são de câmera), `/camera` (:73, nó de webcam) e o redirect `/calibracao` (:61). Mantém `/` (TagsMapPage), `/tags-ble`, `/planta-ble`, `/turnos`, `/replay`, `/usuarios`, `/perfil`.
- `src/components/AppShell.tsx` — remover itens "Central" (:237), "Câmeras" (:240), "Relatório" (:250).
- Front em bloco: `src/CameraWorkspace.tsx`, `src/camera/**`, `src/routes/dashboard/**`, `src/routes/DashboardPage/CamerasPage/CameraPage/ReportPage`, `FadigaView`, `zones.ts`, processadores/cameraConfig/report. **ATENÇÃO a 3 resgates antes de deletar `src/camera/`:** `useBleReadings.ts` (usado por `src/planta/useFingerprints.ts:15` e `useFloorplanMap.ts:15`), `TagPicker.tsx` e `takenTags.ts` são BLE morando em pasta de câmera — mover para `src/ble/` ou `src/fusion/`. `useStationNames`/`stationHealth`/`StationHealthChip` (src/fusion) são consumidos por `src/routes/ble/TagsTab.tsx:16,50` — ficam.
- `src/api.ts` — remover a superfície de câmeras/camcfg/alarmes/análise; manter `/api/bt*`, `/api/floorplan`, `/api/fingerprints`. Do socket, o cliente BLE só precisa de `bt-readings`, `floorplan-updated`, `fingerprints-updated` (ou polling HTTP, como a Planta já faz).
- Server: remover `server/analysis/**` (o gancho `session-recorder` de pipeline.js:39/:163 morre junto — o gravador perde o chamador de tracks mas segue útil para leituras BLE), `go2rtc.js` + proxy (index.js:95-99, :144-148), `rtsp.js`, `sockets/camera.js`, o relé de frames + `analysisTee` (index.js:157-170), `camcfg`, rotas de alarms/analysis, shed de fps. Mantém: auth/RBAC, `server/bt/**`, `routes/bt-*`, floorplan/fingerprints em config-routes, WhatsApp/notificações se desejado.
- `server/schema.sql` — mantém `bt_*`; remove tabelas de câmera/alarme.
- E2E: mantém a11y de `/`, `/tags-ble`, `/planta-ble`; remove `calibracao.spec.ts` e os testes de Central/câmera em `app.spec.ts`/`mobile.spec.ts`.

Risco residual declarado: a remoção do evento `bt-readings` (corte A) e do relé `frame` (corte B) toca a lista de contratos socket do CLAUDE.md §3 — ambas exigem ADR curto no mesmo PR.