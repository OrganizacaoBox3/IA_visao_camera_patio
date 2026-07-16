// Painel de zonas do fingerprinting. Uma zona de trabalho é o local reconhecido pelo operador;
// cada captura grava uma amostra de calibração (fingerprint RSSI) dessa zona.
import { useMemo, useState } from "react";
import { Badge, Button, Field, Input, StatusDot, useConfirm } from "../ui";
import type { Fingerprint } from "../api";
import type { Vec2 } from "../vision/homography";
import type { FloorplanSetupRow } from "./useFloorplanMap";
import type { CaptureCheck } from "./useFingerprints";
import { parseMeters } from "./AntennaTable";

type Msg = { tone: "ok" | "warn" | "alert"; text: string };
type FormErrors = { name?: string; coordinates?: string };
export type ZoneSampleFormResult =
  | { ok: true; name: string; xy: Vec2 | null; errors: FormErrors }
  | { ok: false; errors: FormErrors };

/** X/Y são um par: ambos preenchidos ou ambos ausentes. */
export function validateZoneSampleForm(
  nameText: string,
  xText: string,
  yText: string,
): ZoneSampleFormResult {
  const name = nameText.trim();
  const hasX = xText.trim().length > 0;
  const hasY = yText.trim().length > 0;
  const errors: FormErrors = {};
  if (!name) errors.name = "Informe o nome do local de referência.";

  let xy: Vec2 | null = null;
  if (hasX !== hasY) {
    errors.coordinates = "Informe X e Y, ou deixe os dois campos vazios.";
  } else if (hasX && hasY) {
    const x = parseMeters(xText);
    const y = parseMeters(yText);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      errors.coordinates = "Use coordenadas válidas, iguais ou maiores que zero.";
    } else {
      xy = { x, y };
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, name, xy, errors };
}

export type FingerprintGroup = { label: string; samples: Fingerprint[] };

/** IDs das estações são ASCII e não diferenciam maiúsculas de minúsculas. */
export function sameStationId(left: string, right: string): boolean {
  return left.toUpperCase() === right.toUpperCase();
}

/** Agrupa por zona/local sem reordenar a sequência recebida do hub. */
export function groupFingerprints(fingerprints: readonly Fingerprint[]): FingerprintGroup[] {
  const grouped = new Map<string, Fingerprint[]>();
  for (const sample of fingerprints) {
    const current = grouped.get(sample.label);
    if (current) current.push(sample);
    else grouped.set(sample.label, [sample]);
  }
  return [...grouped].map(([label, samples]) => ({ label, samples }));
}

type Props = {
  rows: FloorplanSetupRow[];
  fingerprints: Fingerprint[];
  capturing: string | null;
  onCapture: (
    label: string,
    xy?: Vec2 | null,
  ) => Promise<{ ok: boolean; error?: string; check?: CaptureCheck }>;
  onRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
};

export function ZoneCalibration({ rows, fingerprints, capturing, onCapture, onRemove }: Props) {
  const confirm = useConfirm();
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const [customName, setCustomName] = useState("");
  const [customX, setCustomX] = useState("");
  const [customY, setCustomY] = useState("");
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const [surveyMsg, setSurveyMsg] = useState<Msg | null>(null);
  const placed = rows.filter((row) => row.pos);
  const groups = useMemo(() => groupFingerprints(fingerprints), [fingerprints]);
  const countFor = (label: string) =>
    fingerprints.filter((sample) => sample.label === label).length;

  async function run(
    key: string,
    label: string,
    xy: Vec2 | null,
    expectId?: string,
  ): Promise<boolean> {
    setMsg((current) => ({
      ...current,
      [key]: { tone: "ok", text: "Capturando por cerca de 10 s. Mantenha as tags no local." },
    }));
    const result = await onCapture(label, xy);
    if (!result.ok) {
      setMsg((current) => ({
        ...current,
        [key]: { tone: "alert", text: result.error ?? "Não foi possível capturar a amostra." },
      }));
      return false;
    }
    const check = result.check;
    let next: Msg;
    if (check && expectId && !sameStationId(check.strongest, expectId)) {
      next = {
        tone: "warn",
        text: `Amostra salva, mas o sinal mais forte foi de ${check.strongest}, não de ${expectId}. Verifique a antena.`,
      };
    } else if (check) {
      next = {
        tone: check.margin >= 15 ? "ok" : "warn",
        text: `Amostra salva. Sinal mais forte: ${check.strongest} (${check.strongestRssi} dBm), margem ${check.margin} dB, ${check.nAmostras} leituras.`,
      };
    } else next = { tone: "ok", text: "Amostra salva." };
    setMsg((current) => ({ ...current, [key]: next }));
    return true;
  }

  async function captureZoneSample() {
    const result = validateZoneSampleForm(customName, customX, customY);
    setFormErrors(result.errors);
    if (!result.ok) return;
    if (!(await run("__custom", result.name, result.xy))) return;
    setCustomName("");
    setCustomX("");
    setCustomY("");
    setFormErrors({});
  }

  async function removeSample(sample: Fingerprint, samplesInGroup: number) {
    const accepted = await confirm({
      title: `Remover esta amostra de “${sample.label}”?`,
      description:
        samplesInGroup === 1
          ? "Esta é a única amostra desse local. Após removê-la, ele deixa de participar da localização por zonas."
          : "A zona continuará usando as outras amostras de calibração.",
      confirmLabel: "Remover amostra",
      variant: "danger",
    });
    if (!accepted) return;
    setRemoving(sample.id);
    setSurveyMsg(null);
    const result = await onRemove(sample.id);
    setRemoving(null);
    setSurveyMsg(
      result.ok
        ? { tone: "ok", text: "Amostra removida." }
        : { tone: "alert", text: result.error ?? "Não foi possível remover a amostra." },
    );
  }

  function status(message: Msg) {
    return (
      <span
        role={message.tone === "alert" ? "alert" : "status"}
        aria-live={message.tone === "alert" ? "assertive" : "polite"}
        className={
          message.tone === "ok"
            ? "text-micro text-ok"
            : message.tone === "warn"
              ? "text-micro text-warn"
              : "text-micro text-critical"
        }
      >
        {message.text}
      </span>
    );
  }

  const busy = capturing !== null || removing !== null;
  return (
    <section
      aria-labelledby="zone-calibration-title"
      aria-busy={busy}
      className="flex min-w-0 flex-col gap-3 rounded-sm border border-border bg-panel-2 p-3"
    >
      <div>
        <b id="zone-calibration-title" className="text-body text-text">
          Locais de referência
        </b>
        <p className="text-sec text-text-muted">
          A classificação compara o sinal vivo com amostras capturadas em locais conhecidos.
          Amostras representativas tornam a zona provável mais estável.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <div>
          <b className="text-sec text-text">Referências junto às antenas</b>
          <p className="text-micro text-text-muted">Crie referências conhecidas do ambiente.</p>
        </div>
        {placed.length === 0 ? (
          <p className="text-sec text-text-muted">Posicione as antenas no mapa primeiro.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {placed.map((row) => {
              const sampleCount = countFor(row.label);
              const rowBusy = capturing === row.label;
              return (
                <li
                  key={row.id}
                  className="flex min-w-0 flex-col gap-1 rounded-sm border border-border bg-panel px-2 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <StatusDot
                      tone={row.live ? "info" : "neutral"}
                      label={row.live ? "viva" : "sem sinal"}
                    />
                    <span className="min-w-0 flex-1 truncate text-body text-text">{row.label}</span>
                    <Badge tone={sampleCount > 0 ? "ok" : undefined}>
                      {sampleCount > 0
                        ? `${sampleCount} amostra${sampleCount === 1 ? "" : "s"}`
                        : "sem amostra"}
                    </Badge>
                    <Button
                      size="sm"
                      disabled={busy}
                      aria-busy={rowBusy}
                      onClick={() => run(row.id, row.label, row.pos ?? null, row.id)}
                    >
                      {rowBusy ? "Capturando…" : "Capturar amostra"}
                    </Button>
                  </div>
                  {msg[row.id] && status(msg[row.id])}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
        <div>
          <b className="text-sec text-text">Nova amostra de local</b>
          <p className="text-micro text-text-muted">
            Leve as tags até a área de trabalho antes de capturar.
          </p>
        </div>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <Field
            className="col-span-2"
            label="Nome do local"
            htmlFor="fp-custom"
            error={formErrors.name}
          >
            <Input
              id="fp-custom"
              placeholder="Ex.: mesa 4, corredor A, doca"
              value={customName}
              disabled={busy}
              onChange={(event) => {
                setCustomName(event.target.value);
                if (formErrors.name) setFormErrors((current) => ({ ...current, name: undefined }));
              }}
            />
          </Field>
          <Field label="X (m)" htmlFor="fp-custom-x" error={formErrors.coordinates}>
            <Input
              id="fp-custom-x"
              inputMode="decimal"
              placeholder="Opcional"
              value={customX}
              disabled={busy}
              onChange={(event) => {
                setCustomX(event.target.value);
                if (formErrors.coordinates)
                  setFormErrors((current) => ({ ...current, coordinates: undefined }));
              }}
            />
          </Field>
          <Field label="Y (m)" htmlFor="fp-custom-y">
            <Input
              id="fp-custom-y"
              inputMode="decimal"
              placeholder="Opcional"
              value={customY}
              disabled={busy}
              aria-invalid={Boolean(formErrors.coordinates)}
              onChange={(event) => {
                setCustomY(event.target.value);
                if (formErrors.coordinates)
                  setFormErrors((current) => ({ ...current, coordinates: undefined }));
              }}
            />
          </Field>
          <Button
            className="col-span-2"
            size="sm"
            block
            disabled={busy}
            aria-busy={capturing === customName.trim() && customName.trim().length > 0}
            onClick={captureZoneSample}
          >
            {capturing === customName.trim() && customName.trim()
              ? "Capturando…"
              : "Capturar amostra"}
          </Button>
        </div>
        <p className="text-micro text-text-muted">
          X e Y são opcionais, mas devem ser informados juntos. Com coordenadas, a amostra aparece
          no mapa de calibração.
        </p>
        {msg.__custom && status(msg.__custom)}
      </div>

      {groups.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
          <div>
            <b className="text-sec text-text">Amostras de calibração</b>
            <p className="text-micro text-text-muted">
              {fingerprints.length} amostra{fingerprints.length === 1 ? "" : "s"} em {groups.length}{" "}
              {groups.length === 1 ? "local" : "locais"}.
            </p>
          </div>
          <ul className="flex min-w-0 flex-col gap-2">
            {groups.map((group) => (
              <li
                key={group.label}
                className="min-w-0 rounded-sm border border-border bg-panel px-2 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sec font-medium text-text">
                    {group.label}
                  </span>
                  <Badge>
                    {group.samples.length} amostra{group.samples.length === 1 ? "" : "s"}
                  </Badge>
                </div>
                <ul className="mt-1 flex min-w-0 flex-col gap-1">
                  {group.samples.map((sample, index) => (
                    <li
                      key={sample.id}
                      className="flex min-w-0 flex-wrap items-center gap-2 text-micro"
                    >
                      <span className="text-text-muted">
                        Amostra {index + 1} · {Object.keys(sample.vec).length}{" "}
                        {Object.keys(sample.vec).length === 1 ? "antena" : "antenas"}
                        {typeof sample.x === "number" && typeof sample.y === "number"
                          ? ` · (${sample.x}, ${sample.y}) m`
                          : ""}
                      </span>
                      <span className="min-w-2 flex-1" />
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-busy={removing === sample.id}
                        onClick={() => removeSample(sample, group.samples.length)}
                      >
                        {removing === sample.id ? "Removendo…" : "Remover"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          {surveyMsg && status(surveyMsg)}
        </div>
      )}
    </section>
  );
}
