import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { PageHeader } from "../ui";
import { getCameraEnroll } from "../api";
import { CamerasList } from "./cameras/IpCamerasSection";
import { LocalNodeSection } from "./cameras/LocalNodeSection";
import "./cameras.css";

// Tela de CÂMERAS (/cameras) — LAR ÚNICO das câmeras: cadastro/identidade E ajustes por câmera
// (papel/transporte). Substitui os botões "+ Nó de câmera" e "+ Câmera IP" do header da Central
// E o modal standalone "⚙ Câmeras" da Central (fim da fragmentação da config por-câmera):
//   • CamerasList: UMA listagem por câmera reconciliando as duas fontes (registro IP via
//     GET /api/cameras ∪ conectadas via socket) — antes eram DUAS seções que se sobrepunham
//     ("Câmeras IP / RTSP" + "Ajustes desta câmera"). Cada linha traz identidade + status +
//     ajustes (papel/vídeo, só p/ câmera conectada) + Editar/Remover (só IP, só superadmin).
//     Os controles de CRUD IP e o "+ Adicionar câmera IP" só aparecem ao superadmin (a API é
//     superadmin); os ajustes de câmera conectada seguem visíveis a todos (write-through degrada
//     em silêncio p/ operador). Ver a fronteira online×offline na própria CamerasList.
//   • Câmera local (webcam/nó): abrir o nó neste dispositivo + copiar o link de inscrição
//     (LocalNodeSection, compartilhada com a aba Câmeras de Usuários). É ONBOARDING de nó, não
//     listagem — por isso fica em seção à parte. O botão "abrir nó" é visível a todos; o link de
//     inscrição (token) só ao superadmin (`canEnroll`).

export function CamerasPage() {
  const { isSuper } = useAuth();

  // Token de enrolamento (CAMERA_TOKEN do hub) — endpoint superadmin; para os demais papéis
  // nem buscamos (o nó local ainda funciona pela sessão logada no mesmo navegador).
  const [camToken, setCamToken] = useState<string | null>(null);
  useEffect(() => {
    if (!isSuper) return;
    getCameraEnroll()
      .then((r) => setCamToken(r.token))
      .catch(() => {});
  }, [isSuper]);

  return (
    <div className="page">
      <PageHeader
        title="Câmeras"
        subtitle="Adicione e gerencie as câmeras da central — rede (IP/RTSP) ou webcam (nó local)."
      />
      <div className="cam-mgr-body">
        <CamerasList />
        <LocalNodeSection camToken={camToken} canEnroll={isSuper} />
      </div>
    </div>
  );
}
