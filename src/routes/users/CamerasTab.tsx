import { Link } from "react-router-dom";
import { Button, Input, useToast } from "../../ui";
import { copyToClipboard } from "../../ui/clipboard";

// Título de seção: h2 semântico com o visual do `.panel h3` (padrão da casa).
// TODO(A1): trocar por <SectionTitle> de src/ui quando o átomo existir.
const H2_SEC =
  "m-0 mb-3 font-bold uppercase tracking-[0.12em] text-text-muted text-[length:var(--fs-label,11px)]";

type Props = {
  camToken: string | null;
};

// Card curto e denso: só o link de inscrição do nó de câmera. A gestão completa vive em
// /cameras (dívida de duplicação anotada lá — CamerasPage) e é apontada aqui de forma visível.
export function CamerasTab({ camToken }: Props) {
  const { toast } = useToast();
  const enrollUrl = camToken
    ? `${location.origin}/camera?key=${encodeURIComponent(camToken)}`
    : null;

  async function onCopyEnroll() {
    if (!enrollUrl) return;
    const ok = await copyToClipboard(enrollUrl);
    toast(
      ok ? "Link copiado." : "Não foi possível copiar. Selecione o link e copie manualmente.",
      ok ? "ok" : "alert",
    );
  }

  return (
    <section className="panel max-w-[640px]">
      <h2 className={H2_SEC}>Câmeras — link de enrolamento</h2>
      {enrollUrl ? (
        <div className="enroll">
          <Input
            readOnly
            aria-label="Link de enrolamento da câmera"
            value={enrollUrl}
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button onClick={onCopyEnroll}>Copiar</Button>
          <p className="muted">
            Abra este link no dispositivo (celular/PC) que será a câmera — ele conecta sem login
            humano.
          </p>
        </div>
      ) : (
        <p className="muted">
          Defina <code>CAMERA_TOKEN</code> no hub (systemd) para gerar o link de enrolamento. Sem
          ele, a câmera usa a sessão de um usuário logado no mesmo navegador.
        </p>
      )}
      <p className="muted mb-0 mt-3">
        A gestão completa de câmeras (IP/RTSP e nó local) fica na tela{" "}
        <Link to="/cameras">Câmeras</Link>.
      </p>
    </section>
  );
}
