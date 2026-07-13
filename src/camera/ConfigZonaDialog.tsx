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
  PRESENCA_ALERT_PRESETS_MS,
  ZONE_ARMINGS,
  ZONE_ARMING_LABEL,
  type Zone,
  type ZoneArming,
  type ZoneMode,
} from "../zones";
import { getShifts, type Shift } from "../api";
import { Button, Input, Select, Slider, ToggleGroup, Dialog, Field } from "../ui";

// Labels são contrato do e2e (option name "Leitura" etc.) — a explicação vai como
// hint dinâmico ABAIXO do select, não dentro das options.
const MODO_OPTS = [
  { value: "atividade", label: "Atividade" },
  { value: "leitura", label: "Leitura" },
  { value: "objetos", label: "Objetos" },
  { value: "fadiga", label: "Fadiga" },
  { value: "exclusao", label: "Exclusão" },
  { value: "proibida", label: "Proibida" },
];

// 1 linha por modo, visível ao selecionar — o usuário não escolhe mais às cegas.
const MODO_DESC: Record<ZoneMode, string> = {
  atividade: "Movimento/ociosidade + contagem de pessoas na área (padrão).",
  leitura: "Lê código de barras/QR dentro da zona — desenhe-a sobre a esteira/etiqueta.",
  objetos: "Conta as classes escolhidas (caixa, palete…) — modelo pesado, o 1º uso demora.",
  fadiga: "Rosto/mãos de 1 operador na zona — p/ câmera dedicada use Câmeras → Ajustes desta câmera → Operador (fadiga).",
  exclusao:
    "Ignora detecções de pessoa nesta área — use sobre fontes fixas de falso positivo (grade, placa, janela de van, TV). Não gera indicador.",
  proibida:
    "Área que deve ficar VAZIA: pessoa presente acima do limite dispara alarme crítico — o alarme nasce no motor do hub (24/7, sem precisar de painel aberto).",
};

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

              {z.modo === "fadiga" && (
                <p className="empty-note">
                  Monitora 1 operador na ROI da zona (recorte). Som e calibração de limiares ficam na
                  câmera dedicada de fadiga.
                </p>
              )}

              {z.modo === "exclusao" && (
                <p className="empty-note">
                  Área de máscara: toda pessoa cujo pé cair aqui é ignorada (não conta, não rastreia,
                  não aparece). Sem parâmetros — use “Pintar área” sobre a fonte fixa de falso
                  positivo.
                </p>
              )}

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
            </div>
          );
        })()}
    </Dialog>
  );
}
