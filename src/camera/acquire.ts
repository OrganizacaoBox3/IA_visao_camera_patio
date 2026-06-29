// Aquisição robusta de câmera — portado das boas práticas do sensor_fadiga_mvp.
// Contexto seguro (HTTPS/localhost), pré-checagem da Permissions API, escada de constraints
// (1280→960→qualquer), facingMode por Android e mapeamento granular de DOMException.

const LOCALHOST = new Set(["localhost", "127.0.0.1", "::1"]);

export type AcquireErrorKind = "insecure" | "unsupported" | "denied" | "notfound" | "error";
export class CameraAcquireError extends Error {
  kind: AcquireErrorKind;
  constructor(kind: AcquireErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "CameraAcquireError";
  }
}

export function isSecureCameraContext(): boolean {
  if (typeof window === "undefined") return true;
  if (window.isSecureContext) return true;
  return LOCALHOST.has(window.location.hostname);
}

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

function mapDom(e: unknown): CameraAcquireError {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return new CameraAcquireError(
      "denied",
      "Permissão de câmera negada. Autorize a câmera no navegador.",
    );
  if (name === "NotFoundError")
    return new CameraAcquireError("notfound", "Nenhuma câmera disponível no dispositivo.");
  return new CameraAcquireError(
    "error",
    "Falha ao iniciar câmera. Verifique dispositivo e permissão.",
  );
}

// Retorna um MediaStream ou lança CameraAcquireError (kind legível p/ a UI).
export async function acquireCameraStream(): Promise<MediaStream> {
  if (!isSecureCameraContext())
    throw new CameraAcquireError("insecure", "Câmera exige contexto seguro (HTTPS).");
  if (!navigator.mediaDevices?.getUserMedia)
    throw new CameraAcquireError(
      "unsupported",
      "getUserMedia indisponível. Use HTTPS ou navegador compatível.",
    );

  // Pré-checagem (alguns navegadores/WebViews não expõem a Permissions API p/ câmera).
  try {
    const perm = await navigator.permissions?.query({ name: "camera" as PermissionName });
    if (perm?.state === "denied")
      throw new CameraAcquireError("denied", "Permissão de câmera bloqueada no navegador/sistema.");
  } catch (e) {
    if (e instanceof CameraAcquireError) throw e; /* Permissions API ausente — segue */
  }

  const android = isAndroid();
  const ladder: (MediaTrackConstraints | true)[] = [
    { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } },
    {
      facingMode: { ideal: android ? "environment" : "user" },
      width: { ideal: 960 },
      height: { ideal: 540 },
    },
    true,
  ];

  let stream: MediaStream | null = null;
  let lastError: unknown = null;
  for (const video of ladder) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
      break;
    } catch (e) {
      lastError = e;
      const name = (e as DOMException)?.name;
      if (name === "OverconstrainedError" || name === "NotFoundError") continue; // tenta o próximo nível
      throw mapDom(e);
    }
  }
  if (!stream) throw mapDom(lastError);
  return stream;
}
