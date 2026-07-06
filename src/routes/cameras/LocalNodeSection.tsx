import { Link } from "react-router-dom";
import { Button, Input, FieldLabel, HelpTip, useToast, SectionTitle } from "../../ui";
import { copyToClipboard } from "../../ui/clipboard";

// Seção "Câmera local (webcam / nó)" — fonte ÚNICA da UI de nó local: abrir o nó neste
// dispositivo + copiar o link de inscrição (token do hub). Consumida pela tela /cameras
// (CamerasPage, tela cheia) e pela aba Câmeras de Usuários (CamerasTab, `compact`). Antes
// duplicada nos dois — a lógica de enroll/copy vivia em dois lugares (dívida anotada).
//
// O token (CAMERA_TOKEN) é buscado pelo PAI (page-level) e chega por prop: /cameras faz o
// próprio fetch; a aba Usuários recebe do UsersPage. Aqui só derivamos a URL e copiamos.

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
      {/* Prosa-manual (~39 palavras) virou tooltip "?" — a superfície fica só com o título,
          a ação e o link de inscrição (hierarquia de ajuda: label → tooltip; nunca parágrafo). */}
      <div className="cam-sec-head">
        <SectionTitle flush>Câmera local (webcam)</SectionTitle>
        <HelpTip label="Sobre a câmera local">
          Qualquer dispositivo com navegador e webcam (PC, celular) vira uma câmera da central. A
          análise roda no próprio navegador — nenhuma imagem fica gravada no servidor.
        </HelpTip>
      </div>

      {!compact && (
        <div className="cam-node-actions">
          <Button asChild variant="primary">
            <a href={nodeUrl} target="_blank" rel="noreferrer">
              Abrir nó neste dispositivo
            </a>
          </Button>
        </div>
      )}

      {canEnroll &&
        (enrollUrl ? (
          <div className="cam-enroll">
            <span className="cam-enroll__label">
              <FieldLabel htmlFor="cam-enroll-url">Link de inscrição</FieldLabel>
              <HelpTip label="Como usar o link de inscrição">
                Abra este link no dispositivo (celular/PC) que será a câmera — ele conecta sem
                login.
              </HelpTip>
            </span>
            <Input
              id="cam-enroll-url"
              readOnly
              aria-label="Link de inscrição da câmera"
              value={enrollUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button onClick={onCopyEnroll}>Copiar link de inscrição</Button>
          </div>
        ) : (
          // Sem token no hub: fórmula status + causa/ação; o detalhe de infra (CAMERA_TOKEN)
          // saiu da superfície — vira tooltip técnico (o bloco é superadmin-only).
          <p className="muted m-0">
            Link de inscrição indisponível neste servidor.{" "}
            <HelpTip label="Como habilitar o link de inscrição">
              O administrador define CAMERA_TOKEN no serviço do hub para gerar o link. Sem ele, o
              nó usa a sessão de um usuário logado neste navegador.
            </HelpTip>
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
