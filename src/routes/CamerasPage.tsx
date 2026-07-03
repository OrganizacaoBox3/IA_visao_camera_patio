import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { PageHeader, Button, Input, EmptyState, useToast } from "../ui";
import { copyToClipboard } from "../ui/clipboard";
import { getCameraEnroll } from "../api";
import { IpCamerasSection } from "./cameras/IpCamerasSection";
import "./cameras.css";

// Tela de CÂMERAS (/cameras) — ação única de "adicionar câmera" (substitui os botões
// "+ Nó de câmera" e "+ Câmera IP" que viviam no header da Central):
//   • Câmeras IP/RTSP: CRUD completo (IpCamerasSection) — SÓ superadmin, como era o
//     "+ Câmera IP" (a API /api/cameras é superadmin); os demais papéis veem a nota de acesso.
//   • Câmera local (webcam/nó): abrir o nó neste dispositivo + copiar o link de inscrição
//     p/ outro dispositivo — equivalente ao antigo "+ Nó de câmera" (visível a todos).
//
// DÍVIDA (anotada de propósito): a UI do link de inscrição duplica src/routes/users/CamerasTab.tsx
// (aba Câmeras de Usuários, mantida pela spec). Ao mexer de novo, extrair um componente comum.
export function CamerasPage() {
  const { isSuper } = useAuth();
  const { toast } = useToast();

  // Token de enrolamento (CAMERA_TOKEN do hub) — endpoint superadmin; para os demais papéis
  // nem buscamos (o nó local ainda funciona pela sessão logada no mesmo navegador).
  const [camToken, setCamToken] = useState<string | null>(null);
  useEffect(() => {
    if (!isSuper) return;
    getCameraEnroll()
      .then((r) => setCamToken(r.token))
      .catch(() => {});
  }, [isSuper]);

  // Com token, o próprio nó local abre autenticado por dispositivo (?key=); sem token, o /camera
  // usa a sessão do usuário logado neste navegador (comportamento do antigo "+ Nó de câmera").
  const enrollUrl = camToken
    ? `${location.origin}/camera?key=${encodeURIComponent(camToken)}`
    : null;
  const nodeUrl = enrollUrl ?? `${location.origin}/camera`;

  async function onCopyEnroll() {
    if (!enrollUrl) return;
    const ok = await copyToClipboard(enrollUrl);
    toast(
      ok ? "Link copiado." : "Não foi possível copiar. Selecione o link e copie manualmente.",
      ok ? "ok" : "alert",
    );
  }

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
            <h3>Câmeras IP / RTSP</h3>
            <EmptyState>
              O cadastro de câmeras IP/RTSP é restrito ao administrador (superadmin).
            </EmptyState>
          </section>
        )}

        <section className="panel" aria-label="Câmera local (webcam / nó)">
          <h3>Câmera local (webcam / nó)</h3>
          <p className="muted cam-sec-hint">
            Qualquer dispositivo com navegador e webcam (PC, celular) vira uma câmera: abra a
            página do nó e ele entra na central automaticamente. A IA roda no próprio navegador —
            nenhuma imagem é enviada ao servidor além dos frames do relé.
          </p>
          <div className="cam-node-actions">
            <Button asChild variant="primary">
              <a href={nodeUrl} target="_blank" rel="noreferrer">
                Abrir nó neste dispositivo
              </a>
            </Button>
          </div>
          {isSuper &&
            (enrollUrl ? (
              <div className="cam-enroll">
                <Input
                  readOnly
                  aria-label="Link de inscrição da câmera"
                  value={enrollUrl}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button onClick={onCopyEnroll}>Copiar link de inscrição</Button>
                <p className="muted">
                  Abra este link no dispositivo (celular/PC) que será a câmera — ele conecta sem
                  login humano.
                </p>
              </div>
            ) : (
              <p className="muted">
                Defina <code>CAMERA_TOKEN</code> no hub (systemd) para gerar o link de inscrição
                de outros dispositivos. Sem ele, a câmera usa a sessão de um usuário logado no
                mesmo navegador.
              </p>
            ))}
        </section>
      </div>
    </div>
  );
}
