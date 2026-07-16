# Inventário por arquivo — separação de domínios (gerado 2026-07-16)

## server.txt
```
MISTO  server/index.js  — Visão remove: requires BLE l.14-18/26/36-38, dispatch rotas bt l.115-117, inits bt l.258-263, persistence-health bt l.275-279, warn BT_STATION_TOKEN l.304-314, discovery.start l.325. BLE remove: requires rtsp/go2rtc/cameras/alerts/whatsapp/recipients/analysis/shed l.5-9,12-13,21,25,28, rotas de câmera/alarme/notif l.33-35,41-43, sockets l.47-48, proxy go2rtc l.95-100/144-149, analysisTee l.151-170, gate CAMERA_TOKEN l.174-187, Maps de câmera+shed l.189-242, io.on connection l.243-246, camcfg.init l.257, cameraStore/analysis/rtsp/go2rtc init l.315-320/344-369, logs andon/whatsapp l.326-336.
MISTO  server/schema.sql  — BASE: users, app_settings, shifts. VISÃO: ativ_buckets/ativ_events, read_buckets/read_events, obj_buckets/obj_events, flow_buckets/flow_events, fad_buckets/fad_events, recipients, alarm_events, app_views, cam_tripwires, cam_zones, cam_config, cam_calibration (campos station/stations/refTag do blob são fusão), todos os índices dessas tabelas e os ALTERs de carimbo de turno (l.253-262). BLE: bt_tags, bt_stations + ALTERs l.133-134, bt_floorplan, bt_fingerprints, bt_tag_locations.
BASE   server/http-auth.js
BASE   server/users.js
BASE   server/users.persist.test.js
BASE   server/users.security.test.js
BASE   server/db.js
BASE   server/persistence-health.js  — Genérico (summarize puro); cada app registra só os stores do seu domínio na chamada do index.js.
BASE   server/persistence-health.test.js
BASE   server/loginThrottle.js
BASE   server/loginThrottle.test.js
BASE   server/shifts.js  — Hoje só a visão consome (carimbo do pgstore/alarm), mas a spec-zona-trabalho-ble §6/P2 planeja usar shifts.js/shift-clock.js no corte por turno da app BLE.
BASE   server/shifts.test.js
BASE   server/shift-clock.js  — Resolução pura de turno — mesma razão do shifts.js (spec-zona-trabalho-ble P2).
BASE   server/shift-clock.test.js
BASE   server/control-plane-link.js  — Canal de sinalização genérico (echo/ping); o relay de vídeo é tijolo futuro e ainda não está aqui.
BASE   server/control-plane-link.test.js
MISTO  server/control-plane-forwarder.js  — Ambas mantêm registro+heartbeat (l.88+); na app BLE remover forwardAlarm (l.72-87) e seu export — o único consumidor é alarm/pipeline.js (visão). Visão fica intacto.
MISTO  server/control-plane-forwarder.test.js  — Na app BLE remover os casos de forwardAlarm; manter os de heartbeat/enabled.
MISTO  server/package.json  — pg+socket.io são base; na app BLE podar baileys, qrcode, pino (WhatsApp) e onnxruntime-node, sharp (análise). Visão mantém tudo.
MISTO  server/package-lock.json  — Regenerar em cada app após a poda de deps do package.json.
VISAO  server/pgstore.js  — Não é persistência genérica: é o histórico de indicadores de CÂMERA (ativ/read/obj/flow/fad) + carimbo de turno no ingest; genérico é o db.js.
VISAO  server/pgstore.test.js
VISAO  server/pgstore.fallback.test.js
VISAO  server/pgstore.stamp.test.js
VISAO  server/camcfg.js  — Trechos de fusão no blob de calibração: campos station/stations/refTag/mac em cleanCalibration (l.253-299) são âncoras BLE-na-câmera — remover ao desativar a fusão; a homografia points+H fica (feature 'medir' da câmera).
VISAO  server/camcfg.test.js
VISAO  server/cameras.js
VISAO  server/rtsp.js
VISAO  server/go2rtc.js
VISAO  server/go2rtc.test.js
VISAO  server/video-ticket.js
VISAO  server/video-ticket.test.js
VISAO  server/shed.js
VISAO  server/shed.test.js
VISAO  server/alarmPolicy.js
VISAO  server/alarmPolicy.test.js
VISAO  server/alarm/**  — Pipeline de alarme inteiro (classify/flood/flap/shelve/shift/pipeline) — só a cadeia câmera→alert consome.
VISAO  server/events.js  — Store da fila de EVENTOS DE ALARME (câmera), não event-sourcing genérico.
VISAO  server/events.persist.test.js
VISAO  server/alerts.js
VISAO  server/dispatch.js
VISAO  server/whatsapp.js  — Adaptador de canal genérico, mas o único consumidor é a cadeia de alarme (dispatch/routes-notif) — promover a base só se a app BLE ganhar notificações.
VISAO  server/recipients.js  — Destinatários da notificação de alarme; segue a pilha de notificação (visão).
VISAO  server/recipients.test.js
VISAO  server/settings.js  — Apesar do nome, é config de NOTIFICAÇÕES de alerta de câmera (tipos fadiga etc.), consumida só por dispatch/routes-notif.
BASE   server/routes/auth.js
BASE   server/routes/users.js
BASE   server/routes/shifts.js
VISAO  server/routes/data.js
VISAO  server/routes/alarms.js
VISAO  server/routes/notif.js
VISAO  server/routes/cameras.js
VISAO  server/routes/analysis.js
MISTO  server/routes/config-routes.js  — Visão remove floorplan/fingerprints: requires l.7/10 e handlers l.119-199 (+ emits floorplan-updated/fingerprints-updated — sem listener no front, morto). BLE remove tripwires/zones/camconfig/calibration: l.18-117 (dependem do camcfg, que fica só na visão).
BLE    server/routes/bt-tags.js
BLE    server/routes/bt-stations.js
BLE    server/routes/bt-stations.test.js
BLE    server/routes/bt-station.js  — Contém trecho de fusão a remover: require de bt/session-recorder (l.9) e recordReadings (l.82).
BLE    server/routes/bt-station.test.js
VISAO  server/sockets/camera.js
VISAO  server/sockets/camera.test.js
VISAO  server/sockets/dashboard.js  — Watch/foco/alert são todos de câmera; o front BLE usa polling HTTP (ADR-016), nenhum evento socket.
VISAO  server/sockets/dashboard.test.js
VISAO  server/analysis/**  — Homogêneo (motor D-FINE, tracker, contagem) EXCETO trecho de fusão em pipeline.js: require bt/session-recorder (l.39) e recordTracks (l.163) — remover ao desativar a fusão.
VISAO  server/models/**  — Pesos ONNX do D-FINE (n/s/m) — só o motor de análise.
BLE    server/single-hub.test.js  — Gate do ingest BLE no hub único (cita tc22-scanner); vai p/ app BLE — a âncora routeData.handle (l.36) precisa trocar por rota existente na app BLE.
BLE    server/bt/bt-readings.js
BLE    server/bt/bt-readings.test.js
BLE    server/bt/bt-tags.js
BLE    server/bt/bt-tags.test.js
BLE    server/bt/bt-locations.js
BLE    server/bt/bt-locations.test.js
BLE    server/bt/stations.js
BLE    server/bt/stations.test.js
BLE    server/bt/floorplan.js
BLE    server/bt/floorplan.test.js
BLE    server/bt/fingerprints.js
BLE    server/bt/fingerprints.test.js
BLE    server/bt/discovery.js
BLE    server/bt/discovery.test.js
BLE    server/bt/recorder.js  — Recorder BLE puro (relatórios com lat/lon) — distinto do session-recorder (fusão); grava bt-recording.jsonl.
FUSAO  server/bt/session-recorder.js  — Grava o par câmera+BLE (tracks+leituras+calibração) p/ replay; consumidores: analysis/pipeline.js l.163 e routes/bt-station.js l.82.
FUSAO  server/bt/fusion-session*.jsonl  — DADO DE CAMPO IMUTÁVEL (invariante CLAUDE.md §3: append-only, deleção proibida — inclui os .bak). Preservar via histórico git/cópia; jamais apagar na separação.
BLE    server/bt/bt-recording.jsonl  — Dado de campo do recorder BLE — mesma invariante append-only: não deletar, vai junto da app BLE.
BLE    server/bt/*.json  — Runtime/gitignored do domínio BT (bt-locations, fingerprints, floorplan, stations); regenerados no boot da app BLE.
MISTO  server/*.json  — Runtime/gitignored: users.json (base) vai p/ ambas; cameras.json, camcfg.json, alarms.json, data-hist.json, rtsp.sources.json (visão) ficam só na visão; todos regeneráveis em runtime.
VISAO  server/rtsp.sources.example.json
VISAO  server/rtsp.sources.extra.example.json
VISAO  server/wa-auth/**  — Sessão WhatsApp (segredo de runtime, gitignored) — segue a pilha de notificação; nunca versionar/copiar entre apps.```

## src-core.txt
```
MISTO  src/main.tsx  — Sai da app BLE: rotas/imports de câmera — DashboardPage /monitoramento (l.4,39), CamerasPage /cameras (l.5,41), CameraPage /camera fora do shell (l.6,73), ReportPage /relatorio (l.7,44), redirects /calibracao e /alarmes-saude (l.61-62). Sai da app de visão: BlePage /tags-ble (l.11,48), TagsMapPage em '/' e /mapa (l.12,36,50), PlantaBlePage /planta-ble (l.13,56), redirect /estacoes (l.63); na visão '/' precisa de nova home (ex.: DashboardPage). ReplayPlayerPage /replay (l.14,65) é bancada da FUSÃO — sai dos dois lados. TurnosPage (l.10,53) serve à política de alarme de câmera: fica na visão, avaliar na BLE.
MISTO  src/api.ts  — Fica nos dois (base): núcleo token/headers/ApiError/parse/request/apiGet/apiSend/apiPut (l.1-89,255-263), getDataStatus (l.91-96), Papel (l.98-101), /api/me (l.103-116), users (l.118-135), WhatsApp/notif/recipients (l.137-174). Sai da app BLE (câmera): alarms+metrics+shelves e re-export de types/alarm (l.176-249), tripwires (l.265-273), zones+camconfig e re-exports de zones.ts/cameraConfig.ts (l.275-300), shifts (l.464-497 — consumidores: ConfigZonaDialog/ReportPage/TurnosPage), Camera CRUD+isValidCameraUrl+maskCameraUrl+getConnectedCameras (l.499-561), getCameraEnroll (l.135). Sai da app de visão (BLE): getBtReadingsAll (l.356-358), TagLocation+getBtLocations (l.360-375), BtTag CRUD (l.377-393), BtStation CRUD (l.395-417), Floorplan/FloorplanWorkArea+get/saveFloorplan (l.419-446), Fingerprint (importa src/fusion/fingerprint)+get/save/deleteFingerprint (l.448-462). FUSÃO (sai da visão; sem uso na BLE): CalibrationPoint/CameraCalibration+get/saveCalibration com station/stations/refTag, importa vision/homography (l.302-335); BtReading+getBtReadings (l.337-354) fica na BLE (TagsTab/planta consomem) e sai da visão (lá só a fusão consumia — camera/useBleReadings, fusion/useStationHealth, DashboardPage).
BASE   src/auth.tsx  — Login/RBAC puro; só a marca 'Visão de Pátio' + ícone Cctv no card de login (l.141-143) precisam rebatismo na app BLE.
MISTO  src/config.ts  — Fica nos dois: env() (l.10-13) e net.serverUrl (l.298-304 — resolução do hub, consumida por api.ts/auth). Sai da app BLE: todo o resto — detection (l.16-67), people/track (l.69-158), zones (l.161-166), overlay (l.168-186), dashboard (l.189-192), audio/timeline/metrics (l.194-207), reading (l.209-248), objects (l.250-256), fadiga (l.258-288), net.frameWidth/frameFps/jpegQuality (l.315-317), go2rtc (l.326-328), webcam/whip (l.330-357), OverlayLayers/ModeKey/MODE_PRESETS (l.363-439). Sai da app de visão (fusão): overlay.floorTagsOn (l.170-175,185) — default dos anéis das antenas BLE sobre o vídeo.
VISAO  src/telemetry.ts  — FrameMeter (FPS/latência de loop de frames); consumidores só CameraWorkspace e FadigaView.
VISAO  src/frame.ts  — FrameSource/NormRect do pipeline de vídeo; também importado pelo pacote fusion (que sai junto).
VISAO  src/format.ts  — Helpers genéricos, mas todos os consumidores são camera/* e processors/*.
MISTO  src/index.css  — Fica nos dois: tokens :root (--state-*/--sp-*/tipografia), foco global a11y, header/layout/toolbar/side-panel, login, rtable. Sai da app BLE: seções de câmera — Central de câmeras (l.566), Câmera aberta/full (l.666), Nó de câmera (l.692), Relatório operacional (l.762-1149), .cam-stage (l.1611-1625), Modo LEITURA (l.1952), CameraWorkspace/zonas (l.2244), Modo OBJETOS (l.2310), Card de zona (l.2408), Modo FADIGA (l.2549+). Não há seção BLE aqui (estilos da planta vivem em src/planta): a visão mantém o arquivo inteiro.
BASE   src/tailwind.css
VISAO  src/zoneMask.ts
VISAO  src/zones.ts  — Zonas de ROI da câmera; atenção: importa pointInPolygon de src/fusion/floor-polygon (l.11) — helper geométrico puro que precisa sair do pacote fusão na app de visão.
VISAO  src/zones.test.ts
VISAO  src/zones-polygon-fixtures.json  — Fixture consumida por zones.ts/zones.test.ts.
VISAO  src/cameraConfig.ts
VISAO  src/cameraConfig.test.ts
VISAO  src/CameraWorkspace.tsx  — Contém fiação de FUSÃO a desativar na app de visão: imports fusion/useCameraTagLabels, useFloorTags, useFunnelDiagnosis (l.33-35,89), prop getReadings (l.148-150), hooks tagLabels/funil/floorTags+estado floorOn (l.332-398), drawFloorTags no drawScene (l.1260-1267), toggle floor no CamKpiBar (l.1566), calibração de âncoras/estação BLE (useCalibrationOverlay/Editor/CalibrationLayer l.36-38) e Vista2DStage (l.78).
VISAO  src/CameraWorkspace.size.test.ts
VISAO  src/api.cameras.test.ts  — Testa só isValidCameraUrl/maskCameraUrl (o lado câmera do api.ts misto).
FUSAO  src/config.overlay.test.ts  — Gate do default overlay.floorTagsOn=false (anéis das antenas BLE sobre o vídeo) — sai junto com o knob da fusão.
BASE   src/design-tokens.test.ts  — Testa os tokens de cor de index.css, que ficam nos dois lados.
BASE   src/ui/AlertDialog.tsx
BASE   src/ui/Button.tsx
BASE   src/ui/Card.tsx
BASE   src/ui/Card.test.tsx
BASE   src/ui/clipboard.ts
BASE   src/ui/controls.tsx
BASE   src/ui/cx.ts
BASE   src/ui/Dialog.tsx
BASE   src/ui/DropdownMenu.tsx
BASE   src/ui/form.tsx
BASE   src/ui/form.test.tsx
BASE   src/ui/HelpTip.tsx
BASE   src/ui/index.ts
BASE   src/ui/InlineEdit.tsx
BASE   src/ui/InlineEdit.test.tsx
BASE   src/ui/Kpi.tsx
BASE   src/ui/Kpi.test.tsx
BASE   src/ui/Loading.tsx
BASE   src/ui/Loading.test.tsx
BASE   src/ui/Meter.tsx
BASE   src/ui/Meter.test.tsx
BASE   src/ui/misc.tsx
BASE   src/ui/PageHeader.tsx
BASE   src/ui/PageHeader.test.tsx
BASE   src/ui/Panel.tsx
BASE   src/ui/Panel.test.tsx
BASE   src/ui/Popover.tsx
BASE   src/ui/ScrollArea.tsx
BASE   src/ui/SectionTitle.tsx
BASE   src/ui/SegmentedControl.tsx
BASE   src/ui/Select.tsx
BASE   src/ui/StatusDot.tsx
BASE   src/ui/StatusDot.test.tsx
BASE   src/ui/Table.tsx
BASE   src/ui/Table.test.tsx
BASE   src/ui/Tabs.tsx
BASE   src/ui/Toast.tsx
BASE   src/ui/Toggle.tsx
BASE   src/ui/ToggleRow.tsx
BASE   src/ui/Tooltip.tsx
BASE   src/ui/ui.css
MISTO  src/components/AppShell.tsx  — Sai da app BLE: busca de câmeras — import listCameras/getConnectedCameras (l.31), estados cams/liveCams/loadCams (l.145-168), searchCams+hits 'Câmera' (l.282-317) — e itens de nav Central /monitoramento (l.237), Câmeras /cameras (l.240), Relatório /relatorio (l.250); rebatizar marca 'Visão de Pátio'/Cctv (l.386-397). Sai da app de visão: itens Mapa '/' (l.233), BLE /tags-ble (l.244), Planta /planta-ble (l.247). Item Simulação /replay (l.266) é bancada da fusão — sai dos dois. Turnos (l.262) fica na visão; avaliar na BLE.
BASE   src/components/appshell.css
BASE   src/components/ErrorBoundary.tsx
VISAO  src/components/Sparkline.tsx  — Componente genérico (HPHMI), mas todos os consumidores são de câmera/relatório (ZonasTab, useTelemetry, AlarmHealthStrip).
VISAO  src/components/telemetry.css  — Importado só por Sparkline.tsx.
VISAO  src/types/alarm.ts  — Vocabulário de alarme do motor de câmera (atividade/fadiga/leitura/objetos/presenca).
VISAO  src/types/alarm.test.ts
VISAO  src/types/analysis.ts  — Contrato do evento socket analysis-tracks do motor D-FINE do hub.
VISAO  src/vendor/go2rtc/go2rtc.d.ts
VISAO  src/vendor/go2rtc/video-rtc.js
VISAO  src/vendor/go2rtc/video-stream.d.ts
VISAO  src/vendor/go2rtc/video-stream.js```

## src-visao.txt
```
VISAO  src/camera/cineBuffer.ts
VISAO  src/camera/acquire.ts
VISAO  src/camera/clipExport.ts
VISAO  src/camera/useTelemetry.ts
VISAO  src/camera/useCineLoop.ts
VISAO  src/camera/useTripwires.ts
VISAO  src/camera/rafSteps.ts
VISAO  src/camera/rafSteps.test.ts
VISAO  src/camera/useHubAnalysis.ts
VISAO  src/camera/useHubAnalysis.test.ts
VISAO  src/camera/ingestPolicy.ts
VISAO  src/camera/ingestPolicy.test.ts
VISAO  src/camera/derive.ts
VISAO  src/camera/derive.test.ts
VISAO  src/camera/useFocusTrap.ts
VISAO  src/camera/interpolate.ts  — menções a 'ancorar' são interpolação temporal, não âncora BLE
VISAO  src/camera/interpolate.test.ts
VISAO  src/camera/holders.ts
VISAO  src/camera/tabs/tone.ts
VISAO  src/camera/tabs/TimelineTab.tsx
VISAO  src/camera/tabs/PresencaTab.tsx
VISAO  src/camera/tabs/LinhasTab.tsx
VISAO  src/camera/tabs/ZonasTab.tsx
VISAO  src/camera/useZoneMasks.ts
VISAO  src/camera/VertexTable.tsx
VISAO  src/camera/VertexTable.test.tsx
VISAO  src/camera/ConfigZonaDialog.tsx
VISAO  src/camera/cine.css  — estilos da CalibrationLayer permanecem (calibração/medir é feature de câmera)
VISAO  src/camera/useStageModes.ts
VISAO  src/camera/useStageModes.test.ts
VISAO  src/camera/usePolygonEditor.ts
VISAO  src/camera/usePolygonEditor.test.ts
VISAO  src/camera/usePolygonEditor.edit.test.ts
VISAO  src/camera/CamKpiBar.tsx
VISAO  src/camera/CineBar.tsx
VISAO  src/camera/useWebrtcTransport.ts
VISAO  src/camera/whip.ts
VISAO  src/camera/useCalibrationOverlay.ts  — malha da calibração salva (homografia) — feature de câmera; sem dependência BLE
VISAO  src/camera/useCalibrationEditor.test.ts  — testa só gridSegments/worldCorners (parte pura da homografia) — sobrevive à remoção dos passos BLE
BLE    src/camera/useBleReadings.ts  — mora em src/camera mas depende só de src/api (getBtReadings/getBtReadingsAll); consumidores vivos na app BLE: src/planta/useFloorplanMap.ts (l.15,80) e src/planta/useFingerprints.ts (l.15,185); na visão só a fusão o usa (useCalibrationEditor l.38,151; useTopdownView l.7,42). Mover p/ src/planta na app BLE; sai da app de visão junto com a fusão
FUSAO  src/camera/TagPicker.tsx  — lista de tags BLE p/ os passos âncora/referência da calibração da câmera
FUSAO  src/camera/takenTags.ts
FUSAO  src/camera/takenTags.test.ts
FUSAO  src/camera/station-points.ts  — pontos de chão das estações BLE na calibração da câmera (origem da dist do motor de fusão)
FUSAO  src/camera/station-points.test.ts
FUSAO  src/camera/useTopdownView.ts  — vista 2D da câmera (calibração + BLE vivo via fusion/topdown)
FUSAO  src/camera/TopdownCanvas.tsx
FUSAO  src/camera/drawTopdown.ts
FUSAO  src/camera/Vista2DStage.tsx
FUSAO  src/camera/tabs/Vista2DTab.tsx
FUSAO  src/camera/tabs/PorQueTab.tsx  — diagnóstico do funil de associação tag↔pessoa (fusion/useFunnelDiagnosis)
FUSAO  src/camera/tabs/PorQueTab.test.tsx
MISTO  src/camera/draw.ts  — VISÃO mantém letterbox/tokens/zonas/tripwires/HUD/editor. Remover (fusão): import FloorTagsView l.33; bloco TAGS NO CHÃO l.553-702 (FLOOR_*, RESIDUAL_ANOMALY_M, floorTextWidth, drawFloorTags); param labelFor de drawTracks l.282-284 (personLabel l.269-274 fica, devolvendo sempre 'Pessoa'); rótulo de MAC-âncora no drawCalibrationOverlay (CalibDot.mac l.472 e l.526-549)
MISTO  src/camera/useCalibrationEditor.ts  — VISÃO mantém cantos/H/medir/grade. Remover (fusão): imports fusion/useStationHealth+useStationNames+station-geometry+useBleReadings+station-points l.35-45; passos ancoras/estacao/referencia do CalStep l.49; estados cornerMacs/anchorCorner/pts/selStation/refTag l.119-127; poll BLE l.150-153; bloco multi-antena l.283-337; handlers de âncora/estação l.394/403/414/426/459; anchorName l.470; mac/stations/refTag no save l.486+; API exportada de estação l.539-549
MISTO  src/camera/tabs/CalibracaoTab.tsx  — VISÃO mantém Cantos+L×C+Medir+Salvar. Remover (fusão): imports StationHealthChip/TagPicker/takenTags l.15-17; passos Âncoras/Estação/Tag ref em CAL_STEPS l.33-36; seletor de estações l.188-230; StationHealthChip l.244-247; TagPicker referência l.258-262 e âncoras l.270-312
MISTO  src/camera/CalibrationLayer.tsx  — VISÃO mantém cantos numerados/retângulo/régua de medir. Remover (fusão): marcadores das estações BLE l.98-137 e losango da tag de referência l.138-163
MISTO  src/camera/CamHeader.tsx  — Remover (fusão): props mapaOpen/onToggleMapa l.73-76 e l.101-102 e o Toggle 'Mapa 2D' l.280-290; resto é visão
MISTO  src/camera/CamDrawer.tsx  — Remover (fusão): imports PorQueTab/Vista2DTab l.24-25 e FunnelDiagnosis l.29; 'porque'/'vista2d' no DrawerTab l.35; props cameraId l.43-44 e diag l.52-53; itens de aba l.103-108 e TabsContent l.116-118 e l.124-126
MISTO  src/camera/ExibicaoPopover.tsx  — Remover (fusão): prop floor l.40 e ToggleRow 'Anéis das antenas' l.129-138; resto (HUD/Malha/Camadas/preset) é visão
MISTO  src/camera/ExibicaoPopover.test.tsx  — Remover asserts de 'Anéis das antenas'/floorAvailable l.17-21, 41-46, 58-61; asserts de HUD/Malha/Camadas são visão
MISTO  src/camera/drawTracks.test.ts  — O gate 'caixa nunca mostra número' l.40-46 é visão e PERMANECE (invariante do CLAUDE.md); casos com labelFor/nome de tag l.48-59 são fusão
MISTO  src/camera/personLabel.test.ts  — caso 'sem labelFor → Pessoa' é visão; casos labelFor devolvendo nome/null (l.24-33) são fusão
MISTO  src/CameraWorkspace.tsx  — Remover (fusão): imports BtReading l.33, useFloorTags l.35, Vista2DStage l.78; props getReadings/calibrationRev l.148-154,177; estado mapaOpen l.293-295; useCameraTagLabels l.332-358; useFunnelDiagnosis l.360-371; useFloorTags+floorOn/setFloorOn l.373-392; drawFloorTags no drawScene l.1260-1266; labelForRef no drawTracks l.1302; prop floor do ExibicaoPopover l.1566; diag no CamDrawer l.1669; render Vista2DStage l.1675. Visão mantém calibração/zonas/linhas/cine/HUD
VISAO  src/CameraWorkspace.size.test.ts  — gate de tamanho do CameraWorkspace; ajustar teto após remoção dos trechos de fusão
VISAO  src/vision/counting.ts
VISAO  src/vision/counting.test.ts
VISAO  src/vision/counting.test-notes.md
VISAO  src/vision/scheduler.ts
VISAO  src/vision/scheduler.test.ts
VISAO  src/vision/nms.ts
VISAO  src/vision/nms.test.ts
VISAO  src/vision/model.ts
VISAO  src/vision/detectWorker.ts
VISAO  src/vision/detect.ts
VISAO  src/vision/luma.ts
VISAO  src/vision/luma.test.ts
VISAO  src/vision/bytetrack.ts
VISAO  src/vision/bytetrack.test.ts
BASE   src/vision/homography.ts  — geometria pura (Vec2/Matrix3/applyMatrix3/invertMatrix3) consumida por src/api.ts (l.306) e pelos módulos da planta BLE (fusion/floor-plot l.20-21, fingerprint l.17, floorplan l.8) — as DUAS apps precisam
BASE   src/vision/homography.test.ts
VISAO  src/video/ticket.ts  — ticket HMAC do proxy /go2rtc/* (vídeo)
VISAO  src/processors/types.ts
VISAO  src/processors/atividade.ts
VISAO  src/processors/atividade.test.ts
VISAO  src/processors/fadiga.ts
VISAO  src/processors/leitura.ts
VISAO  src/processors/objetos.ts
VISAO  src/fadiga/calibration.ts
VISAO  src/fadiga/landmarks.ts
VISAO  src/fadiga/draw.ts
VISAO  src/fadiga/models.ts
VISAO  src/objects/catalog.ts
VISAO  src/objects/detector.ts
VISAO  src/objects/owlvitWorker.ts
VISAO  src/reading/decoder.ts
VISAO  src/reading/zxingWorker.ts
VISAO  src/reading/cluster.ts
VISAO  src/report/mock.ts
VISAO  src/report/csv.ts
VISAO  src/report/store.ts
VISAO  src/report/store.test.ts
VISAO  src/report/predict.ts
VISAO  src/report/predict.test.ts
VISAO  src/report/alarms.css
VISAO  src/report/calc/index.ts
VISAO  src/report/calc/common.ts
VISAO  src/report/calc/common.test.ts
VISAO  src/report/calc/atividade.ts
VISAO  src/report/calc/atividade.test.ts
VISAO  src/report/calc/leitura.ts
VISAO  src/report/calc/objetos.ts
VISAO  src/report/calc/fadiga.ts
VISAO  src/report/calc/flow.ts
VISAO  src/report/calc/flow.test.ts
VISAO  src/report/calc/alarmes.ts
VISAO  src/routes/CamerasPage.tsx
VISAO  src/routes/cameras/LocalNodeSection.tsx
VISAO  src/routes/cameras/IpCamerasSection.tsx
VISAO  src/routes/CameraPage.tsx
VISAO  src/routes/camera/nodeRelay.ts
VISAO  src/routes/useCamCfgs.ts
VISAO  src/routes/dash-grid.css
VISAO  src/routes/cameras.css
VISAO  src/routes/alarms.css
VISAO  src/routes/dashboard/types.ts
VISAO  src/routes/dashboard/transport.ts
VISAO  src/routes/dashboard/transport.test.ts
VISAO  src/routes/dashboard/useAlarms.ts
VISAO  src/routes/dashboard/useFrameRelay.ts
VISAO  src/routes/dashboard/useVideoTransport.ts
VISAO  src/routes/dashboard/AlarmDrawer.tsx
VISAO  src/routes/dashboard/go2rtc-tile.css
MISTO  src/routes/dashboard/useDashboardSocket.ts  — VISÃO mantém frames/statuses/alarms/camcfg. Remover (fusão): import BtReading l.13 e source-pool l.14; getBtReadings no contrato l.47-48 e l.248-249,258; refs btSourcesRef/btReadingsRef l.88-89; handler socket 'bt-readings' l.157-176; calibrationRevByCamera l.45,185-196 (só a fusão tag↔pessoa consome a rev)
MISTO  src/routes/dashboard/CameraTile.tsx  — VISÃO mantém o tile de vídeo WebRTC/MJPEG. Remover (fusão): imports BtReading/useCameraTagLabels/useFloorTags l.4-6; props getReadings/calibrationRev l.62-63 e l.259-262; useCameraTagLabels+labelFor l.157-172; useFloorTags+getFloorTags l.175-183; props labelFor/getFloorTags do TrackOverlay l.192-193; bloco de fusão do caminho MJPEG l.347-349
MISTO  src/routes/dashboard/TrackOverlay.tsx  — VISÃO mantém desenho das caixas do hub sobre o vídeo. Remover (fusão): import drawFloorTags/FloorTagsView l.4,6; props labelFor/getFloorTags l.25-30,34; chamada drawFloorTags l.86-87; personLabel fica (rótulo genérico 'Pessoa' l.108-121)
MISTO  src/routes/DashboardPage.tsx  — VISÃO mantém a grade/central. Remover (fusão): calibrationRevByCamera do socket l.65; props calibrationRev/getReadings dos tiles l.282-287 e da câmera aberta l.327-333
FUSAO  src/routes/ReplayPlayerPage.tsx  — bancada /replay das sessões de fusão câmera+BLE (fusion/replay-fusion, sim, session-loader, player/*) — sem uso com a fusão desativada; preservar no histórico git
BASE   src/routes/ProfilePage.tsx
BASE   src/routes/NotFoundPage.tsx
MISTO  src/routes/UsersPage.tsx  — BASE = CRUD de usuários/RBAC. Lado BLE remove: aba 'cameras' (import CamerasTab l.27, getCameraEnroll/camToken l.16,42, seção 'cameras' l.50) e os tipos de alarme de câmera do fluxo de notificações (ver NotificacoesTab)
BASE   src/routes/users/types.ts
BASE   src/routes/users/UsersTab.tsx
VISAO  src/routes/users/CamerasTab.tsx  — wrapper fino do LocalNodeSection (inscrição de nó de câmera)
MISTO  src/routes/users/NotificacoesTab.tsx  — BASE = destinatários WhatsApp/status/teste. Lado BLE remove/adapta: TIPO_LABEL com modos de câmera (atividade/fadiga/leitura/objetos) l.30-35 e os filtros por tipo de alarme de câmera
VISAO  src/routes/TurnosPage.tsx  — turnos consumidos hoje só por zonas/alarme/relatório de câmera (server/shifts.js + report/calc); se a app BLE ganhar relatório por turno, promover a base
VISAO  src/routes/ReportPage.tsx
VISAO  src/routes/report/useReportData.ts
VISAO  src/routes/report/useAtividadeVM.ts
VISAO  src/routes/report/useLeituraVM.ts
VISAO  src/routes/report/useObjetosVM.ts
VISAO  src/routes/report/useFadigaVM.ts
VISAO  src/routes/report/useAlarmesVM.ts
VISAO  src/routes/report/labels.ts
VISAO  src/routes/report/aggregate.ts
VISAO  src/routes/report/aggregate.test.ts
VISAO  src/routes/report/csv.ts
VISAO  src/routes/report/chrome.tsx
VISAO  src/routes/report/EventsTable.tsx
VISAO  src/routes/report/Heatmap.tsx
VISAO  src/routes/report/TrendChart.tsx
VISAO  src/routes/report/FlowChart.tsx
VISAO  src/routes/report/AtividadePanel.tsx
VISAO  src/routes/report/ObjetosPanel.tsx
VISAO  src/routes/report/FadigaPanel.tsx
VISAO  src/routes/report/AlarmesPanel.tsx
VISAO  src/routes/report/LeituraPanel.tsx
VISAO  src/routes/report/ResumoPanel.tsx
VISAO  src/routes/report/EmptyHistory.tsx
VISAO  src/routes/report/KpiRow.tsx
VISAO  src/routes/report/RankingBars.tsx
VISAO  src/routes/report/AlarmHealthStrip.tsx
VISAO  src/routes/report/ReportTools.tsx
VISAO  src/routes/report/report.css
VISAO  src/routes/report/health.css
BLE    src/routes/ble/BlePage.tsx
BLE    src/routes/ble/TagsTab.tsx  — importa fusion/useStationNames (helper de nomes de estação que a app BLE também precisa levar)
BLE    src/routes/ble/EstacoesTab.tsx
BLE    src/routes/ble/EstacoesList.tsx
BLE    src/routes/ble/EstacoesList.test.tsx
BLE    src/routes/PlantaBlePage.tsx  — depende de src/planta/* e de módulos BLE que moram em src/fusion (zone-presence, work-area, topdown, floorplan) — levar junto p/ a app BLE
BLE    src/routes/TagsMapPage.tsx  — mapa leaflet do coletor (bt/locations+readings); depende de src/localizacao```

## src-ble.txt
```
FUSAO  src/fusion/associate.ts
FUSAO  src/fusion/associate.test.ts
FUSAO  src/fusion/frame.ts  — Monta FusionFrame câmera(tracks/homografia)+BLE p/ o associador.
FUSAO  src/fusion/frame.test.ts
FUSAO  src/fusion/distance.ts  — 2ª evidência da associação: compara dist. da PISTA (homografia da câmera) com dist. do rádio; nenhum consumidor BLE — só testes do arco fusão.
FUSAO  src/fusion/distance.test.ts
FUSAO  src/fusion/distance-field.test.ts
FUSAO  src/fusion/labelMemory.ts
FUSAO  src/fusion/labelMemory.test.ts
FUSAO  src/fusion/useTagFusion.ts
FUSAO  src/fusion/useTagFusion.test.ts
FUSAO  src/fusion/useCameraTagLabels.ts
FUSAO  src/fusion/useCameraTagLabels.test.ts
FUSAO  src/fusion/useFloorTags.ts  — Anéis de distância sobre o vídeo da câmera (homografia).
FUSAO  src/fusion/useFloorTags.test.ts
FUSAO  src/fusion/useFunnelDiagnosis.ts
FUSAO  src/fusion/useFunnelDiagnosis.test.ts
FUSAO  src/fusion/stationHealth.ts  — Saúde da estação BLE, mas consumida SÓ pela calibração de estação na câmera (useCalibrationEditor/CalibracaoTab).
FUSAO  src/fusion/stationHealth.test.ts
FUSAO  src/fusion/useStationHealth.ts
FUSAO  src/fusion/StationHealthChip.tsx
FUSAO  src/fusion/StationHealthChip.test.tsx
FUSAO  src/fusion/station-geometry.ts  — Hints de instalação multi-antena; consumidor único é a calibração da câmera (spec multi-antena do arco fusão).
FUSAO  src/fusion/station-geometry.test.ts
FUSAO  src/fusion/source-pool.ts  — Merge por fonte do socket bt-readings; consumidores vivos: useDashboardSocket (alimenta a fusão tag↔pessoa) e session-loader (replay). A Planta BLE usa polling HTTP, não este pool.
FUSAO  src/fusion/source-pool.test.ts
FUSAO  src/fusion/sim.ts  — Simulador da bancada /replay; usa computeHomography/worldToPixel da câmera.
FUSAO  src/fusion/sim.test.ts
FUSAO  src/fusion/replay-fusion.ts
FUSAO  src/fusion/replay-fusion.test.ts
FUSAO  src/fusion/session-loader.ts
FUSAO  src/fusion/session-loader.test.ts
FUSAO  src/fusion/world-spec.ts
FUSAO  src/fusion/world-spec.test.ts
FUSAO  src/fusion/families.ts
FUSAO  src/fusion/families.test.ts
FUSAO  src/fusion/shuffle-baseline.ts
FUSAO  src/fusion/shuffle-baseline.test.ts
FUSAO  src/fusion/identity-metrics.ts
FUSAO  src/fusion/identity-metrics.test.ts
FUSAO  src/fusion/funnel-session.test.ts
FUSAO  src/fusion/gates-recalibration.test.ts
FUSAO  src/fusion/reftag-anchor.test.ts
FUSAO  src/fusion/player/derive-player-frame.ts
FUSAO  src/fusion/player/derive-player-frame.test.ts
FUSAO  src/fusion/player/playback-transport.ts
FUSAO  src/fusion/player/playback-transport.test.ts
FUSAO  src/fusion/player/session-view.ts
FUSAO  src/fusion/player/session-view.test.ts
FUSAO  src/fusion/player/annotation.ts
FUSAO  src/fusion/player/annotation.test.ts
MISTO  src/fusion/floor-plot.ts  — Lado BLE MANTÉM fitPathLoss/distFromRssi + tipos AnchorObs/PathLossModel (l.23-153; consumidos por planta/useFloorplanMap e fusion/floorplan; só precisam do tipo Vec2) e REMOVE anchorResidualM+ringPixels (l.155-218: usam applyMatrix3/invertMatrix3 da homografia — anéis sobre o vídeo). Lado visão: o arquivo sai inteiro (consumidores restantes — useFloorTags/frame/distance/topdown/replay — são todos do arco fusão).
MISTO  src/fusion/floor-plot.test.ts  — Lado BLE mantém describes de fitPathLoss (l.27-160) e distFromRssi (l.162-190); remove describes de anchorResidualM (l.192-235) e ringPixels (l.237+, usa homografia real). Lado visão: sai com o módulo.
MISTO  src/fusion/topdown.ts  — Lado BLE MANTÉM o enquadramento puro: TopdownBbox/TopdownTransform/bboxOf/worldToCanvas (l.169-250; consumidos por planta/drawFloorplan, FloorplanCanvas, useFloorplanEditor, useWorkAreaPolygonEditor, FloorplanEditLayer, PlantaBlePage) e REMOVE deriveTopdownView + tipos Topdown*/topdownBounds (l.1-167 e 200-217: usam pixelToWorld/H da câmera; topdownBounds só é consumido pela Vista 2D da câmera). Lado visão: o arquivo pertence à Vista 2D (fusão) e sai inteiro.
MISTO  src/fusion/topdown.test.ts  — Lado BLE mantém describe de worldToCanvas (l.78+); remove describe de deriveTopdownView (l.19-77, usa Matrix3 da câmera). Lado visão: sai.
BASE   src/fusion/floor-polygon.ts  — pointInPolygon é consumido pela câmera (src/zones.ts) E pelo BLE (fusion/work-area.ts); geometria pura sem dep de câmera. clipRingToPolygon (l.85+) é trecho do arco fusão sem consumidor vivo (só o teste) — podável em ambas.
BASE   src/fusion/floor-polygon.test.ts  — Se podar clipRingToPolygon, os describes dele (l.66+) saem junto.
BLE    src/fusion/useStationNames.ts  — Resolve id→nome de estação BLE (GET /api/bt-stations); usado por planta/useFloorplanMap e routes/ble/TagsTab. Na app de visão os consumidores (useCalibrationEditor/useTopdownView) são do arco fusão e saem juntos.
BLE    src/fusion/useStationNames.test.ts
BLE    src/fusion/fingerprint.ts  — Só importa o tipo Vec2; src/api.ts re-exporta o tipo Fingerprint (l.453-454) — esse trecho de api.ts sai no lado visão.
BLE    src/fusion/fingerprint.test.ts
BLE    src/fusion/floorplan.ts  — Multilateração RSSI→X,Y da Planta; importa bboxOf de fusion/topdown — levar o helper puro junto (topdown é misto).
BLE    src/fusion/floorplan.test.ts
BLE    src/fusion/zone-presence.ts
BLE    src/fusion/zone-presence.test.ts
BLE    src/fusion/motion-filter.ts
BLE    src/fusion/motion-filter.test.ts
BLE    src/fusion/continuous-position.ts
BLE    src/fusion/continuous-position.test.ts
BLE    src/fusion/work-area.ts  — Usa pointInPolygon de fusion/floor-polygon (base).
BLE    src/fusion/work-area.test.ts
BLE    src/fusion/localization-eval.ts
BLE    src/fusion/localization-eval.test.ts
BLE    src/planta/useFloorplanMap.ts  — Depende de camera/useBleReadings (poll HTTP BLE que mora na pasta camera — mover p/ app BLE) e de fitPathLoss/useStationNames (partes BLE dos módulos em src/fusion).
BLE    src/planta/useFingerprints.ts  — Usa camera/useBleReadings — hook 100% BLE na pasta camera; mover junto.
BLE    src/planta/useFingerprints.test.ts
BLE    src/planta/FloorplanCanvas.tsx  — Importa drawPolygonEditor de camera/draw — extrair o desenho do editor poligonal p/ módulo compartilhado (par do spatial/usePolygonEditor).
BLE    src/planta/drawFloorplan.ts  — Importa cssVar de camera/draw e bboxOf/TopdownTransform de fusion/topdown — extrair esses helpers compartilhados.
BLE    src/planta/drawFloorplan.test.ts
BLE    src/planta/useFloorplanEditor.ts
BLE    src/planta/useFloorplanEditor.test.ts
BLE    src/planta/FloorplanEditLayer.tsx
BLE    src/planta/AntennaTable.tsx
BLE    src/planta/useWorkAreaPolygonEditor.ts  — Injeta espaço métrico no editor canônico de src/spatial (base).
BLE    src/planta/WorkAreaPanel.tsx
BLE    src/planta/ZoneCalibration.tsx
BLE    src/planta/ZoneCalibration.test.tsx
BLE    src/planta/useContinuousFloorplan.ts
BLE    src/localizacao/entity.ts  — Contrato LocatedEntity da costura ADR-012; consumidor vivo é TagsMapPage (mapa geo de tags).
BLE    src/localizacao/adapters.ts
BLE    src/localizacao/adapters.test.ts
BLE    src/localizacao/README.md
BASE   src/spatial/usePolygonEditor.ts  — Editor poligonal canônico usado por camera/usePolygonEditor E planta (useWorkAreaPolygonEditor/FloorplanCanvas); porém importa helpers puros de src/zones.ts (isSimplePolygon/polygonBBox/polygonContainsFn/zonePolygon/ZonePoint) — zones.ts é domínio câmera, extrair esses helpers p/ módulo neutro antes do split.
BASE   src/spatial/.gitkeep```

## raiz-infra.txt
```
MISTO  e2e/a11y.spec.ts  — Visão: remover do gate as rotas BLE/fusão (ALLOW: mapa '/', tags-ble, planta-ble, replay) e ajustar login() que asserta a home 'Mapa de tags' (~l.40); BLE: remover monitoramento, cameras, relatorio, turnos e replay.
VISAO  e2e/app.spec.ts  — login() (l.5-15) asserta a home BLE 'Mapa de tags' — ajustar quando a home da app visão mudar; testes base (l.321 navegação, l.600 AlertDialog/Usuários) valem copiar p/ a suíte da app BLE.
BLE    e2e/ble.spec.ts
VISAO  e2e/calibracao.spec.ts  — Cobre homografia/Medir (ficam na visão); o chrome de fusão da aba Calibrar (TagPicker/StationHealthChip/station-points) sai com a fusão; login() asserta a home BLE 'Mapa de tags'.
MISTO  e2e/mobile.spec.ts  — Visão: tirar de SCREENS a linha {path:'/',name:'mapa'} e o assert do login ('Mapa de tags'); BLE: tirar central (/monitoramento), /cameras e /relatorio; usuarios/perfil ficam nos dois.
BLE    e2e/planta-ble.spec.ts
BASE   e2e/global-setup.ts  — Hub isolado p/ e2e; CAMERA_TOKEN/ANALYSIS_ENABLED=0 são detalhe de visão mas inócuos na app BLE.
BASE   e2e/global-teardown.ts
VISAO  eval/  — Bancada de acurácia do motor D-FINE (gate, counting, reid, persons-cftv, stationary, front-tournament, crossing-scenarios, lib, fixtures) — exceto os 3 arquivos de fusão listados à parte.
FUSAO  eval/multi-antena.mjs  — Torneio da 2ª antena da associação tag↔pessoa — importa src/fusion/sim|frame|associate.
FUSAO  eval/reftag-anchor.mjs  — fitPathLoss da fusão sobre gravação server/bt/*.jsonl.
FUSAO  eval/absolute-distance.mjs  — Distância absoluta p/ o associador tag↔pessoa sobre gravação de campo.
VISAO  scripts/cameras-demo.mjs
FUSAO  scripts/family.mjs  — CLI da bancada científica — delega ao vitest p/ rodar src/fusion/families.ts.
VISAO  scripts/fetch-go2rtc.mjs
FUSAO  scripts/funnel.mjs  — Funil de vetos da associação tag↔pessoa (src/fusion/session-loader + associate).
BASE   scripts/lint-tokens.mjs  — Ratchet de tokens de UI — vale nas duas apps (a baseline por arquivo precisará recalibrar em cada lado).
VISAO  scripts/make-jumpy-clip.mjs
VISAO  scripts/measure-focus.cjs
VISAO  scripts/probe-hardware.mjs  — Decide alavancas do motor de análise (ANALYSIS_WORKERS/INT8/GPU).
VISAO  scripts/profile-infer.cjs
VISAO  scripts/spike-yolo.cjs
VISAO  scripts/validate-streams.mjs
BLE    tc22-scanner/  — App Android da estação BLE (fonte da Planta BLE); README menciona a fusão mas o artefato é da app BLE.
MISTO  package.json  — Deps só-visão: @huggingface/transformers, @mediapipe/tasks-vision, @tensorflow/tfjs, @tensorflow-models/coco-ssd, @zxing/library, onnxruntime-node, sharp. Só-BLE: leaflet + @types/leaflet (TagsMapPage). baileys+qrcode = notificações do hub (hoje acionadas por alarme de câmera; decidir se a app BLE mantém). Scripts npm: eval/eval:counting/cameras/probe são visão; family/funnel são fusão (remover).
MISTO  vite.config.ts  — Visão mantém proxy /go2rtc + CDNs de modelo no CSP (jsdelivr/tfhub/kaggle/huggingface/storage.googleapis) e pode tirar tiles OSM/ArcGIS; BLE mantém img-src *.tile.openstreetmap.org/*.arcgisonline.com (leaflet) e remove proxy go2rtc + CDNs de modelo + camera=(self) do Permissions-Policy.
BASE   tsconfig.json
BASE   eslint.config.js
BASE   vitest.config.ts
BASE   playwright.config.ts  — Flags de webcam fake e VITE_GO2RTC_BASE (porta morta) são de visão — inócuas na app BLE, podem sair lá.
MISTO  .github/workflows/ci.yml  — Jobs verify+e2e = base; job eval (download do modelo ONNX + gate de detecção + counting, l.112-147) é visão — remover na app BLE; o passo 'E2E (app + mobile)' (l.92-93) nomeia specs — ajustar a lista por app.
BASE   .github/workflows/deploy-homolog.yml  — CD genérico do hub via SSH; cada app aponta p/ seu ambiente/segredos.
BASE   .githooks/pre-push
BASE   .github/hooks/impeccable.json
MISTO  CLAUDE.md  — App BLE precisa de versão ENXUTA: remover §1 (motor D-FINE/go2rtc/modos), invariantes de câmera (casca fullscreen ADR-007, caixa-da-pessoa-sem-número, eval/ no gate §6) e manter LGPD/segredos/Radix/verify + invariantes BLE (BT_STATION_TOKEN, gravação imutável, ADR-017) + Regras 8-13 (nasceram do arco BLE); visão remove o invariante 'Planta BLE sem encaixe' e os endpoints BLE quando o domínio sair.
BLE    docs/analises/tags-bluetooth/  — Arco BLE; guia-hibrido-camera-ble.md e laudo-2026-07-13-por-que-nao-associa.md são conteúdo de fusão — ficam como histórico na app BLE, saem da visão.
BLE    docs/analises/planta-ble-localizacao-continua/
FUSAO  docs/cientifica/  — Todo o arco científico da associação tag↔câmera (harness, simulador, laudos, ondas).
MISTO  docs/analises/decisoes/  — Ambas mantêm ADRs base (001,003,005,006,007,008,016); visão mantém 002,004,009,010,011,015 e descarta 017; BLE mantém 017 e descarta os de câmera; 012/013/014 (fusão) ficam só como histórico onde couber.
MISTO  docs/arquitetura/  — Visão mantém tudo; BLE descarta 02 (núcleo visão), 03 (modos) e 06 (alertas/RTSP), apara telas de câmera do 04 e seções de motor/vídeo do 01/05/07 — ou regenera do código enxuto (docs são gerados do código).
VISAO  docs/produto/  — Backlog/planos do produto de câmera; ci-cd-github-actions.md e deploy-*.md são infra reaproveitável — copiar p/ a app BLE se ela seguir o mesmo deploy.
MISTO  docs/analises/ (arquivos soltos na raiz)  — Maioria visão (planos/specs de câmera, perf, acurácia, spike-*). Vão p/ BLE: spec-zona-trabalho-ble.md, registro_erros.md (erros da planta BLE). Fusão (histórico): spec-multi-antena-ble.md (multiSourceFisher do associate.ts). Base (ambas): spec-control-plane*.md, spec-multitenancy.md, spec-arquitetura-informacao.md, spec-padronizacao-interface.md, auditoria-padroes-ui.md, auditoria-ui-ux.md, auditoria-qualidade-codigo.md, laudo-2026-07-13-padronizacao-layout-spa.md, implementacao-changelog.md, README.md.
BASE   docs/analises/benchmark-interfaces/  — Pesquisa de referências de UI — serve às duas apps.
BASE   docs/analises/frontend-radix/
BASE   docs/analises/ui-review/
BASE   docs/analises/saude/  — Auditorias do repo inteiro (doutrina, segurança, deps) — histórico útil nos dois lados.
VISAO  docs/analises/cameras-industriais/
VISAO  docs/analises/cameras-publicas/
VISAO  docs/analises/perf-round3/  — Perf de ingest/relay/pool do motor de análise.
VISAO  docs/analises/reconhecimento-pessoas/
VISAO  docs/analises/retrofit-2/  — Retrofit do motor/server/front de câmera; 03-server-core toca base mas é histórico — não precisa ir p/ a app BLE.
VISAO  docs/analises/rtmp-ingest/```

