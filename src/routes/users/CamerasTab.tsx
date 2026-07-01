import { Button, Input, useToast } from "../../ui";
import { copyToClipboard } from "../../ui/clipboard";

type Props = {
  camToken: string | null;
};

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
    <section className="panel">
      <h3>Câmeras — link de enrolamento</h3>
      {enrollUrl ? (
        <div className="enroll">
          <Input readOnly value={enrollUrl} onFocus={(e) => e.currentTarget.select()} />
          <Button onClick={onCopyEnroll}>Copiar</Button>
          <p className="meta-text muted">
            Abra este link no dispositivo (celular/PC) que será a câmera — ele conecta sem login
            humano.
          </p>
        </div>
      ) : (
        <p className="meta-text muted">
          Defina <code>CAMERA_TOKEN</code> no hub (systemd) para gerar o link de enrolamento. Sem
          ele, a câmera usa a sessão de um usuário logado no mesmo navegador.
        </p>
      )}
    </section>
  );
}
