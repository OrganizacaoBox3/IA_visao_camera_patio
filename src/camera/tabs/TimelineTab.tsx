// Aba "Timeline" do drawer da câmera — lista de eventos da sessão (alertas de zona,
// cruzamentos de linha). Componente puro: recebe os itens já resolvidos pelo CameraWorkspace.
import { Info, OctagonAlert, TriangleAlert } from "lucide-react";
import { clock } from "../../format";

export type TimelineItem = { id: number; ts: number; text: string; sev: "info" | "warn" | "high" };

// Severidade NUNCA só-por-cor (going-gray, doutrina regra 1): cada nível tem FORMA própria
// (ícone Lucide) + nome acessível. A cor vem dos tokens de estado (cine.css: .tl .sev.*).
const SEV: Record<TimelineItem["sev"], { Icon: typeof Info; label: string }> = {
  info: { Icon: Info, label: "Informativo" },
  warn: { Icon: TriangleAlert, label: "Atenção" },
  high: { Icon: OctagonAlert, label: "Alta severidade" },
};

export function TimelineTab({ timeline }: { timeline: TimelineItem[] }) {
  if (timeline.length === 0)
    return (
      <p className="empty-note">
        Sem eventos nesta sessão. Alertas de zona e cruzamentos de linha aparecem aqui em tempo real.
      </p>
    );
  return (
    <ul className="tl" aria-label="Eventos da sessão">
      {timeline.map((e) => {
        const { Icon, label } = SEV[e.sev];
        return (
          <li key={e.id}>
            <Icon className={`sev ${e.sev}`} size={12} strokeWidth={1.75} aria-label={label} />
            <span className="t">{clock(new Date(e.ts))}</span>
            <span>{e.text}</span>
          </li>
        );
      })}
    </ul>
  );
}
