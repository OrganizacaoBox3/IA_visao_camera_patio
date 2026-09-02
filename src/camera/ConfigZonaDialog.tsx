// ── Diálogo de configuração de zona (modo + parâmetros) ──────────────────────
// Extraído do CameraWorkspace.tsx (R3) SEM mudança de comportamento. É JSX PURO
// controlado por props: não toca em canvas/rAF/refs. O componente pai continua
// dono do estado da zona (patchZone/changeZoneMode) e de quando abrir/fechar
// (cfgZoneId). A carga do histórico p/ a previsão de alertas/dia (histState/
// histDataset) segue no pai — aqui só a renderização.
import { useEffect, useState } from "react";
import { APP_CONFIG } from "../config";
import { fmtLimit } from "../format";
import { ACTIVITIES } from "../processors/atividade";
import { predictAlertsPerDay } from "../report/predict";
import { type Dataset } from "../report/mock";
import { OBJECT_CATALOG } from "../objects/catalog";
import {
  DEFAULT_PRESENCA_ALERT_MS,
  DEFAULT_OCCUPANCY_TOLERANCE_MS,
  PRESENCA_ALERT_PRESETS_MS,
  ZONE_ARMINGS,
  ZONE_ARMING_LABEL,
  polygonBBox,
  type Zone,
  type ZoneArming,
  type ZoneMode,
} from "../zones";
import { VertexTable } from "./VertexTable";
import { getShifts, type Shift } from "../api";
import { Button, Input, Select, Slider, Switch, ToggleGroup, Dialog, Field } from "../ui";

// RÓTULOS (CT-B). Os VALORES gravados são contrato e NÃO mudam
// (atividade|leitura|objetos|fadiga|exclusao|proibida seguem idênticos no camcfg e no motor);
// muda só o texto exibido. "Exclusão" × "Proibida" eram a mesma palavra na cabeça de quem
// escolhe — o próprio dono do produto descreveu a exclusão como "a função que impede o operador
// de entrar na área", que é EXATAMENTE o outro modo. O rótulo agora carrega o efeito
// (alarma / não alarma) no ponto da escolha, não na explicação que só aparece depois.
// Mesmas strings no drawer e na legenda (superfície única do produto).
// Gate: ConfigZonaDialog.test.ts.
export const MODO_OPTS: { value: ZoneMode; label: string }[] = [
  { value: "atividade", label: "Atividade" },
  { value: "leitura", label: "Leitura" },
  { value: "objetos", label: "Objetos" },
  { value: "fadiga", label: "Fadiga" },
  { value: "exclusao", label: "Ignorar área (sem alarme)" },
  { value: "proibida", label: "Área restrita (gera alarme)" },
];
// Explicação por modo, visível ao selecionar — o usuário não escolhe mais às cegas.
// REGRA (gate no teste): toda descrição declara ONDE RODA. Sem isso o operador supõe que tudo
// é 24/7 (a de "proibida" se gabava do hub e, por contraste, deixava as outras ambíguas) —
// leitura/objetos/fadiga rodam SÓ no navegador, com aquela câmera aberta na tela: o motor do
// hub descarta tudo que não é `person` (server/analysis/pipeline.js).
export const MODO_DESC: Record<ZoneMode, string> = {
  atividade:
    "Movimento/ociosidade + contagem de pessoas na área (padrão). Roda no motor do hub, 24/7 — continua valendo com o painel fechado.",
  leitura:
    "Lê código de barras/QR dentro da zona — desenhe-a sobre a esteira/etiqueta. Roda no NAVEGADOR: só lê enquanto esta câmera estiver aberta na tela; painel fechado, nada é lido.",
  objetos:
    "Conta as classes escolhidas (caixa, palete…) — modelo pesado, o 1º uso demora. Roda no NAVEGADOR: só conta enquanto esta câmera estiver aberta na tela; painel fechado, nada é contado.",
  fadiga:
    "Rosto/mãos de 1 operador na zona — p/ câmera dedicada use Câmeras → Ajustes desta câmera → Operador (fadiga). Roda no NAVEGADOR: só monitora enquanto esta câmera estiver aberta na tela; painel fechado, nada é monitorado.",
  exclusao:
    "A câmera finge que esta área não existe: pessoa aqui não conta, não rastreia e NÃO dispara alarme nenhum. Use sobre grade, placa, TV ou janela escura de van. Vale no hub (24/7) e na tela — em nenhum dos dois ela alarma.",
  proibida:
    "Área que deve ficar VAZIA: pessoa parada aqui acima do limite dispara ALARME crítico. Roda no motor do hub, 24/7 — alarma com o painel fechado.",
};
// ── COBERTURA DO QUADRO (medidor da zona de exclusão) ────────────────────────
/**
 * Fração do QUADRO (0..1) que esta zona subtrai — em coordenadas normalizadas 0..1 a área da
 * geometria JÁ É a fração do quadro (shoelace, sem escala nenhuma).
 *
 * NÃO é uma aproximação da forma: é a MESMA geometria que o hub rasteriza em
 * `buildMotionIgnore` (server/analysis/engine.js) — polígono (`points`) quando existe, senão a
 * bbox `x/y/w/h` INTEIRA (o hub é conservador e ignora o bbox todo das zonas sem polígono, e a
 * máscara de pincel é legada). Logo o número exibido é a área realmente ignorada.
 *
 * PONTO CEGO DECLARADO: mede UMA zona. O diálogo só recebe a zona aberta — a cobertura TOTAL da
 * câmera (união das zonas de exclusão, sobreposição contada uma vez) exigiria prop nova vinda do
 * workspace e ficou de fora. Polígono auto-interceptante (fora do contrato "polígono SIMPLES")
 * sub-mede; o clamp abaixo só garante 0..1.
 */
export function zoneFrameCoverage(z: Pick<Zone, "x" | "y" | "w" | "h" | "points">): number {
  const clamp01 = (v: number) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
  const pts = z.points;
  if (pts && pts.length >= 3) {
    let dobro = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
      dobro += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
    return clamp01(Math.abs(dobro) / 2);
  }
  const w = Number.isFinite(z.w) ? z.w : 0;
  const h = Number.isFinite(z.h) ? z.h : 0;
  return clamp01(Math.abs(w * h));
}

// Limiar de DESTAQUE do aviso: heurística de UI, não um degrau medido — o gate de movimento
// degrada de forma CONTÍNUA com a área ignorada (não há joelho). Serve só para que uma zona
// que come 1/5 do quadro não passe despercebida.
const EXCLUSAO_COBERTURA_ALERTA = 0.2;
const fmtCobertura = (frac: number) =>
  frac > 0 && frac < 0.01 ? "<1%" : `${Math.round(frac * 100)}%`;

// ── TURNOS (spec-turnos-por-zona F2) ─────────────────────────────────────────
// A zona só CADASTRA a atribuição (ids); QUEM RESOLVE turno/pausa/borda é o servidor
// (shift-clock + alarm/shift) — o front nunca calcula janela. Sem turno selecionado a
// zona é 24/7 (default seguro = comportamento de hoje). A validação de SOBREPOSIÇÃO
// também é do servidor (PUT /api/zones rejeita com 400): aqui só se escolhe, e o erro
// do save vem por toast do CameraWorkspace.
const DIA_ABREV = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
function fmtJanela(s: Shift): string {
  const vira = s.fim <= s.inicio ? " +1 dia" : ""; // D2: fim ≤ início ⇒ termina no dia seguinte
  const dias = [...s.dias].sort((a, b) => a - b).map((d) => DIA_ABREV[d] ?? "?");
  return `${s.inicio}–${s.fim}${vira} · ${dias.join(", ")}`;
}

function TurnosField({
  zone,
  shifts,
  state,
  patchZone,
  hint,
}: {
  zone: Zone;
  shifts: Shift[];
  state: "loading" | "ready" | "error";
  patchZone: (id: string, patch: Partial<Zone>) => void;
  hint: string;
}) {
  return (
    <Field label="Turnos desta área" hint={hint}>
      {state === "loading" && <span className="muted">carregando turnos…</span>}
      {state === "error" && (
        <span className="muted">turnos indisponíveis — a área segue monitorada 24/7</span>
      )}
      {state === "ready" &&
        (shifts.length === 0 ? (
          <p className="empty-note">
            Nenhum turno cadastrado. Cadastre em <b>Turnos</b> (menu de administração) para poder
            atribuí-los a esta área.
          </p>
        ) : (
          <ToggleGroup
            type="multiple"
            className="ws-cfg ws-chips"
            ariaLabel="Turnos desta área"
            value={zone.shiftIds ?? []}
            onValueChange={(vals) => patchZone(zone.id, { shiftIds: vals })}
            items={shifts.map((s) => ({
              value: s.id,
              label: (
                <>
                  {s.nome} <span className="muted">{fmtJanela(s)}</span>
                </>
              ),
              ariaLabel: `${s.nome} ${fmtJanela(s)}`,
            }))}
          />
        ))}
    </Field>
  );
}

type Props = {
  zone: Zone | null; // cfgZone (null → diálogo fechado)
  histState: "idle" | "loading" | "ready" | "error";
  histDataset: Dataset | null;
  onClose: () => void;
  patchZone: (id: string, patch: Partial<Zone>) => void;
  changeZoneMode: (z: Zone, next: ZoneMode) => void;
};

export function ConfigZonaDialog({
  zone,
  histState,
  histDataset,
  onClose,
  patchZone,
  changeZoneMode,
}: Props) {
  // Cadastro de turnos (GET /api/shifts) — carga única por câmera aberta; falha degrada para
  // "indisponível" (a zona segue 24/7, nada quebra).
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [shiftsState, setShiftsState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let vivo = true;
    getShifts()
      .then((list) => {
        if (!vivo) return;
        setShifts(list.filter((s) => s.ativo !== false));
        setShiftsState("ready");
      })
      .catch(() => {
        if (vivo) setShiftsState("error");
      });
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <Dialog
      open={!!zone}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={zone ? `Configurar — ${zone.label}` : "Configurar zona"}
      description="Ajuste o modo e os parâmetros desta zona. As mudanças valem na hora."
      footer={
        <Button active onClick={onClose}>
          Concluir
        </Button>
      }
    >
      {zone &&
        (() => {
          const z = zone;
          return (
            <div className="cfg-form">
              <Field label="Nome da zona" htmlFor={`cfg-name-${z.id}`}>
                <Input
                  id={`cfg-name-${z.id}`}
                  value={z.label}
                  onChange={(e) => patchZone(z.id, { label: e.target.value })}
                />
              </Field>
              <Field label="Modo" hint={MODO_DESC[z.modo]}>
                <Select
                  value={z.modo}
                  onChange={(v) => changeZoneMode(z, v as ZoneMode)}
                  options={MODO_OPTS}
                  ariaLabel="Modo da zona"
                />
              </Field>

              {z.modo === "atividade" && (
                <>
                  <Field
                    label="Atividade"
                    hint="Rótulo do processo executado na área (para o relatório)."
                  >
                    <Select
                      value={z.atividade}
                      onChange={(v) => patchZone(z.id, { atividade: v })}
                      options={ACTIVITIES.map((a) => ({ value: a, label: a }))}
                      ariaLabel="Atividade da zona"
                    />
                  </Field>
                  <Field label="Alerta se parada acima de">
                    <Select
                      value={String(z.idleAlertMs)}
                      onChange={(v) => patchZone(z.id, { idleAlertMs: Number(v) })}
                      options={APP_CONFIG.zones.limitPresetsMs.map((ms) => ({
                        value: String(ms),
                        label: fmtLimit(ms),
                      }))}
                      ariaLabel="Limite de parada"
                    />
                  </Field>
                  <Field
                    label={`Sensibilidade ao movimento · ${z.sensitivity}`}
                    hint="Menor = ignora micro-movimentos; maior = detecta o mínimo."
                  >
                    <div className="cfg-slider">
                      <span className="ss-end">−</span>
                      <Slider
                        value={z.sensitivity}
                        min={1}
                        max={10}
                        step={1}
                        onChange={(v) => patchZone(z.id, { sensitivity: v })}
                        ariaLabel="Sensibilidade"
                      />
                      <span className="ss-end">+</span>
                    </div>
                    {/* Estimativa de alertas/dia: espaçamento/tipografia por TOKEN (.cfg-estimate
                        em cine.css) — o `style` inline trazia px cru (fora dos 7 papéis). */}
                    <div className="cfg-estimate" aria-live="polite">
                      {histState === "loading" && (
                        <span className="muted">estimando alertas/dia…</span>
                      )}
                      {histState === "error" && (
                        <span className="muted">histórico indisponível — sem estimativa</span>
                      )}
                      {histState === "ready" &&
                        histDataset &&
                        (() => {
                          const p = predictAlertsPerDay(histDataset, z.label, z.sensitivity);
                          if (p.status === "no-data")
                            return (
                              <span className="muted">
                                sem dados suficientes p/ estimar alertas/dia
                              </span>
                            );
                          return (
                            <span>
                              ≈ <b>{p.perDay}</b> alerta(s)/dia estimados{" "}
                              <span className="muted">
                                (base {p.baselinePerDay}/dia · {p.days}d)
                              </span>
                            </span>
                          );
                        })()}
                    </div>
                  </Field>
                  {/* GATE DE OCIOSIDADE (spec-turnos-por-zona §4.1): sem turno, a área é
                      monitorada 24/7 (hoje); com turno, o alerta de parada só dispara DENTRO
                      dele e FORA das pausas — quem decide é o servidor. */}
                  <TurnosField
                    zone={z}
                    shifts={shifts}
                    state={shiftsState}
                    patchZone={patchZone}
                    hint="O alerta de parada só dispara dentro dos turnos escolhidos (e fora das pausas deles). Sem turno selecionado, a área é monitorada 24/7."
                  />
                </>
              )}

              {z.modo === "leitura" && (
                <Field
                  label="Ponto de leitura"
                  hint="Identifica este leitor no histórico/relatório."
                >
                  <Input
                    value={z.ponto}
                    onChange={(e) => patchZone(z.id, { ponto: e.target.value })}
                  />
                </Field>
              )}

              {z.modo === "objetos" && (
                <Field label="Classes a contar" hint="Toque para incluir/excluir cada objeto.">
                  <ToggleGroup
                    type="multiple"
                    className="ws-cfg ws-chips"
                    ariaLabel="Classes a contar"
                    value={z.selectedClasses}
                    onValueChange={(vals) => patchZone(z.id, { selectedClasses: vals })}
                    // O emoji é DADO do catálogo (não ícone de UI): aria-hidden p/ o leitor de
                    // tela não soletrá-lo — o rótulo textual ao lado já nomeia a classe.
                    items={OBJECT_CATALOG.map((o) => ({
                      value: o.key,
                      label: (
                        <>
                          <span aria-hidden>{o.emoji}</span> {o.label}
                        </>
                      ),
                      ariaLabel: o.label,
                    }))}
                  />
                </Field>
              )}

              {/* Lotação: dois produtores possíveis, mesmos campos (targetOccupancy/
                  occupancyToleranceMs) — quem observa depende do MODO da zona:
                  · "atividade" → server-side, 24/7, sobre o D-FINE (occupancy-alert.js no
                    hub) — RECOMENDADO: é o motor avaliado no `npm run eval`, robusto a
                    pose/ângulo/oclusão. Não depende do navegador aberto.
                  · "objetos" com "pessoa" selecionada → client-side, OWL-ViT zero-shot
                    (ObjetosProcessor). Medido (câmera real, gente sentada/ocluída): esse
                    detector pode não reconhecer a pose e a meta nunca bate — prefira
                    "atividade" para contagem de PESSOA; "objetos" continua sendo a única
                    via para metas de CLASSES não-pessoa (caixa/palete/empilhadeira). */}
              {(z.modo === "atividade" || (z.modo === "objetos" && z.selectedClasses.includes("pessoa"))) && (
                <Field
                  label="Alertar por lotação"
                  hint={
                    z.modo === "atividade"
                      ? "Se a quantidade de pessoas na área ficar diferente do número esperado pelo tempo configurado, gera um alarme (mesmo canal dos outros alarmes — painel e WhatsApp/Andon). Roda no servidor, 24/7, mesmo com o painel fechado."
                      : "Se a quantidade de pessoas na área ficar diferente do número esperado pelo tempo configurado, gera um alarme (mesmo canal dos outros alarmes). Roda no navegador enquanto a câmera estiver aberta na tela — se a contagem nunca bater com gente visivelmente presente, troque o modo da zona pra \"Atividade\" (mais robusto pra pessoa)."
                  }
                >
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={z.targetOccupancy != null}
                      onCheckedChange={(on) =>
                        patchZone(z.id, { targetOccupancy: on ? (z.targetOccupancy ?? 1) : undefined })
                      }
                      ariaLabel="Alertar por lotação"
                    />
                    {z.targetOccupancy != null && (
                      <>
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          className="w-16"
                          aria-label="Quantidade esperada de pessoas"
                          value={z.targetOccupancy}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n) && n >= 0)
                              patchZone(z.id, { targetOccupancy: Math.round(n) });
                          }}
                        />
                        <span className="muted">pessoa(s) por</span>
                        <Select
                          value={String(z.occupancyToleranceMs ?? DEFAULT_OCCUPANCY_TOLERANCE_MS)}
                          onChange={(v) => patchZone(z.id, { occupancyToleranceMs: Number(v) })}
                          options={PRESENCA_ALERT_PRESETS_MS.map((ms) => ({
                            value: String(ms),
                            label: fmtLimit(ms),
                          }))}
                          ariaLabel="Tempo até o alarme de lotação"
                        />
                      </>
                    )}
                  </div>
                </Field>
              )}

              {z.modo === "fadiga" && (
                <p className="empty-note">
                  Monitora 1 operador na ROI da zona (recorte). Som e calibração de limiares ficam
                  na câmera dedicada de fadiga.
                </p>
              )}

              {/* A PODA (F5): o pincel morreu, então o texto que mandava "Pintar área" virou
                  mentira — mandava o operador procurar um botão que não existe mais. A exclusão
                  se desenha como qualquer zona: polígono no palco (ou vértice a vértice abaixo).
                  O 2º parágrafo é o EFEITO OCULTO (achado de auditoria): a mesma zona vira máscara
                  de ignore do gate de movimento do hub (buildMotionIgnore) — ninguém sabia. */}
              {z.modo === "exclusao" &&
                (() => {
                  const cobertura = zoneFrameCoverage(z);
                  return (
                    <>
                      <p className="empty-note">
                        Toda pessoa cujo pé cair aqui é descartada: não conta, não rastreia, não
                        aparece e <b>não gera alarme</b> — nem aqui, nem no relatório. Sem
                        parâmetros: desenhe a área sobre a fonte fixa de falso positivo (grade,
                        placa, janela escura de van, TV). Para vigiar uma área que deve ficar vazia,
                        o modo é <b>Área restrita (gera alarme)</b>.
                      </p>
                      <p className="empty-note">
                        <b>Efeito colateral:</b> esta área também fica invisível para o gate de
                        movimento do motor — movimento AQUI não acorda a análise. Esta zona cobre{" "}
                        <b>{fmtCobertura(cobertura)}</b> do quadro (só esta; outras zonas de
                        exclusão somam). Quanto mais quadro ignorado, mais a câmera depende da
                        varredura periódica (poucos segundos) para descobrir gente: atraso na
                        detecção, não cegueira. Cubra só a fonte do falso positivo.
                        {cobertura >= EXCLUSAO_COBERTURA_ALERTA && (
                          <span className="text-warn">
                            {" "}
                            Cobertura alta — reveja o desenho desta área.
                          </span>
                        )}
                      </p>
                    </>
                  );
                })()}

              {/* PROIBIDA (spec alerta-por-atividade E2): dwell por presets — SEM slider de
                  sensibilidade (armadilha A4: o gatilho é PESSOA detectada, não motion) e SEM o
                  preview predictAlertsPerDay (a premissa dele é ociosidade — armadilha do preview). */}
              {z.modo === "proibida" && (
                <>
                  <Field
                    label="Alertar se presença acima de"
                    hint="Pessoa que permanecer na área por mais que este tempo dispara o alarme; quem só atravessa não dispara."
                  >
                    <Select
                      value={String(z.presencaAlertMs ?? DEFAULT_PRESENCA_ALERT_MS)}
                      onChange={(v) => patchZone(z.id, { presencaAlertMs: Number(v) })}
                      options={PRESENCA_ALERT_PRESETS_MS.map((ms) => ({
                        value: String(ms),
                        label: fmtLimit(ms),
                      }))}
                      ariaLabel="Limite de presença"
                    />
                  </Field>
                  {/* ARMAMENTO (E4 / turnos F2): "sempre" = 24/7 (default). "dentro/fora dos
                      turnos" é o caso "área normal no expediente, proibida à noite" — precisa
                      dos turnos atribuídos abaixo; sem eles, a zona segue 24/7 (o servidor
                      nunca cala um alarme por config incompleta). */}
                  <Field
                    label="Armada"
                    hint="Quando esta área é vigiada. Fora da janela armada, a presença não gera alarme."
                  >
                    <Select
                      value={z.arming ?? "sempre"}
                      onChange={(v) => patchZone(z.id, { arming: v as ZoneArming })}
                      options={ZONE_ARMINGS.map((a) => ({ value: a, label: ZONE_ARMING_LABEL[a] }))}
                      ariaLabel="Janela de armamento"
                    />
                  </Field>
                  {(z.arming ?? "sempre") !== "sempre" && (
                    <TurnosField
                      zone={z}
                      shifts={shifts}
                      state={shiftsState}
                      patchZone={patchZone}
                      hint="A janela de armamento é relativa a estes turnos. Sem turno selecionado, a área permanece armada 24/7."
                    />
                  )}
                  <p className="empty-note">
                    O alarme é produzido pelo motor de análise do hub — câmera sem o motor não gera
                    este alerta nesta versão.
                  </p>
                </>
              )}

              {/* VÉRTICES (F4) — o caminho de TECLADO do polígono e a precisão fina sem zoom.
                  Vale para TODO modo (a geometria não é do modo). `points` é a FONTE DA VERDADE;
                  a bbox x/y/w/h é CACHE da envolvente e é RE-DERIVADA aqui no patch (polygonBBox),
                  exatamente como o arraste de vértice no palco faz — nunca autorada à mão. */}
              <VertexTable
                key={z.id} // troca de zona ⇒ tabela nova (a seleção não vaza de uma zona p/ outra)
                points={z.points}
                onChange={(pts) => patchZone(z.id, { points: pts, ...polygonBBox(pts) })}
              />
            </div>
          );
        })()}
    </Dialog>
  );
}
