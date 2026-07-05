import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { PageHeader, EmptyState } from "../ui";
import { getCameraEnroll } from "../api";
import { IpCamerasSection } from "./cameras/IpCamerasSection";
import { LocalNodeSection } from "./cameras/LocalNodeSection";
import { CameraSettingsSection } from "./cameras/CameraSettingsSection";
import "./cameras.css";

// Tela de CÂMERAS (/cameras) — LAR ÚNICO das câmeras: cadastro/identidade E ajustes por câmera
// (papel/transporte). Substitui os botões "+ Nó de câmera" e "+ Câmera IP" do header da Central
// E o modal standalone "⚙ Câmeras" da Central (fim da fragmentação da config por-câmera):
//   • Câmeras IP/RTSP: CRUD completo (IpCamerasSection) — SÓ superadmin, como era o
//     "+ Câmera IP" (a API /api/cameras é superadmin); os demais papéis veem a nota de acesso.
//   • Câmera local (webcam/nó): abrir o nó neste dispositivo + copiar o link de inscrição
//     (LocalNodeSection, compartilhada com a aba Câmeras de Usuários — a antiga dívida de
//     duplicação foi extraída para um componente único). O botão "abrir nó" é visível a todos;
//     o link de inscrição (token) só ao superadmin (`canEnroll`).
//   • Ajustes desta câmera: papel (área × fadiga) e vídeo no painel (MJPEG × WebRTC) por câmera
//     CONECTADA (CameraSettingsSection) — o antigo modal "⚙ Câmeras", agora incorporado aqui.

// Título de seção: h2 semântico com o visual do `.panel h3` (padrão da casa).
// TODO(A1): trocar por <SectionTitle> de src/ui quando o átomo existir.
const H2_SEC =
  "m-0 mb-3 font-bold uppercase tracking-[0.12em] text-text-muted text-[length:var(--fs-label,11px)]";

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
        {isSuper ? (
          <IpCamerasSection />
        ) : (
          <section className="panel" aria-label="Câmeras IP / RTSP">
            <h2 className={H2_SEC}>Câmeras IP / RTSP</h2>
            <EmptyState>
              O cadastro de câmeras IP/RTSP é restrito ao administrador (superadmin).
            </EmptyState>
          </section>
        )}

        <LocalNodeSection camToken={camToken} canEnroll={isSuper} />

        {/* Ajustes por câmera (papel/transporte) — incorporado do antigo modal "⚙ Câmeras" da
            Central. Visível a todos os papéis, como o modal era (o write-through degrada em
            silêncio p/ operador; ver CameraSettingsSection). */}
        <CameraSettingsSection />
      </div>
    </div>
  );
}
