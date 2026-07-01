// Tipos compartilhados pela central (DashboardPage) e seus componentes filhos.

export type Camera = { id: string; label: string };

// Status por câmera vindo do hub (contrato A4 — evento socket `camera-status`). Aditivo: se o hub
// não emitir, a UI assume "online" e nada quebra.
export type CameraStatus = {
  id: string;
  state: "connecting" | "online" | "error" | "stopped";
  fps?: number;
  lastError?: string | null;
  label?: string;
  kind?: "rtsp" | "browser";
};
