// Indicador de SERVIDOR no rodapé do menu lateral — consumo de processamento e o que está
// sendo analisado, visível em TODA a plataforma, sem clique.
//
// POR QUE NO MENU E NÃO NA CENTRAL. Primeiro foi para o cabeçalho da Central e o dono apontou o
// óbvio: trocava de tela e sumia. O consumo do servidor não é assunto de uma página — é estado
// do sistema, e o lar de estado global é o shell. Fica no `rail`, que persiste em toda rota.
//
// POR QUE NÃO NO RELATÓRIO (histórico da decisão). O SaudeMotorPanel traduz a saúde do motor com
// mais profundidade, mas mora no Relatório, sob `canConfigure` e num acordeão FECHADO: para
// diagnosticar está certo, para "o servidor está dando conta agora?" está enterrado — o dono
// pediu essa informação e não a encontrou. Este é o recorte de operação; o painel segue dono do
// detalhe e nada dele é repetido aqui.
//
// O QUE MOSTRA: processamento (hub + inferência), custo de uma análise, quantas câmeras
// analisando e quantas paradas por falta de turno. NÃO mostra load average nem RAM — servem a
// quem dimensiona a máquina, não a quem opera o pátio.
//
// A DECISÃO (nível e quais números podem ser afirmados) é PURA e testada em servidorResumo.ts.
// Aqui só sobra buscar e desenhar.
//
// LGPD: só números; nenhuma imagem passa por aqui.
import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { getAnalysisStatus, type AnalysisStatus } from "../../api";
import { Tooltip } from "../../ui";
import { servidorResumo, type ServidorResumo } from "./servidorResumo";
import "./servidor-rail.css";

// 15s: acompanha afogamento sem virar polling agressivo. A janela dos números do hub é de 60s,
// então amostrar mais rápido não traria informação nova.
const REFRESH_MS = 15_000;

/** Frase única do tooltip — serve aos dois layouts (rail estreito e expandido). */
function descricao(r: ServidorResumo): string {
  if (r.nivel === "down")
    return "O motor de análise não está rodando: nenhuma pessoa está sendo detectada e nenhum alerta sai.";
  if (r.nivel === "unknown")
    return "Não foi possível consultar o servidor. O estado real pode ser diferente do último número mostrado.";
  return (
    `Processamento: ${r.cpu === null ? "não medido" : `${r.cpu}% (100% = um núcleo inteiro; soma do hub com a inferência, sem o go2rtc)`}` +
    `${r.inferMs === null ? "" : ` · cada análise leva ${Math.round(r.inferMs)}ms`}` +
    ` · ${r.analisando} câmera(s) sendo analisada(s)` +
    `${r.paradas > 0 ? ` · ${r.paradas} cadastrada(s) SEM TURNO: não são analisadas e não geram alerta` : ""}`
  );
}

export function ServidorIndicador({ iconOnly = false }: { iconOnly?: boolean }) {
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

  // Rail estreito / mobile: sobra o essencial — ícone, o nível pela cor e a CPU. O resto vive no
  // tooltip. Um rail de 52px não cabe quatro números, e cortar texto seria pior que resumir.
  if (iconOnly)
    return (
      <Tooltip content={descricao(r)}>
        <div className="srv-rail srv-rail--min" data-level={r.nivel} aria-label={descricao(r)}>
          <Cpu size={16} strokeWidth={1.75} aria-hidden />
          <span className="srv-rail__min-num">
            {r.nivel === "down" || r.nivel === "unknown" || r.cpu === null ? "—" : `${Math.round(r.cpu)}%`}
          </span>
        </div>
      </Tooltip>
    );

  return (
    <Tooltip content={descricao(r)}>
      <div className="srv-rail" data-level={r.nivel} aria-label={descricao(r)}>
        <div className="srv-rail__head">
          <Cpu size={14} strokeWidth={1.75} aria-hidden />
          servidor
        </div>
        {r.manchete ? (
          <div className="srv-rail__manchete">{r.manchete}</div>
        ) : (
          <>
            <div className="srv-rail__linha">
              <b>{r.cpu === null ? "—" : `${Math.round(r.cpu)}%`}</b> processamento
            </div>
            {r.inferMs !== null && (
              <div className="srv-rail__linha">
                <b>{Math.round(r.inferMs)}ms</b> por análise
              </div>
            )}
            <div className="srv-rail__linha">
              <b>{r.analisando}</b> analisando
            </div>
            {r.paradas > 0 && (
              <div className="srv-rail__linha srv-rail__alerta">
                <b>{r.paradas}</b> sem turno
              </div>
            )}
          </>
        )}
      </div>
    </Tooltip>
  );
}
