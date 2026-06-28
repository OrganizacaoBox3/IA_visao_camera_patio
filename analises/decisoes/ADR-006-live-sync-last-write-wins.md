# ADR-006 — Sincronização ao vivo last-write-wins via socket

## Contexto
Views e tripwires passaram a ser compartilhados no backend (ADR-005), mas só
recarregavam ao abrir/trocar câmera ou no mount. Operadores/engenheiros em turnos
diferentes não viam mudanças uns dos outros em tempo real.

## Decisão
Após um `PUT /api/views` ou `PUT /api/tripwires/:cam` bem-sucedido, o hub emite um
evento socket aditivo **`camcfg-updated`** para a sala `dashboards`:
`{ kind: "views" }` ou `{ kind: "tripwires", cameraId }`. A central recarrega a lista
de views; para tripwires, incrementa um contador de revisão por câmera e o repassa às
tiles via prop **`tripwiresRev`**, e o `CameraWorkspace` re-busca os tripwires ao ver
a prop mudar (pulando se estiver em edição local, para não sobrescrever trabalho em
curso). A persistência permanece **last-write-wins** (PUT da lista inteira) — sem
merge incremental.

## Consequências
- (+) Mudanças aparecem ao vivo entre operadores sem reabrir a câmera.
- (+) Evento aditivo — `frame`/`cameras`/`alert`/`camera-status` intactos.
- (−) Last-write-wins: duas edições concorrentes da mesma lista, a última vence
  (aceitável para o volume/uso atual; merge fica para evolução).
- (−) Re-fetch é pulado durante edição local → o editor pode ficar momentaneamente
  desatualizado até concluir/cancelar a edição.
