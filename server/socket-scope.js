// Escopo por câmera na camada de socket (RBAC com escopo — spec-multitenancy §4/§5, papel
// "cliente"). Os eventos de dashboard (cameras/camera-status/alarm-*/camcfg-updated) nasceram
// como broadcast único pra sala "dashboards" — todo autenticado recebia tudo (S2/S3 da spec).
// Aqui vira emissão POR SOCKET: cada dashboard só recebe o que seu papel/cameraIds autorizam.
// NUNCA filtrar isso no cliente — o objetivo é o dado nem SAIR do servidor pro socket errado.
const { canSeeCamera } = require("./users");

// Câmeras que este usuário pode ver (papéis de equipe veem tudo; "cliente" só as alocadas).
function visibleCameras(list, user) {
  if (!user || user.papel !== "cliente") return list;
  const allow = new Set(user.cameraIds || []);
  return list.filter((c) => allow.has(String(c.id)));
}

// Sockets da sala "dashboards" (todo dashboard autenticado entra nela — sockets/dashboard.js).
function dashboardSockets(io) {
  const out = [];
  for (const s of io.of("/").sockets.values()) if (s.rooms.has("dashboards")) out.push(s);
  return out;
}

function hasDashboardViewerForCamera(io, cameraId) {
  return dashboardSockets(io).some((s) => canSeeCamera(s.data.user, cameraId));
}

// Emite um evento LIGADO A UMA CÂMERA (alarm-event, camera-status, camcfg-updated) só para os
// dashboards cujo usuário pode ver aquela câmera. `cameraId` ausente/null (ex.: evento sem
// câmera associada) → só chega a papéis de equipe, nunca a "cliente" (fail-closed).
function emitScopedByCamera(io, event, payload, cameraId, { volatile = false } = {}) {
  for (const s of dashboardSockets(io)) {
    if (!canSeeCamera(s.data.user, cameraId)) continue;
    if (volatile && s.volatile && typeof s.volatile.emit === "function")
      s.volatile.emit(event, payload);
    else s.emit(event, payload);
  }
}

function scopeAnalysisStatus(status, user) {
  if (!status || !user || user.papel !== "cliente") return status;
  const entries = Object.entries(status.perCamera || {}).filter(([cameraId]) =>
    canSeeCamera(user, cameraId),
  );
  const perCamera = Object.fromEntries(entries);
  const skipped1m = entries.reduce((sum, [, item]) => sum + Number(item?.skipped1m || 0), 0);
  const skippedTotal = entries.reduce(
    (sum, [, item]) => sum + Number(item?.skippedTotal || 0),
    0,
  );
  return {
    ...status,
    focused: Array.isArray(status.focused)
      ? status.focused.filter((cameraId) => canSeeCamera(user, cameraId))
      : [],
    motionGate: status.motionGate
      ? { ...status.motionGate, skipped1m, skippedTotal }
      : status.motionGate,
    perCamera,
  };
}

module.exports = {
  visibleCameras,
  dashboardSockets,
  hasDashboardViewerForCamera,
  emitScopedByCamera,
  scopeAnalysisStatus,
};
