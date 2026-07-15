// ZoneCalibration — o painel de CALIBRAÇÃO DE ZONAS do fingerprinting (modo config da Planta BLE).
// Fluxo pedido pelo dono: encosta as tags EM CIMA de uma antena, clica "Calibrar" → captura ~10 s da
// assinatura RSSI daquele ponto e grava. Faz isso para cada antena (semeia as zonas). Também aceita
// pontos INTERMEDIÁRIOS (nome livre) — o mesmo botão, só muda onde as tags estão. Auto-valida a
// captura: a antena mais forte deveria ser ESTA (margem alta = "em cima" de verdade).
import { useState } from "react";
import { Button, Input, Badge, StatusDot } from "../ui";
import type { Fingerprint } from "../api";
import type { Vec2 } from "../vision/homography";
import type { FloorplanSetupRow } from "./useFloorplanMap";
import type { CaptureCheck } from "./useFingerprints";

type Msg = { tone: "ok" | "warn" | "alert"; text: string };

export function ZoneCalibration({
  rows,
  fingerprints,
  capturing,
  onCapture,
  onRemove,
}: {
  rows: FloorplanSetupRow[];
  fingerprints: Fingerprint[];
  capturing: string | null;
  onCapture: (
    label: string,
    xy?: Vec2 | null,
  ) => Promise<{ ok: boolean; error?: string; check?: CaptureCheck }>;
  onRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [msg, setMsg] = useState<Record<string, Msg>>({});
  const [customName, setCustomName] = useState("");
  const placed = rows.filter((r) => r.pos);
  const countFor = (label: string) => fingerprints.filter((f) => f.label === label).length;

  async function run(key: string, label: string, xy: Vec2 | null, expectId?: string) {
    setMsg((m) => ({ ...m, [key]: { tone: "ok", text: "Capturando ~10 s… segure as tags no ponto." } }));
    const r = await onCapture(label, xy);
    if (!r.ok) {
      setMsg((m) => ({ ...m, [key]: { tone: "alert", text: r.error ?? "Falha." } }));
      return;
    }
    const c = r.check;
    // Auto-validação: a antena mais forte da captura deveria ser a que você calibrou.
    if (c && expectId && c.strongest !== expectId) {
      setMsg((m) => ({
        ...m,
        [key]: {
          tone: "warn",
          text: `Salvo, mas a antena mais forte foi ${c.strongest} (não ${expectId}). As tags estão MESMO em cima desta antena?`,
        },
      }));
    } else if (c) {
      setMsg((m) => ({
        ...m,
        [key]: {
          tone: c.margin >= 15 ? "ok" : "warn",
          text: `Salvo ✓ mais forte: ${c.strongest} (${c.strongestRssi} dBm), margem ${c.margin} dB, ${c.nAmostras} amostras.`,
        },
      }));
    } else {
      setMsg((m) => ({ ...m, [key]: { tone: "ok", text: "Salvo ✓" } }));
    }
  }

  const toneColor = (t: Msg["tone"]) =>
    `var(--state-${t === "ok" ? "ok" : t === "warn" ? "warn" : "alert"})`;

  return (
    <div className="flex flex-col gap-3 rounded-sm border border-border bg-panel-2 p-3">
      <div>
        <b className="text-[13px] text-text">Calibração de zonas (fingerprinting)</b>
        <p className="text-[12px] text-text-muted">
          Encoste as tags <b>em cima</b> de uma antena e clique Calibrar. Repita para cada antena. A
          zona vira o sinal confiável (a posição X,Y por rádio oscila; a zona não).
        </p>
      </div>

      {placed.length === 0 ? (
        <p className="text-[12px] text-text-muted">Posicione as antenas no mapa primeiro.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {placed.map((r) => {
            const n = countFor(r.label);
            const busy = capturing === r.label;
            const m = msg[r.id];
            return (
              <li key={r.id} className="flex flex-col gap-1 rounded-sm border border-border bg-panel px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <StatusDot tone={r.live ? "info" : "neutral"} label={r.live ? "viva" : "sem sinal"} />
                  <span className="truncate text-[13px] text-text">{r.label}</span>
                  {n > 0 ? <Badge tone="ok">calibrada{n > 1 ? ` (${n})` : ""}</Badge> : <Badge>não calibrada</Badge>}
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    variant="default"
                    disabled={!!capturing}
                    onClick={() => run(r.id, r.label, r.pos ?? null, r.id)}
                  >
                    {busy ? "Capturando…" : "Calibrar"}
                  </Button>
                </div>
                {m && <span className="text-[11px]" style={{ color: toneColor(m.tone) }}>{m.text}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {/* Ponto INTERMEDIÁRIO (nome livre) — mesmo fluxo, para refinar entre as antenas. */}
      <div className="flex items-end gap-2 border-t border-border pt-2">
        <div className="flex flex-1 flex-col gap-1">
          <label htmlFor="fp-custom" className="text-[11px] text-text-muted">
            Ponto intermediário (opcional)
          </label>
          <Input
            id="fp-custom"
            placeholder="ex.: corredor A, meio da doca…"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="default"
          disabled={!!capturing || !customName.trim()}
          onClick={() => {
            const name = customName.trim();
            run("__custom", name, null);
            setCustomName("");
          }}
        >
          {capturing === customName.trim() && customName.trim() ? "Capturando…" : "Calibrar ponto"}
        </Button>
      </div>
      {msg.__custom && (
        <span className="text-[11px]" style={{ color: toneColor(msg.__custom.tone) }}>{msg.__custom.text}</span>
      )}

      {/* Survey capturado — remover pontos ruins. */}
      {fingerprints.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <span className="text-[11px] text-text-dim">Pontos no survey ({fingerprints.length})</span>
          <ul className="flex flex-col gap-1">
            {fingerprints.map((f) => (
              <li key={f.id} className="flex items-center gap-2 text-[12px]">
                <span className="truncate text-text">{f.label}</span>
                <span className="text-text-muted">· {Object.keys(f.vec).length} antenas</span>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" disabled={!!capturing} onClick={() => onRemove(f.id)}>
                  Remover
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
