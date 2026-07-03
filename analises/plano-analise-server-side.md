# Plano — Migração da análise para o hub (execução da ADR-009)

> Pré-requisitos prontos: spike GO (analises/spike-dfine-hub.md), lógica de contagem/tracking
> JÁ é pura e portável (counting.ts + bytetrack.ts com 50+ unit tests), frames já transitam
> pelo hub, kind "flow"/persistência prontos. Entregas pequenas: cada fase funciona sozinha
> e é reversível (motor atrás de env/flag; browser continua funcionando como hoje até a F3).

## Situação atual (resumo da avaliação)
- IA 100% no navegador do espectador → análise para sem aba aberta; N espectadores = N× CPU
  **e ingest duplicado** (bug latente); detecção refém da GPU do cliente; tripwires na prática
  mortos. Modelo coco-ssd (2017) é o teto de recall.
- O que já é reutilizável server-side sem reescrita: `counting.ts` (tripwire), `bytetrack.ts`
  (tracking), atribuição de zona (função pura), agregação/ingest (pgstore direto, sem HTTP).

## Fases

### F1 — Motor no hub (o coração) — ~2-3 dias
- `server/analysis/worker.js`: **worker process** (child_process, respawn com backoff) com
  onnxruntime-node CPU EP + D-FINE-N ONNX (fp32; int8 descartada por medição). Protocolo IPC
  simples: hub envia {cameraId, jpegBuffer, ts} @1-2fps (amostrado do relé, com descarte
  último-vence); worker devolve {dets normalizadas}.
- `server/analysis/engine.js` no hub: por câmera HABILITADA (flag por câmera, default ON p/
  câmeras IP): ByteTrack (port 1:1 do bytetrack.ts → JS puro + testes portados), zonas/linhas
  carregadas do camcfg (já persistidas), tripwire counter (port do counting.ts), atividade/
  ocupação por detecção + agregação → **pgstore.ingest direto** (ativ/flow; obj-coco entra em
  ativ.people/occupied como hoje).
- **Anti-duplicação**: quando o motor estiver ON p/ uma câmera, o hub anuncia (evento aditivo
  `analysis-status {cameraId, engine:"hub"}`); o browser **desliga o ingest** dela (mantém
  overlays locais por ora). Sem o motor → comportamento atual intacto (fallback natural).
- Shed: análise conta como espectador do ffmpeg (stream vivo p/ o motor mesmo sem dashboard).
- Modelo ONNX: baixado no primeiro boot p/ `server/models/` (gitignored) com hash conferido,
  ou baixado manualmente (documentar no deploy).
- Métricas: fps/fila/ms por câmera expostas em `/api/analysis/status` (aditivo) + log 1×/min.

### F2 — Overlays servidos + browser mais leve — ~1-2 dias
- Evento aditivo `tracks {cameraId, tracks[], zones[]}` @1-2fps p/ dashboards (metadados, KB).
- Grade: tiles desenham boxes/estados vindos do servidor → **remove a inferência coco da grade
  no cliente** (fim do worker tfjs por espectador na grade; câmera ABERTA ainda pode rodar
  inferência local para overlay de baixa latência — decidir na F2 com medição).
- Telemetria da câmera mostra a fonte: "análise: hub (D-FINE)" / "análise: local".

### F3 — Aposentar o coco-ssd do cliente + limpeza — ~1 dia
- Câmera aberta também consome tracks do hub; tfjs/coco-ssd sai do bundle (≈ -3MB e -1 worker);
  perfil "longo alcance" vira parâmetro do MOTOR (tiling 640 no hub, barato); atualizar
  CLAUDE.md §1 + docs-regenerada.
- Ficam no cliente: MediaPipe (fadiga), ZXing (leitura), cine-loop, editores — reavaliar depois.

### F4 — (opcional, medir antes) Objetos/OWL-ViT e Leitura no hub
- Só se a operação pedir: OWL-ViT é pesado (avaliar D-FINE classes COCO cobre caixa/palete?
  "suitcase/box" aproximam; senão fine-tune futuro) — fora do escopo desta rodada.

## Validação (por fase — sem verde não avança)
- F1: teste de integração real (hub isolado + câmera pública): motor ON → flow/ativ buckets
  enchem SEM nenhum dashboard aberto (a prova do requisito); pessoas contadas ≥ baseline do
  spike; kill do worker → respawn sem derrubar o hub; 5 câmeras simultâneas com CPU < 60%.
- F2/F3: verify + e2e 8/8 + re-diagnóstico visual (overlays da grade); medição de CPU do
  navegador antes×depois (esperado: queda drástica na grade).
- Rollback: flag desliga o motor → comportamento atual.

## Fora de escopo desta rodada
Fadiga/Leitura no hub (F4 condicional); GPU no servidor (CPU EP resolve a escala atual);
re-ID; D-FINE-S/M (só se pessoa distante <25px virar requisito).
