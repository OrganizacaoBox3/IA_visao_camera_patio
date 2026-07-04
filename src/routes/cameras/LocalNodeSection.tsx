import { Link } from "react-router-dom";
import { Button, Input, useToast } from "../../ui";
import { copyToClipboard } from "../../ui/clipboard";

// Seção "Câmera local (webcam / nó)" — fonte ÚNICA da UI de nó local: abrir o nó neste
// dispositivo + copiar o link de inscrição (token do hub). Consumida pela tela /cameras
// (CamerasPage, tela cheia) e pela aba Câmeras de Usuários (CamerasTab, `compact`). Antes
// duplicada nos dois — a lógica de enroll/copy vivia em dois lugares (dívida anotada).
//
// O token (CAMERA_TOKEN) é buscado pelo PAI (page-level) e chega por prop: /cameras faz o
// próprio fetch; a aba Usuários recebe do UsersPage. Aqui só derivamos a URL e copiamos.

// Título de seção: h2 semântico com o visual do `.panel h3` (padrão da casa).
// TODO(A1): trocar por <SectionTitle> de src/ui quando o átomo existir.
const H2_SEC =
  "m-0 mb-3 font-bold uppercase tracking-[0.12em] text-text-muted text-[length:var(--fs-label,11px)]";

type Props = {
  // Token de enrolamento do hub (CAMERA_TOKEN). null = sem token configurado.
  camToken: string | null;
  // Pode ver/copiar o link de inscrição (token): na /cameras é o superadmin; na aba Usuários
  // (já superadmin-only) fica true. Espelha o gate `isSuper` do bloco de enroll original.
  canEnroll?: boolean;
  // Layout compacto da aba Usuários: sem a intro nem o botão "Abrir nó" (foco no link),
  // e com a nota apontando a gestão completa em /cameras. Default: tela cheia.
  compact?: boolean;
};

export function LocalNodeSection({ camToken, canEnroll = true, compact = false }: Props) {
  const { toast } = useToast();

  // Com token, o nó local abre autenticado por dispositivo (?key=); sem token, o /camera usa a
  // sessão do usuário logado neste navegador (comportamento do antigo "+ Nó de câmera").
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
    <section
      className={compact ? "panel max-w-[640px]" : "panel"}
      aria-label="Câmera local (webcam / nó)"
    >
      <h2 className={H2_SEC}>Câmera local (webcam / nó)</h2>

      {!compact && (
        <>
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
        </>
      )}

      {canEnroll &&
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
              Abra este link no dispositivo (celular/PC) que será a câmera — ele conecta sem login
              humano.
            </p>
          </div>
        ) : (
          <p className="muted">
            Defina <code>CAMERA_TOKEN</code> no hub (systemd) para gerar o link de inscrição de
            outros dispositivos. Sem ele, a câmera usa a sessão de um usuário logado no mesmo
            navegador.
          </p>
        ))}

      {compact && (
        <p className="muted mb-0 mt-3">
          A gestão completa de câmeras (IP/RTSP e nó local) fica na tela{" "}
          <Link to="/cameras">Câmeras</Link>.
        </p>
      )}
    </section>
  );
}
