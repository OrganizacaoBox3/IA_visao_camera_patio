// N1b — "as contagens estão sendo feitas?" (a faixa de SAÚDE DO MOTOR, logo abaixo da saúde do
// alarme). Consumidor do /api/analysis/status, que o hub servia desde o ADR-009 e que NINGUÉM no
// front lia: a auditoria achou o dado inteiro sem consumidor. Até aqui, motor DESLIGADO, worker
// morrendo em loop, gate cegando a câmera e banco caído se pareciam todos com "0 pessoas".
//
// AS QUATRO DECISÕES DESTE ARQUIVO:
//
// 1. ONDE MORA (descobribilidade). NÃO virou rota nova — rota sem entrada na navegação é
//    exatamente o código morto que a auditoria encontrou. Mora no Relatório, colada na faixa de
//    saúde do alarme, pelo MESMO argumento que pôs aquela no topo: se o detector está inundando,
//    todo número abaixo é suspeito; se o MOTOR está parado, todo número abaixo é suspeito por
//    outra via. As duas respondem "posso confiar no que vou ler?" — e é a única tela do produto
//    cuja razão de existir são os números que o motor produz.
// 2. QUEM VÊ (RBAC). O ACHADO é de todo mundo; o NÚMERO CRU é de quem configura. "Motor desligado,
//    nada está sendo gravado" muda a confiança do operador no número que ele está lendo agora —
//    esconder isso dele seria construir o falso-OK de propósito. Já fps/cpu/respawn/p95 não
//    informam decisão nenhuma de operação: ficam num detalhe técnico sob `canConfigure`
//    (engenheiro/superadmin), do mesmo lado do gate que já protege N5.
// 3. RELÓGIO PRÓPRIO, ESTADO LOCAL. Como o AlarmHealthStrip, o estado vive DENTRO deste
//    componente: o tick do polling não sobe para o ReportPage e não repinta o corpo histórico
//    embaixo do gestor. E o carimbo de escala é explícito ("agora · janela de 1 min") — esta
//    faixa NÃO obedece ao filtro de período, e diz isso na cara.
// 4. GOING-GRAY. Saudável = pílula neutra e NENHUMA lista. Cor saturada só em anormalidade real
//    (âmbar p/ ressalva, vermelho p/ falha e p/ DESCONHECIDO — porque desconhecido não é bom).
//
// LGPD: só números/metadados; nenhuma imagem passa por aqui.
import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Info,
  OctagonAlert,
  TriangleAlert,
} from "lucide-react";
import { Button, SectionTitle, StatusDot, Table, Tooltip } from "../../ui";
import {
  getAnalysisStatus,
  getConnectedCameras,
  type AnalysisStatus,
  type ConnectedCamera,
} from "../../api";
import {
  buildEngineHealth,
  type EngineHealth,
  type Finding,
  type HealthLevel,
} from "./engineHealth";
import "./engine-health.css";

// Cadência do polling. 20s é o ponto onde o CUSTO some e a informação continua fresca: os
// sensores *1m do hub são janela de 60s (amostrar a 5s só repetiria a mesma janela) e os campos
// instantâneos que importam — motor ligado, worker pronto — mudam em escala de segundos, não de
// milissegundos. CUSTO DECLARADO: 3 requisições/min por aba aberta do Relatório (2 rotas ⇒ 6
// chamadas/min), payload de poucos KB, e do lado do hub é montagem PURA sobre estado em memória
// (server/analysis/telemetry.js) — sem I/O, sem banco. Efeito colateral deliberado do endpoint:
// ele PODA o gateLog ao medir, então consultar mais vezes mantém o log mais enxuto, nunca o
// contrário.
const REFRESH_MS = 20_000;

const LEVEL_DOT: Record<HealthLevel, "neutral" | "warn" | "critical"> = {
  ok: "neutral", // going-gray: normalidade NÃO acende verde
  warn: "warn",
  down: "critical",
  unknown: "critical", // desconhecido ≠ bom — e não pode parecer calmo
};

function FindingIcon({ level }: { level: Finding["level"] }) {
  const P = { size: 14, strokeWidth: 1.75, "aria-hidden": true } as const;
  if (level === "down") return <OctagonAlert {...P} />;
  if (level === "warn") return <TriangleAlert {...P} />;
  return <Info {...P} />;
}

const LEVEL_WORD: Record<Finding["level"], string> = {
  down: "falha",
  warn: "atenção",
  info: "informação",
};

// IDADE DO QUADRO → nível de estado. "Going gray" (ADR-003): neutro é o normal, cor só para
// ANORMALIDADE — daí o default `undefined` (sem data-level = sem cor).
//
// ⚠ LIMIARES ESCOLHIDOS, NÃO MEDIDOS EM CAMPO. 200/400 ms é o que se espera de uma LAN com
// go2rtc local; o número honesto sai da primeira campanha com câmera real (a coluna existe
// justamente para produzi-lo). Já a TENDÊNCIA é qualitativa e não depende de calibração: idade
// que sobe ao longo da janela é FILA acumulando, e isso é defeito em qualquer piso — por isso
// ela é `critical` enquanto o valor absoluto é só `warn`.
export function frameAgeLevel(a: { p50: number; p90: number; trend: number }): string | undefined {
  if (a.trend >= 250) return "down"; // fila: o atraso está CRESCENDO, não só alto
  if (a.p50 > 200 || a.p90 > 400) return "warn";
  return undefined;
}

export function SaudeMotorPanel({ canConfigure }: { canConfigure: boolean }) {
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [cameras, setCameras] = useState<ConnectedCamera[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (cancelled: () => boolean) => {
    // allSettled DE PROPÓSITO: as duas rotas falham por motivos diferentes e a saúde do motor
    // não pode sumir porque a LISTA DE CÂMERAS caiu — o que se perde nesse caso é só o
    // cruzamento "online na central × invisível para o motor", e `crossChecked` declara a perda.
    const [s, c] = await Promise.allSettled([getAnalysisStatus(), getConnectedCameras()]);
    if (cancelled()) return;
    if (s.status === "fulfilled") {
      setStatus(s.value);
      setError(null);
    } else {
      // Payload velho NÃO segura a tela: com a consulta falhando, o estado é DESCONHECIDO.
      setStatus(null);
      setError(s.reason instanceof Error ? s.reason.message : "Falha ao consultar o motor.");
    }
    setCameras(c.status === "fulfilled" ? c.value.cameras : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let dead = false;
    const cancelled = () => dead;
    void load(cancelled);
    const id = window.setInterval(() => void load(cancelled), REFRESH_MS);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, [load]);

  // Primeira carga: "ainda não sei" não pode ser desenhado como resultado — nem bom, nem ruim.
  if (loading && !status && !error)
    return (
      <section className="eh-strip" aria-label="Saúde do motor de análise" data-level="loading">
        <span className="eh-loading">Consultando a saúde do motor…</span>
      </section>
    );

  return (
    <EngineHealthView
      health={buildEngineHealth({ status, error, cameras })}
      status={status}
      canConfigure={canConfigure}
    />
  );
}

// A VISTA, separada da busca de propósito: ela é PURA em relação à rede e por isso pode ser
// renderizada num teste (SaudeMotorPanel.test.tsx) para provar o que NÃO aparece na tela quando o
// estado é ruim. "Não estou medindo" não pode ser renderizado como resultado.
export function EngineHealthView({
  health: h,
  status,
  canConfigure,
}: {
  health: EngineHealth;
  status: AnalysisStatus | null;
  canConfigure: boolean;
}) {
  const [detail, setDetail] = useState(false);
  return (
    <section className="eh-strip" aria-label="Saúde do motor de análise" data-level={h.level}>
      <header className="eh-head">
        <SectionTitle flush>As contagens estão sendo feitas?</SectionTitle>
        {/* O carimbo da escala: esta faixa não obedece ao filtro de período do relatório. */}
        <span className="eh-now">
          <StatusDot color="var(--state-neutral-fg)" label="ao vivo" /> agora · janela de 1 min ·
          atualiza a cada {Math.round(REFRESH_MS / 1000)}s
        </span>
      </header>

      <div className="eh-verdict">
        <span className="eh-verdict__icon" data-level={h.level}>
          {h.level === "unknown" ? (
            <CircleHelp size={18} strokeWidth={1.75} aria-hidden />
          ) : h.level === "down" ? (
            <OctagonAlert size={18} strokeWidth={1.75} aria-hidden />
          ) : h.level === "warn" ? (
            <TriangleAlert size={18} strokeWidth={1.75} aria-hidden />
          ) : (
            <Activity size={18} strokeWidth={1.75} aria-hidden />
          )}
        </span>
        <div className="eh-verdict__text">
          {/* Nunca só-por-cor: o nível vai por ícone + palavra + texto, não pela borda. */}
          <p className="eh-verdict__headline">
            <StatusDot tone={LEVEL_DOT[h.level]} label={`estado: ${h.level}`} /> {h.headline}
          </p>
          <p className="eh-verdict__meaning">{h.meaning}</p>
        </div>
      </div>

      {h.findings.length > 0 && (
        <ul className="eh-findings" aria-label="O que está acontecendo com o motor">
          {h.findings.map((f) => (
            <li className="eh-finding" data-level={f.level} key={f.id}>
              <span className="eh-finding__icon" aria-hidden>
                <FindingIcon level={f.level} />
              </span>
              <div className="eh-finding__body">
                <p className="eh-finding__what">
                  <span className="sr-only">{LEVEL_WORD[f.level]}: </span>
                  {f.camera && <span className="eh-finding__cam">{f.camera}</span>}
                  {f.what}
                </p>
                {/* A metade que faz a linha valer: o que isso faz com o dado do operador. */}
                <p className="eh-finding__so">{f.soWhat}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Cruzamento indisponível é uma PERDA DE COBERTURA declarada, não um silêncio. */}
      {!h.crossChecked && h.level !== "unknown" && (
        <p className="eh-note">
          A lista de câmeras da central não respondeu: uma câmera que esteja online e invisível para
          o motor não seria detectada nesta consulta.
        </p>
      )}

      {/* RBAC: o número cru não decide operação — fica com quem configura (ver decisão 2). */}
      {canConfigure && status && (
        <div className="eh-detail">
          <Button variant="ghost" onClick={() => setDetail((v) => !v)} aria-expanded={detail}>
            {detail ? (
              <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
            )}
            Detalhe técnico
          </Button>
          {detail && <TechDetail status={status} />}
        </div>
      )}
    </section>
  );
}

// ── Detalhe técnico (canConfigure) — aqui os números CRUS são bem-vindos: quem lê isto está
// diagnosticando, não operando. Nada aqui é manchete; tudo aqui é evidência. ─────────────────
function TechDetail({ status }: { status: AnalysisStatus }) {
  const w = status.worker;
  const as = status.autoscale;
  const ids = Object.keys(status.perCamera).sort();
  return (
    <div className="eh-tech">
      <ul className="eh-tech__globals">
        <li>
          <b>modelo</b> {status.model}
          {as
            ? ` · tier ${String(as.tier ?? "—").toUpperCase()} (${as.mode}${as.pin ? `:${as.pin}` : ""})`
            : ""}
        </li>
        {as && (
          <li>
            <b>autoscale</b> afogado {as.choked} · folgado {as.idle}
          </li>
        )}
        {w && (
          <li>
            <b>workers</b> {w.readyCount}/{w.size} prontos · cpu {w.cpuPct}% · respawns {w.respawns}
          </li>
        )}
        <li>
          <b>cadência</b> normal {status.targetFps} · linha {status.lineFps} · foco{" "}
          {status.focusFps} fps
        </li>
        <li>
          <Tooltip content="Rodadas de inferência puladas pelo filtro de movimento em 60s (todas as câmeras). Pular cena PARADA é economia; o que vira aviso é pular com gente andando.">
            <span>
              <b>gate</b> {status.motionGate.enabled ? "ligado" : "DESLIGADO"} · limiar{" "}
              {status.motionGate.ratio} · pulos/60s {status.motionGate.skipped1m}
            </span>
          </Tooltip>
        </li>
        {status.go2rtcPull && (
          <li>
            <b>go2rtc</b> {status.go2rtcPull.active ? "ativo" : "inativo"} ·{" "}
            {status.go2rtcPull.streams} streams · {status.go2rtcPull.streaming ?? 0} puxando
          </li>
        )}
      </ul>

      <Table
        ariaLabel="Detalhe técnico por câmera"
        minWidth={620}
        columns={[
          { label: "Câmera", className: "w-full" },
          { label: "fps / alvo", className: "whitespace-nowrap text-right" },
          { label: "fila", className: "text-right" },
          { label: "última (ms)", className: "whitespace-nowrap text-right" },
          { label: "idade p50/p90", className: "whitespace-nowrap text-right" },
          { label: "pulos 60s", className: "whitespace-nowrap text-right" },
          { label: "cegos 60s", className: "whitespace-nowrap text-right" },
          { label: "ratio p50/p95", className: "whitespace-nowrap text-right" },
          { label: "pessoas 60s", className: "whitespace-nowrap text-right" },
        ]}
      >
        <tbody>
          {ids.map((id) => {
            const c = status.perCamera[id];
            return (
              <tr key={id}>
                <td>
                  {id}
                  {c.fadiga && <span className="eh-tech__tag">operador</span>}
                  {c.focused && <span className="eh-tech__tag">foco</span>}
                  {c.source === "go2rtc" && <span className="eh-tech__tag">go2rtc</span>}
                </td>
                <td className="text-right">
                  {c.fps} / {c.targetFps}
                </td>
                <td className="text-right">{c.queue}</td>
                <td className="text-right">{c.lastMs}</td>
                <td className="text-right">
                  {c.frameAge ? (
                    <span className="eh-age" data-level={frameAgeLevel(c.frameAge)}>
                      {c.frameAge.p50} / {c.frameAge.p90}
                      {c.frameAge.trend > 0 ? ` ↑${c.frameAge.trend}` : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-right">{c.skipped1m}</td>
                <td className="text-right">{c.gate ? c.gate.skipMoving1m : "—"}</td>
                <td className="text-right">
                  {c.gate ? `${c.gate.ratioP50} / ${c.gate.ratioP95}` : "—"}
                </td>
                <td className="text-right">{c.dets1m}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
