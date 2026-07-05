// Aba "Timeline" do drawer da câmera — lista de eventos da sessão (alertas de zona,
// cruzamentos de linha). Componente puro: recebe os itens já resolvidos pelo CameraWorkspace.
import { clock } from "../../format";

export type TimelineItem = { id: number; ts: number; text: string; sev: "info" | "warn" | "high" };

export function TimelineTab({ timeline }: { timeline: TimelineItem[] }) {
  if (timeline.length === 0)
    return (
      <p className="empty-note">
        Sem eventos nesta sessão. Alertas de zona e cruzamentos de linha aparecem aqui em tempo real.
      </p>
    );
  return (
    <ul className="tl">
      {timeline.map((e) => (
        <li key={e.id}>
          <span className={`dot ${e.sev}`} />
          <span className="t">{clock(new Date(e.ts))}</span>
          <span>{e.text}</span>
        </li>
      ))}
    </ul>
  );
}
