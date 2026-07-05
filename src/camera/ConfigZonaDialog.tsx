// ── Diálogo de configuração de zona (modo + parâmetros) ──────────────────────
// Extraído do CameraWorkspace.tsx (R3) SEM mudança de comportamento. É JSX PURO
// controlado por props: não toca em canvas/rAF/refs. O componente pai continua
// dono do estado da zona (patchZone/changeZoneMode) e de quando abrir/fechar
// (cfgZoneId). A carga do histórico p/ a previsão de alertas/dia (histState/
// histDataset) segue no pai — aqui só a renderização.
import { APP_CONFIG } from "../config";
import { fmtLimit } from "../format";
import { ACTIVITIES } from "../processors/atividade";
import { predictAlertsPerDay } from "../report/predict";
import { type Dataset } from "../report/mock";
import { OBJECT_CATALOG } from "../objects/catalog";
import { type Zone, type ZoneMode } from "../zones";
import { Button, Input, Select, Slider, ToggleGroup, Dialog, Field } from "../ui";

// Labels são contrato do e2e (option name "Leitura" etc.) — a explicação vai como
// hint dinâmico ABAIXO do select, não dentro das options.
const MODO_OPTS = [
  { value: "atividade", label: "Atividade" },
  { value: "leitura", label: "Leitura" },
  { value: "objetos", label: "Objetos" },
  { value: "fadiga", label: "Fadiga" },
  { value: "exclusao", label: "Exclusão" },
];

// 1 linha por modo, visível ao selecionar — o usuário não escolhe mais às cegas.
const MODO_DESC: Record<ZoneMode, string> = {
  atividade: "Movimento/ociosidade + contagem de pessoas na área (padrão).",
  leitura: "Lê código de barras/QR dentro da zona — desenhe-a sobre a esteira/etiqueta.",
  objetos: "Conta as classes escolhidas (caixa, palete…) — modelo pesado, o 1º uso demora.",
  fadiga: "Rosto/mãos de 1 operador na zona — p/ câmera dedicada use Câmeras → Ajustes desta câmera → Operador (fadiga).",
  exclusao:
    "Ignora detecções de pessoa nesta área — use sobre fontes fixas de falso positivo (grade, placa, janela de van, TV). Não gera indicador.",
};

type Props = {
  zone: Zone | null; // cfgZone (null → diálogo fechado)
  demoMode: boolean;
  histState: "idle" | "loading" | "ready" | "error";
  histDataset: Dataset | null;
  onClose: () => void;
  patchZone: (id: string, patch: Partial<Zone>) => void;
  changeZoneMode: (z: Zone, next: ZoneMode) => void;
};

export function ConfigZonaDialog({
  zone,
  demoMode,
  histState,
  histDataset,
  onClose,
  patchZone,
  changeZoneMode,
}: Props) {
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
                  <Field
                    label="Alerta se parada acima de"
                    hint={
                      demoMode
                        ? `Modo demo força ${fmtLimit(APP_CONFIG.zones.demoIdleAlertMs)}.`
                        : undefined
                    }
                  >
                    <Select
                      value={String(z.idleAlertMs)}
                      disabled={demoMode}
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
                    <div
                      style={{ marginTop: "var(--sp-1)", fontSize: 11, color: "var(--text-dim)" }}
                      aria-live="polite"
                    >
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
                              ≈{" "}
                              <b style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>
                                {p.perDay}
                              </b>{" "}
                              alerta(s)/dia estimados{" "}
                              <span className="muted">
                                (base {p.baselinePerDay}/dia · {p.days}d
                                {demoMode ? " · limite curto demo eleva o real" : ""})
                              </span>
                            </span>
                          );
                        })()}
                    </div>
                  </Field>
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
                    items={OBJECT_CATALOG.map((o) => ({
                      value: o.key,
                      label: (
                        <>
                          {o.emoji} {o.label}
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
                  não aparece). Sem parâmetros — pinte a área (🖌) sobre a fonte fixa de falso
                  positivo.
                </p>
              )}
            </div>
          );
        })()}
    </Dialog>
  );
}
