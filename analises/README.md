# Análises Técnicas — MVP de Visão Computacional

Artefatos de análise produzidos por agentes dedicados (junho/2026) para apoiar a
evolução do produto. Cada documento é independente e cita evidências no código no
formato `arquivo:linha`.

## Índice

| Artefato | Tema | Resumo |
|----------|------|--------|
| [performance-diagnostico.md](performance-diagnostico.md) | Performance / travamentos | Por que está lento e como acelerar |
| [auditoria-ui-ux.md](auditoria-ui-ux.md) | UI/UX e maturidade | Telas/modais quebrados e lacunas de produto |
| [conectividade-multicamera-rtsp.md](conectividade-multicamera-rtsp.md) | Arquitetura multi-câmera | O que falta para escalar a várias câmeras |
| [cameras-fontes-publicas-demo.md](cameras-fontes-publicas-demo.md) | Fontes de câmera para demo | Catálogo de streams públicos/de teste |

## Achados de maior prioridade (consolidado)

### 🔴 Bloqueadores operacionais
- **Modo demo "Limite curto (10s)" ligado por padrão** (`DashboardPage.tsx:28`, `config.ts:44`):
  toda zona dispara alerta após 10s → toasts + Andon/WhatsApp em massa em produção. (auditoria-ui-ux)
- **Erros de API invisíveis no Relatório** (`store.ts:20-21,128`): hub fora do ar aparece
  como "Sem histórico" (igual a vazio). (auditoria-ui-ux)

### 🟠 Performance (maior impacto / menor esforço)
1. **Gate de "frame novo" no loop** (`CameraWorkspace.tsx:194,214,274`): rAF a ~60fps
   reprocessa o mesmo frame ~4×. Corta 60–75% do trabalho de main thread.
2. **Reusar buffers de luma** (`CameraWorkspace.tsx:215`, `leitura.ts:57`): elimina GC churn.
3. **Tirar coco-ssd da main thread / não duplicar modelos** (`detect.ts:31-33`): dois modelos
   coco aquecidos + coco na main thread em Fadiga/Objetos travam a UI.
- Causa estrutural: N loops rAF independentes (1 por câmera) sem scheduler central.

### 🟡 Escala multi-câmera (gargalos)
- Inferência serializada num único Web Worker coco-ssd compartilhado (guarda anti-sobreposição
  é por componente, não global).
- 1 processo ffmpeg por stream RTSP, sem pool nem health-check (retry fixo 3s).
- Fontes RTSP estáticas (lidas só no boot); sem CRUD de câmeras nem status por câmera.
- Central decodifica/renderiza TODOS os feeds (sem paginação/seleção).

### 🟢 Câmeras para demonstração
- 18 fontes catalogadas (3 verificadas ao vivo). O pipeline ffmpeg aceita `rtsp://`,
  HLS (`.m3u8`) e MJPEG no mesmo campo `url` de `rtsp.sources.json` — sem mexer no código.
- Melhores apostas: trânsito/portos (DOT, Rotterdam) para **atividade/objetos**;
  webcam local para **fadiga** e **leitura de código** (close-up real).
- Streams de teste sempre disponíveis (Wowza RTSP + Mux HLS) para validar o pipeline.

## Próximos passos sugeridos (ordem recomendada)
1. **Quick wins de performance** (gate de frame, buffers, modelo) — destrava o uso atual.
2. **Corrigir bloqueadores de UI** (desligar demo 10s em prod, tratar erros de API).
3. **Scheduler global de inferência + paginação/seleção de feeds + status por câmera** — habilita escala.
4. **Validar pipeline com 1–2 streams demo** do catálogo; depois **CRUD dinâmico de câmeras**.
