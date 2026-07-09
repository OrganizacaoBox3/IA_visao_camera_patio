import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Ruler } from "lucide-react";
import { useAuth } from "../auth";
import { APP_CONFIG } from "../config";
import { PageHeader, Field, Select, EmptyState, Alert } from "../ui";
import { CalibrationPanel } from "../camera/CalibrationPanel";
import type { Camera } from "./dashboard/types";

// Página de CALIBRAÇÃO de câmera (homografia) — LAR do CalibrationPanel, FORA do god-file
// CameraWorkspace e SEM Radix Dialog na casca fullscreen (ADR-007): é uma página normal do
// shell, então montar o painel aqui não remonta canvas/rAF de vídeo.
//
// Fluxo: escolher uma câmera → obter um FRAME ESTÁTICO dela → clicar 4 pontos do chão + metros.
// O quadro estático vem do snapshot JPEG do go2rtc (GET /go2rtc/api/frame.jpeg?src=<id>), o MESMO
// mecanismo que o motor de análise usa para puxar frames (server/analysis/go2rtc-source.js) e a
// busca de streams do painel (useVideoTransport). Só há snapshot quando o go2rtc serve a câmera
// (transporte WebRTC/auto); se falhar, o painel cai para a GRADE placeholder — o mapeamento
// clique→coordenada normalizada 0..1 continua correto, e a nota abaixo diz como alimentar um
// frame real.

// URL do snapshot JPEG do go2rtc para a câmera. Cache-buster p/ pegar um quadro fresco a cada seleção.
function snapshotUrlFor(cameraId: string, nonce: number): string {
  return `${APP_CONFIG.go2rtc.baseUrl}/api/frame.jpeg?src=${encodeURIComponent(cameraId)}&t=${nonce}`;
}

export function CalibrationPage() {
  const { token, canConfigure } = useAuth();

  // Câmeras conectadas (rótulos p/ o seletor) — socket só-para-a-lista, `watch({ids:[]})` = zero
  // vídeo nesta tela (mesmo padrão de /alarmes-saude).
  const [cams, setCams] = useState<Camera[]>([]);
  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socket.on("connect", () => socket.emit("watch", { ids: [] }));
    socket.on("cameras", (list: Camera[]) => setCams(Array.isArray(list) ? list : []));
    return () => {
      socket.disconnect();
    };
  }, [token]);

  const [selId, setSelId] = useState<string>("");
  // Snapshot resolvido: undefined enquanto probamos ou se falhar (o painel usa a grade placeholder).
  const [snapshot, setSnapshot] = useState<string | undefined>(undefined);
  const [probeFailed, setProbeFailed] = useState(false);
  const nonceRef = useRef(0);

  const selected = useMemo(() => cams.find((c) => c.id === selId), [cams, selId]);

  // Ao escolher a câmera, PROBA o snapshot do go2rtc via Image() (sem auth do app — o proxy do
  // go2rtc é separado, como em useVideoTransport). Carregou → usa a URL; falhou → placeholder.
  useEffect(() => {
    if (!selId) {
      setSnapshot(undefined);
      setProbeFailed(false);
      return;
    }
    const nonce = ++nonceRef.current;
    const url = snapshotUrlFor(selId, nonce);
    setSnapshot(undefined);
    setProbeFailed(false);
    const img = new Image();
    let dead = false;
    img.onload = () => {
      if (!dead && nonce === nonceRef.current) setSnapshot(url);
    };
    img.onerror = () => {
      if (!dead && nonce === nonceRef.current) setProbeFailed(true);
    };
    img.src = url;
    return () => {
      dead = true;
    };
  }, [selId]);

  const camOpts = useMemo(
    () => [
      { value: "", label: "Selecione uma câmera…" },
      ...cams.map((c) => ({ value: c.id, label: c.label || c.id })),
    ],
    [cams],
  );

  return (
    <div className="page">
      <PageHeader
        title="Calibração de câmera"
        subtitle="Meça distâncias reais no chão (metros) — base da posição por tag BLE."
      />

      <div className="flex flex-col gap-3 p-3">
        <Field label="Câmera">
          <Select
            ariaLabel="Câmera para calibrar"
            value={selId}
            onChange={setSelId}
            options={camOpts}
          />
        </Field>

        {!canConfigure && selId && (
          <Alert tone="info">
            A calibração requer perfil de engenharia. Você pode usar o modo <b>Medir</b> se a
            câmera já estiver calibrada.
          </Alert>
        )}

        {!selId ? (
          <EmptyState>
            <Ruler size={20} strokeWidth={1.5} aria-hidden />
            Escolha uma câmera para calibrar a distância no chão.
          </EmptyState>
        ) : (
          <>
            {probeFailed && (
              <Alert tone="warn">
                Sem quadro estático desta câmera (o go2rtc não a serve, ou está em MJPEG). Usando
                uma grade de referência: os cliques mapeiam corretamente, mas para calibrar sobre a
                imagem real habilite o transporte WebRTC da câmera (ou baixe um frame e sirva-o
                como snapshot).
              </Alert>
            )}
            {/* key força o painel a remontar (recarregar a calibração salva) ao trocar de câmera. */}
            <CalibrationPanel
              key={selId}
              cameraId={selId}
              label={selected?.label}
              canConfigure={canConfigure}
              snapshotUrl={snapshot}
              onClose={() => setSelId("")}
            />
          </>
        )}
      </div>
    </div>
  );
}
