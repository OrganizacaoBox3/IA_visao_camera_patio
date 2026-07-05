import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../../config";
import { useAuth } from "../../auth";
import { Select, SectionTitle } from "../../ui";
import { getCameraCfg, setCameraCfg, type CameraCfg } from "../../cameraConfig";
import { type Camera } from "../dashboard/types";

// "Ajustes desta câmera" — LAR ÚNICO do papel (área × operador/fadiga) e do transporte de
// VÍDEO NO PAINEL (MJPEG × WebRTC) por câmera. Antes esses dois controles viviam no modal
// standalone "⚙ Câmeras" da Central (fragmentação: config por-câmera em 3 telas); agora ficam
// aqui, junto do cadastro/identidade das câmeras (um só lar, como o veredito de avaliação pediu).
// Lê/grava o camcfg pelo MESMO caminho do modal (getCameraCfg/setCameraCfg — write-through no
// backend + cache local offline); RBAC preservado: para operador o PUT degrada em silêncio e só
// o cache local guarda a escolha (idêntico ao comportamento do modal, que era visível a todos).
//
// FRONTEIRA — quais câmeras aparecem: TODAS as CONECTADAS à central (evento socket `cameras`),
// não só as IP/RTSP cadastradas — inclui nós locais (webcam). É a MESMA lista que a grade da
// Central usa. Para isso abre um socket `role:"dashboard"` só para receber a lista e emite
// `watch({ ids: [] })` no connect: sai da room legada e NÃO recebe `frame` (zero relé de vídeo
// nesta tela). Câmera que não está conectada não aparece aqui (o camcfg dela é aplicado quando
// ela reconecta e entra na grade).

export function CameraSettingsSection() {
  const { token } = useAuth();
  const [cameras, setCameras] = useState<Camera[]>([]);
  // Espelho local do camcfg por câmera (setCameraCfg persiste; este estado reflete no mesmo tick).
  const [cfgs, setCfgs] = useState<Record<string, CameraCfg>>({});
  const socketRef = useRef<Socket | null>(null);

  // Socket só-para-a-lista: role "dashboard" recebe o snapshot `cameras` no connect e as mudanças
  // (câmera entra/sai). `watch({ ids: [] })` blinda contra o relé de frames (sai da dash-legacy).
  useEffect(() => {
    const socket = io(APP_CONFIG.net.serverUrl, {
      transports: ["websocket"],
      auth: { token },
      query: { role: "dashboard" },
    });
    socketRef.current = socket;
    socket.on("connect", () => {
      socket.emit("watch", { ids: [] }); // sem vídeo aqui — só a lista de câmeras
    });
    socket.on("cameras", (list: Camera[]) => setCameras(list));
    return () => {
      socket.disconnect();
    };
  }, [token]);

  // Garante uma cfg carregada por câmera (default = atividade/mjpeg → retrocompatível).
  useEffect(() => {
    setCfgs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of cameras)
        if (!next[c.id]) {
          next[c.id] = getCameraCfg(c.id);
          changed = true;
        }
      return changed ? next : prev;
    });
  }, [cameras]);

  function cfgOf(id: string): CameraCfg {
    return cfgs[id] ?? getCameraCfg(id);
  }
  function setKind(id: string, fadiga: boolean) {
    setCfgs((prev) => {
      const merged: CameraCfg = { ...cfgOf(id), modo: fadiga ? "fadiga" : "atividade" };
      setCameraCfg(id, merged);
      return { ...prev, [id]: merged };
    });
  }
  function setTransport(id: string, transport: CameraCfg["transport"]) {
    setCfgs((prev) => {
      const merged: CameraCfg = { ...cfgOf(id), transport };
      setCameraCfg(id, merged);
      return { ...prev, [id]: merged };
    });
  }

  return (
    <section className="panel" aria-label="Ajustes por câmera">
      <SectionTitle>Ajustes desta câmera</SectionTitle>
      <p className="muted cam-sec-hint">
        Papel e vídeo no painel de cada câmera <b>conectada</b> (IP/RTSP ou nó local).{" "}
        <b>Câmera de área</b> (padrão): vista geral do setor — abra a câmera na Central e desenhe
        zonas, cada uma com seu modo (Atividade / Leitura / Objetos / Fadiga).{" "}
        <b>Operador (fadiga)</b>: câmera dedicada apontada ao rosto de 1 operador — só monitora
        fadiga, sem zonas.
      </p>

      {cameras.length === 0 ? (
        <p className="empty-note">
          Nenhuma câmera conectada. Adicione uma câmera IP/RTSP ou abra um nó local acima; ela
          aparece aqui assim que conectar à central.
        </p>
      ) : (
        <div className="cam-list">
          {cameras.map((c) => {
            const cfg = cfgOf(c.id);
            const isFadiga = cfg.modo === "fadiga";
            const transport = cfg.transport; // "auto" (padrão) | "mjpeg" | "webrtc"
            return (
              <div key={`cset-${c.id}`} className="cam-row cam-set-row">
                <div className="cam-row__name">
                  <b>{c.label}</b>
                  <span className="muted">{c.id}</span>
                </div>
                <div className="cam-set-controls">
                  <Select
                    value={isFadiga ? "fadiga" : "area"}
                    onChange={(v) => setKind(c.id, v === "fadiga")}
                    ariaLabel="Tipo da câmera"
                    options={[
                      { value: "area", label: "Câmera de área (zonas)" },
                      { value: "fadiga", label: "Operador (fadiga)" },
                    ]}
                  />
                  {/* Transporte do VÍDEO NO PAINEL (go2rtc). Rótulo desambiguado do `transport`
                      tcp/udp do RTSP (no cadastro IP acima) — aquele é do ffmpeg. "Automático" (padrão)
                      = melhor disponível; MJPEG/WebRTC são OVERRIDES manuais (escape hatch). */}
                  <Select
                    value={transport}
                    onChange={(v) => setTransport(c.id, v as CameraCfg["transport"])}
                    ariaLabel="Vídeo no painel"
                    options={[
                      { value: "auto", label: "Vídeo no painel: Automático (melhor disponível)" },
                      { value: "mjpeg", label: "Vídeo no painel: MJPEG" },
                      { value: "webrtc", label: "Vídeo no painel: WebRTC" },
                    ]}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="muted cam-set-note">
        <b>Automático</b> (padrão) = melhor disponível: usa WebRTC (vídeo fluido via go2rtc) quando o
        go2rtc serve a câmera e cai para MJPEG (frames do relé) quando não — sem configurar nada.
        <b> MJPEG</b> e <b>WebRTC</b> forçam um transporte fixo (override manual).
      </p>
    </section>
  );
}
