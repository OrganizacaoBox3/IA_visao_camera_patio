// Indicador de SERVIDOR no cabeçalho da Central — consumo de processamento e o que está sendo
// analisado, sempre visível, sem clique.
//
// POR QUE AQUI E NÃO SÓ NO RELATÓRIO. O SaudeMotorPanel já traduz a saúde do motor, mas mora no
// Relatório, sob `canConfigure` e dentro de um acordeão fechado. Para diagnosticar está certo;
// para a pergunta de operação — "o servidor está dando conta agora?" — está enterrado: o dono
// pediu essa informação e não a encontrou na interface. Este é o recorte de OPERAÇÃO; o painel
// do Relatório segue dono do detalhe e da análise, e aqui nada dele é repetido.
//
// O QUE MOSTRA, e por que só isto: processamento do pool, custo de uma análise, quantas câmeras
// analisando e quantas paradas por falta de turno. NÃO mostra load average nem RAM — servem a
// quem dimensiona a máquina, não a quem opera o pátio, e cabeçalho com seis números não é lido.
//
// A DECISÃO (nível, e quais números podem ser afirmados) é PURA e testada em servidorResumo.ts.
// Aqui só sobra buscar e desenhar.
//
// LGPD: só números; nenhuma imagem passa por aqui.
import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { getAnalysisStatus, type AnalysisStatus } from "../../api";
import { Tooltip } from "../../ui";
import { servidorResumo } from "./servidorResumo";

// 15s: acompanha afogamento sem virar polling agressivo. A janela dos números do hub é de 60s,
// então amostrar mais rápido não traz informação nova.
const REFRESH_MS = 15_000;

export function ServidorIndicador() {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [erro, setErro] = useState(false);

  useEffect(() => {
    let vivo = true;
    const carregar = () =>
      getAnalysisStatus()
        .then((s) => {
          if (!vivo) return;
          setStatus(s);
          setErro(false);
        })
        .catch(() => {
          if (!vivo) return;
          // Falhou → o indicador diz "não sei". Manter o último número bom na tela como se fosse
          // atual é o falso-OK da casa (servidorResumo garante o silêncio numérico).
          setErro(true);
          setStatus(null);
        });
    carregar();
    const id = window.setInterval(carregar, REFRESH_MS);
    return () => {
      vivo = false;
      window.clearInterval(id);
    };
  }, []);

  const r = servidorResumo(status, erro);
  if (!r) return null; // primeira carga: nada, em vez de número inventado

  if (r.manchete)
    return (
      <Tooltip
        content={
          r.nivel === "down"
            ? "O motor de análise não está rodando: nenhuma pessoa está sendo detectada e nenhum alerta sai."
            : "Não foi possível consultar o servidor. O estado real pode ser diferente do que a tela mostrou por último."
        }
      >
        <span className="srv-ind" data-level={r.nivel}>
          <Cpu size={14} strokeWidth={1.75} aria-hidden />
          {r.manchete}
        </span>
      </Tooltip>
    );

  return (
    <Tooltip
      content={
        `Processamento do motor: ${r.cpu === null ? "não medido" : `${r.cpu}% (100% = um núcleo inteiro)`}` +
        `${r.inferMs === null ? "" : ` · cada análise leva ${Math.round(r.inferMs)}ms`}` +
        `${r.paradas > 0 ? ` · ${r.paradas} câmera(s) cadastrada(s) SEM TURNO: não estão sendo analisadas e não geram alerta` : ""}`
      }
    >
      <span className="srv-ind" data-level={r.nivel}>
        <Cpu size={14} strokeWidth={1.75} aria-hidden />
        <span className="srv-ind__item">
          <b>{r.cpu === null ? "—" : `${r.cpu}%`}</b> cpu
        </span>
        {r.inferMs !== null && (
          <span className="srv-ind__item">
            <b>{Math.round(r.inferMs)}ms</b>/análise
          </span>
        )}
        <span className="srv-ind__item">
          <b>{r.analisando}</b> analisando
        </span>
        {r.paradas > 0 && (
          <span className="srv-ind__item srv-ind__alerta">
            <b>{r.paradas}</b> sem turno
          </span>
        )}
      </span>
    </Tooltip>
  );
}
