// ─────────────────────────────────────────────────────────────────────────────
// AutomaskReview.tsx — a CORREÇÃO do operador sobre a auto-máscara (server/analysis/automask.js).
//
// O motor já aprende sozinho: presença ~100% do tempo + bbox quase parado por janelas longas =
// provável manequim/foto/TV/boneco lido como "pessoa", e some SOZINHO da contagem (modo "hide").
// Este painel é o operador CORRIGINDO essa inferência com um clique, nos dois sentidos:
//   "Está correto"     → é gente de verdade (ex.: guarda parado num posto) — nunca suprimir.
//   "É falso positivo" → confirma objeto fixo AGORA, sem esperar a confirmação estatística.
//
// LGPD (ADR-002): nenhum frame é mostrado aqui. A posição vem como retângulo NORMALIZADO — o
// operador vê ONDE (percentual do quadro), não uma foto da cena.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { Button, Badge, Loading } from "../../ui";
import { getAutomask, setAutomaskDecision, type AutomaskSuggestion } from "../../api";

function posicao(s: AutomaskSuggestion): string {
  const cx = Math.round((s.x + s.w / 2) * 100);
  const cy = Math.round((s.y + s.h / 2) * 100);
  return `~${cx}%, ${cy}%`;
}

export function AutomaskReview({
  cameraId,
  cameraLabel,
  canDecide,
}: {
  cameraId: string;
  cameraLabel: string;
  /** Sem permissão de configurar, o painel mostra mas não deixa decidir (mesmo gate do resto da tela). */
  canDecide: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [sugestoes, setSugestoes] = useState<AutomaskSuggestion[] | null>(null);
  const [erro, setErro] = useState(false);
  const [decidindo, setDecidindo] = useState<number | null>(null); // cell em voo

  useEffect(() => {
    if (!aberto) return;
    let morto = false;
    setCarregando(true);
    setErro(false);
    getAutomask(cameraId)
      .then((s) => {
        if (!morto) setSugestoes(s.suggestions);
      })
      .catch(() => {
        if (!morto) setErro(true);
      })
      .finally(() => {
        if (!morto) setCarregando(false);
      });
    return () => {
      morto = true;
    };
  }, [cameraId, aberto]);

  async function decidir(cell: number, decision: "correto" | "falsoPositivo") {
    setDecidindo(cell);
    try {
      await setAutomaskDecision(cameraId, cell, decision);
      // Reflete a decisão localmente — evita um round-trip só p/ pintar o botão marcado.
      setSugestoes((cur) => (cur || []).map((s) => (s.cell === cell ? { ...s, decision } : s)));
    } catch {
      /* o toast global de erro de rede já cobre; o botão volta ao estado normal abaixo */
    } finally {
      setDecidindo(null);
    }
  }

  const pendentes = (sugestoes || []).filter((s) => s.decision === null);

  return (
    <div className="cam-set-field">
      <Button size="sm" onClick={() => setAberto((v) => !v)}>
        {aberto ? "Ocultar" : "Revisar"} detecções fixas
        {sugestoes && pendentes.length > 0 && (
          <span style={{ marginLeft: 6 }}>
            <Badge tone="warn">{pendentes.length}</Badge>
          </span>
        )}
      </Button>
      {aberto && (
        <div className="automask-review" role="region" aria-label={`Detecções fixas de ${cameraLabel}`}>
          {carregando && <Loading label="Carregando detecções fixas…" />}
          {erro && <span className="muted">Não foi possível carregar as detecções desta câmera.</span>}
          {!carregando && !erro && sugestoes && sugestoes.length === 0 && (
            <span className="muted">
              Nenhuma detecção fixa aprendida ainda. O motor precisa de ~10min de uma célula parada
              para sugerir algo aqui.
            </span>
          )}
          {!carregando &&
            !erro &&
            sugestoes &&
            sugestoes.map((s) => (
              <div key={s.cell} className="automask-review__row">
                <span>
                  Objeto parado em {posicao(s)} — presente {Math.round(s.presentPct * 100)}% do tempo
                  {s.decision && (
                    <span style={{ marginLeft: 6 }}>
                      <Badge tone={s.decision === "correto" ? "info" : "ok"}>
                        {s.decision === "correto" ? "marcado como pessoa real" : "confirmado falso positivo"}
                      </Badge>
                    </span>
                  )}
                </span>
                {canDecide && (
                  <span className="automask-review__actions">
                    <Button
                      size="sm"
                      disabled={decidindo === s.cell}
                      onClick={() => decidir(s.cell, "correto")}
                    >
                      Está correto
                    </Button>
                    <Button
                      size="sm"
                      disabled={decidindo === s.cell}
                      onClick={() => decidir(s.cell, "falsoPositivo")}
                    >
                      É falso positivo
                    </Button>
                  </span>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
