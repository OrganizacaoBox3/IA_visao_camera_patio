// Aba "Zonas" do drawer da câmera — lista de zonas (cada uma com seu modo de IA + telemetria)
// e a legenda do overlay. Componente puro: recebe estado/handlers já resolvidos pelo CameraWorkspace.
//
// A PODA (spec-zona-unificada F5): o botão "Pintar área" saiu. A GEOMETRIA da zona se edita onde
// ela vive — NO PALCO, sobre o vídeo (selecionar → arrastar a forma/vértice · midpoint insere ·
// Delete remove) — e não numa grade de pincel de 32×18 que só sabia aproximar um polígono em
// escada. A máscara das zonas legadas continua sendo LIDA e desenhada; só não se autora mais.
import { type CSSProperties } from "react";
import { Settings2, Smartphone, X } from "lucide-react";
import { APP_CONFIG } from "../../config";
import { fmtDuration } from "../../format";
import { sensitivityFactor } from "../../processors/atividade";
import { objClass } from "../../objects/catalog";
import { ZONE_MODE_LABEL, type Zone } from "../../zones";
import { Alert, Badge, HelpTip, Kpi, Loading, SectionTitle, Tooltip } from "../../ui";
import { MetricCell } from "../../components/Sparkline";
import { restritaSummary, type LegendItem } from "../derive";
import { objectBackendNotice } from "../objectBackendNotice";
import type { ObjBackend } from "../../objects/detector";
import { RISK_LABEL, stateVar, type ZoneResult } from "../draw";
import {
  EAR_HI,
  NOREAD_BAND,
  RATE_BAND,
  OCC_BAND,
  OCC_HI,
  stateToMetric,
  rateToMetric,
  noReadMetric,
  occMetric,
  riskToMetric,
} from "../useTelemetry";
import { MODE_TONE, RISK_TONE } from "./tone";

// Amostra da legenda: o quadradinho fala o MESMO idioma do canvas — preenchimento sólido,
// hachura (área restrita armada), contorno tracejado (marcação sem leitura nova) e esmaecido
// (abaixo do limiar de confiança). Estilo INLINE porque a cor é DADO (token var(--state-*)); o
// CSS da página só conhece o tamanho do quadrado (.ws-legend .leg i — 10×10, box-sizing: border-box).
function swatchStyle(e: LegendItem): CSSProperties {
  switch (e.variant) {
    case "hatch": // mesma hachura diagonal do drawProibidaHatch, na escala do swatch
      return {
        backgroundImage: `repeating-linear-gradient(45deg, ${e.color} 0 1px, transparent 1px 4px)`,
        border: `1px dashed ${e.color}`,
      };
    case "dashed":
      return { background: "transparent", border: `2px dashed ${e.color}` };
    case "dim": // 0.3 = a MESMA atenuação que drawTracks aplica abaixo da confiança
      return { background: e.color, opacity: 0.3 };
    default:
      return { background: e.color };
  }
}

type Props = {
  zonesLoading: boolean;
  zones: Zone[];
  canConfigure: boolean;
  panel: Map<string, ZoneResult>;
  hist: (zoneId: string, key: string) => number[];
  legend: LegendItem[];
  setCfgZoneId: (id: string) => void;
  removeZone: (id: string) => void;
  // Detector do modo Objetos (singleton do cliente — objects/detector.ts), levado até aqui pelo
  // CameraWorkspace. Sem ele a contagem 0 é AMBÍGUA: "não tem caixa" × "o modelo nunca carregou".
  objBackend: ObjBackend;
};

export function ZonasTab({
  zonesLoading,
  zones,
  canConfigure,
  panel,
  hist,
  legend,
  setCfgZoneId,
  removeZone,
  objBackend,
}: Props) {
  return (
    <>
      {zonesLoading && <Loading label="Carregando zonas" />}
      {/* Prosa >1 linha vira HelpTip (regra de ouro): a tela mostra 1 linha; o resto mora no "?". */}
      {!zonesLoading && zones.length > 0 && canConfigure && (
        <p className="empty-note">
          Cada zona roda um modo de IA na sua área.{" "}
          {/* O modo que ALARMA (“Área restrita”) faltava nesta lista — era o único omitido, e
              justamente o único que dispara alarme crítico. Rótulos dos dois modos de exceção
              conforme o vocabulário do diálogo de configuração (CT-B). */}
          <HelpTip label="Ajuda das zonas">
            Modos: Atividade, Leitura, Objetos, Fadiga, “Ignorar área (sem alarme)” ou “Área
            restrita (gera alarme)”. Para trocar, use “Configurar zona” → Modo.
          </HelpTip>
        </p>
      )}
      {/* Texto load-bearing do e2e (drawZone, app.spec.ts): /Use “Área” para desenhar/. */}
      {!zonesLoading && zones.length === 0 && (
        <p className="empty-note">
          {canConfigure ? (
            <>
              Use “Área” para desenhar uma zona sobre o vídeo.{" "}
              <HelpTip label="Ajuda das zonas">
                Depois, em cada zona, “Configurar zona” → Modo define a IA (Atividade, Leitura,
                Objetos ou Fadiga).
              </HelpTip>
            </>
          ) : (
            "Nenhuma zona configurada. A edição de zonas requer perfil de engenharia."
          )}
        </p>
      )}
      {zones.map((z) => {
        const r = panel.get(z.id);
        const st = r?.modo === "atividade" ? r.view.state : "ATIVA";
        // Aviso do DETECTOR (só o modo Objetos tem detector próprio). `null` no caminho saudável
        // — o aviso não pode virar decoração permanente (ver objectBackendNotice.ts).
        const detAviso =
          z.modo === "objetos"
            ? objectBackendNotice(
                objBackend,
                z.selectedClasses,
                r?.modo === "objetos" ? r.peopleSource : "owlvit",
              )
            : null;
        return (
          <div key={z.id} className={`zone ${st}`}>
            <div className="row">
              <span className="zone-head">
                {/* title em dado, não affordance: .zone-name trunca (ellipsis) — o title
                    revela o VALOR completo do rótulo, não é dica de controle. */}
                <b className="zone-name" title={z.label}>
                  {z.label}
                </b>
                <Badge tone={MODE_TONE[z.modo]}>{ZONE_MODE_LABEL[z.modo]}</Badge>
              </span>
              <span className="zone-tools">
                <Tooltip
                  content={
                    canConfigure
                      ? "Configurar zona (modo e parâmetros)"
                      : "Configuração requer perfil de engenharia"
                  }
                >
                  <button
                    className="del"
                    disabled={!canConfigure}
                    aria-label="Configurar zona"
                    onClick={() => canConfigure && setCfgZoneId(z.id)}
                  >
                    <Settings2 size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                </Tooltip>
                <Tooltip
                  content={canConfigure ? "Remover zona" : "Remover requer perfil de engenharia"}
                >
                  <button
                    className="del"
                    disabled={!canConfigure}
                    aria-label="Remover zona"
                    onClick={() => canConfigure && removeZone(z.id)}
                  >
                    <X size={14} strokeWidth={1.75} aria-hidden />
                  </button>
                </Tooltip>
              </span>
            </div>

            {z.modo === "atividade" &&
              (r?.modo === "atividade" ? (
                (() => {
                  const ms = stateToMetric(r.view.state);
                  const activeThr = sensitivityFactor(z.sensitivity) / 6; // limiar ATIVA em unidades de view.motion
                  return (
                    <>
                      {/* estado/parada: indicadores categóricos/temporais (átomo Kpi). O estado é
                          TEXTO longo, não número: mantém o papel `body` (--fs-body, era .kpi-state)
                          via valueStyle — a única via do átomo p/ ajustar o `.v`; a cor é o token de
                          estado (stateVar → var(--state-*)). */}
                      <div className="kpis ws-kpis">
                        <Kpi
                          value={r.view.state}
                          label="estado"
                          valueStyle={{ color: stateVar(r.view.state), fontSize: "var(--fs-body)" }}
                        />
                        <Kpi value={fmtDuration(r.view.idleMs)} label="parada" />
                      </div>
                      {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                      <MetricCell
                        label="Movimento"
                        value={`${Math.round(r.view.motion * 100)}%`}
                        values={hist(z.id, "motion")}
                        band={{ lo: activeThr, hi: 1 }}
                        bandLabel="alvo: zona ativa"
                        state={ms}
                        min={0}
                        max={1}
                      />
                      <MetricCell
                        label="Ocupação"
                        value={`${r.view.people}`}
                        values={hist(z.id, "people")}
                        band={OCC_BAND}
                        bandLabel={`alvo 1–${OCC_HI} pessoas`}
                        state={occMetric(r.view.people)}
                        min={0}
                      />
                      <div className="zone-flow">
                        <span>Fluxo</span>
                        {/* Badge no lugar do flow-chip estático, preservando a COR ATUAL do nível
                            (going-gray: Alto=ok/verde, Médio=warn, Baixo=neutro — ver index.css). */}
                        <Badge
                          tone={
                            r.view.flowLevel === "Alto"
                              ? "ok"
                              : r.view.flowLevel === "Médio"
                                ? "warn"
                                : undefined
                          }
                        >
                          {r.view.flowLevel}
                        </Badge>
                        <span className="spark">
                          {r.view.flow.map((s, i) => (
                            <i key={i} style={{ height: `${Math.max(6, Math.round(s * 100))}%` }} />
                          ))}
                        </span>
                      </div>
                    </>
                  );
                })()
              ) : (
                <p className="ws-wait">iniciando…</p>
              ))}

            {z.modo === "leitura" &&
              (r?.modo === "leitura" ? (
                <>
                  {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                  <MetricCell
                    label="Taxa de leitura"
                    value={`${r.ratePct}%`}
                    values={hist(z.id, "rate")}
                    band={RATE_BAND}
                    bandLabel="alvo ≥ 95%"
                    state={rateToMetric(r.ratePct)}
                    min={0}
                    max={100}
                  />
                  <MetricCell
                    label="Lidas/min"
                    value={`${r.perMin}`}
                    values={hist(z.id, "perMin")}
                    min={0}
                  />
                  <MetricCell
                    label="No-reads"
                    value={`${r.noReads}`}
                    values={hist(z.id, "noReads")}
                    band={NOREAD_BAND}
                    bandLabel="alvo 0"
                    state={noReadMetric(r.noReads)}
                    min={0}
                  />
                  <div className="ws-code">
                    <span className="muted">último código</span>
                    <code>{r.lastCode ?? "—"}</code>
                  </div>
                  <div className="ws-metric-row">
                    Ponto <b>{z.ponto}</b> · {r.passes} passagens
                  </div>
                </>
              ) : (
                <p className="ws-wait">iniciando…</p>
              ))}

            {z.modo === "objetos" && (
              <>
                {/* ANTES do número, não depois: quem lê "0" já leu por que o 0 pode não ser
                    observação. Tom = token de estado que JÁ existe (going gray — modelo caído É
                    anormalidade); nenhum número sobre a imagem, o aviso vive no painel. */}
                {detAviso && (
                  <Alert tone={detAviso.tone}>
                    <span>
                      {detAviso.text}{" "}
                      <HelpTip label="Ajuda do detector de objetos">{detAviso.help}</HelpTip>
                    </span>
                  </Alert>
                )}
                <div className="ws-counts">
                  {z.selectedClasses.length === 0 && (
                    <span className="muted">nenhuma classe — use “Configurar zona”</span>
                  )}
                  {z.selectedClasses.map((k) => {
                    const o = objClass(k);
                    const n = r?.modo === "objetos" ? (r.counts[k] ?? 0) : 0;
                    return (
                      // title em dado, não affordance: o chip mostra emoji + contagem; o title
                      // revela o VALOR (rótulo da classe). O emoji vem do CATÁLOGO (é dado do
                      // domínio, não ícone de UI — por isso não vira Lucide): fica aria-hidden e
                      // o rótulo textual da classe entra sr-only, para o chip não informar só por
                      // emoji/cor (going-gray + regra 11).
                      <span
                        key={k}
                        className={`count-chip ${n > 0 ? "on" : ""}`}
                        style={n > 0 ? { borderColor: o?.color, color: o?.color } : undefined}
                        title={o?.label}
                      >
                        <span aria-hidden>{o?.emoji}</span>
                        <span className="sr-only">{o?.label ?? k}:</span> <b>{n}</b>
                      </span>
                    );
                  })}
                </div>
                {/* telemetria: total em cena com tendência (sem faixa-alvo fixa — depende da cena) */}
                <MetricCell
                  label="Total em cena"
                  value={`${r?.modo === "objetos" ? r.total : 0}`}
                  values={hist(z.id, "total")}
                  min={0}
                />
              </>
            )}

            {z.modo === "fadiga" && (
              <>
                <div className="ws-fadiga">
                  {r?.modo === "fadiga" && r.faceState === "ready" ? (
                    <>
                      <Badge tone={RISK_TONE[r.risk]}>{RISK_LABEL[r.risk]}</Badge>
                      <span className="muted ws-phone">
                        <Smartphone size={12} strokeWidth={1.75} aria-hidden /> celular:{" "}
                        {r.phone ? "sim" : "não"}
                      </span>
                    </>
                  ) : (
                    <span className="muted">
                      {r?.modo === "fadiga"
                        ? r.faceState === "loading"
                          ? "carregando modelo…"
                          : "modelo falhou"
                        : "iniciando…"}
                    </span>
                  )}
                </div>
                {r?.modo === "fadiga" && r.faceState === "ready" && (
                  /* telemetria "nunca número cru": EAR com faixa-alvo (olhos abertos) */
                  <MetricCell
                    label="EAR (abertura ocular)"
                    value={r.ear == null ? "--" : r.ear.toFixed(2)}
                    values={hist(z.id, "ear")}
                    band={{ lo: APP_CONFIG.fadiga.eyesClosedEarThreshold, hi: EAR_HI }}
                    bandLabel={`alvo ≥ ${APP_CONFIG.fadiga.eyesClosedEarThreshold.toFixed(2)}`}
                    state={riskToMetric(r.risk)}
                    min={0}
                    max={EAR_HI}
                  />
                )}
                <p className="empty-note zone-note">
                  Monitora 1 operador na área da zona.{" "}
                  <HelpTip label="Ajuda da fadiga">
                    A análise roda só no recorte desta zona. Som e calibração ficam na câmera
                    dedicada (tipo Operador/fadiga).
                  </HelpTip>
                </p>
              </>
            )}

            {z.modo === "exclusao" && (
              <p className="empty-note zone-note">
                Pessoas nesta área são ignoradas.{" "}
                <HelpTip label="Ajuda da exclusão">
                  Ignorar área (sem alarme). Máscara de supressão: quem está com o pé na área não
                  conta nem é rastreado. A zona não gera indicador.
                </HelpTip>
              </p>
            )}

            {/* ÁREA RESTRITA: espelha o bloco da exclusão — o único modo que ALARMA era o único
                SEM linha explicativa aqui. O dwell e a janela de armamento só existiam dentro do
                diálogo; agora a lista DIZ em texto quando esta área dispara (restritaSummary,
                testado em derive.test.ts — inclusive o fail-open de "sem turno atribuído"). */}
            {z.modo === "proibida" && (
              <p className="empty-note zone-note">
                {restritaSummary(z)}{" "}
                <HelpTip label="Ajuda da área restrita">
                  Área restrita (gera alarme): a área deve ficar VAZIA. Presença contínua acima do
                  limite dispara alarme crítico; quem só atravessa não dispara. O alarme é produzido
                  pelo motor do hub (24/7, sem painel aberto) — câmera sem o motor não gera este
                  alerta. Limite e janela ficam em “Configurar zona”.
                </HelpTip>
              </p>
            )}
          </div>
        );
      })}
      {legend.length > 0 && (
        <div className="ws-legend">
          {/* Seção interna com heading SEMÂNTICO (<h2> do SectionTitle). A classe legada
              `ws-legend-title` fica: é CSS de página (unlayered) e vence as utilities do átomo —
              o visual não muda, e o seletor não vira órfão (G6). */}
          <SectionTitle flush className="ws-legend-title">
            Legenda do overlay{" "}
            {/* A AÇÃO por trás de cada canal: os dois estados da marcação pedem coisas
                DIFERENTES do operador, e antes nada dizia isso. */}
            <HelpTip label="Ajuda da legenda">
              A marcação da pessoa usa dois canais independentes: o CONTORNO tracejado significa que
              ela está sendo sustentada sem leitura nova (verifique câmera, rede ou carga do hub); a
              OPACIDADE mede a confiança da detecção (ajuste em Exibição → “Confiança mínima”).
            </HelpTip>
          </SectionTitle>
          <div className="ws-legend-items">
            {legend.map((e, i) => (
              <span key={i} className="leg">
                <i style={swatchStyle(e)} />
                {e.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
