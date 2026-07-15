// SetupPanel — o EDITOR da Planta BLE: dimensões do galpão (largura × comprimento em metros) + a
// posição X,Y de cada antena. É um Radix Dialog (permitido aqui — ADR-007 restringe SÓ a casca
// fullscreen da câmera, cujo <canvas> não pode remontar; esta é uma tela comum). Só quem pode
// configurar chega aqui (a página gateia por canConfigure).
//
// A validação de negócio é do SERVIDOR (mesma doutrina de TurnosPage): montamos o payload como o
// usuário digitou e exibimos o {error} que voltar. Guarda-mínima local: largura/comprimento > 0
// (sem isso não há caixa para desenhar); antena só entra se X e Y forem ambos numéricos.
import { useState } from "react";
import { Alert, Button, Dialog, Field, Input, StatusDot } from "../ui";
import type { Floorplan } from "../api";
import type { FloorplanSetupRow } from "./useFloorplanMap";

/** Parse tolerante a vírgula decimal; devolve null quando não é número finito (campo vazio/lixo). */
function num(s: string): number | null {
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

export function SetupPanel({
  widthM,
  heightM,
  rows,
  saving,
  onSave,
  onClose,
}: {
  widthM: number;
  heightM: number;
  rows: FloorplanSetupRow[];
  saving: boolean;
  onSave: (next: Floorplan) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  // Valores CRUS (string) dos inputs — a conversão acontece no submit. 0/ausente → campo vazio.
  const [widthStr, setWidthStr] = useState(widthM > 0 ? String(widthM) : "");
  const [heightStr, setHeightStr] = useState(heightM > 0 ? String(heightM) : "");
  const [pos, setPos] = useState<Record<string, { x: string; y: string }>>(() =>
    Object.fromEntries(
      rows.map((r) => [
        r.id,
        { x: r.pos ? String(r.pos.x) : "", y: r.pos ? String(r.pos.y) : "" },
      ]),
    ),
  );
  const [err, setErr] = useState<string | null>(null);

  const setCell = (id: string, patch: Partial<{ x: string; y: string }>) =>
    setPos((p) => ({ ...p, [id]: { ...(p[id] ?? { x: "", y: "" }), ...patch } }));

  async function submit() {
    setErr(null);
    const w = num(widthStr);
    const h = num(heightStr);
    if (!w || w <= 0 || !h || h <= 0) {
      setErr("Informe a largura e o comprimento do local em metros (maiores que zero).");
      return;
    }
    // Só as antenas com X E Y numéricos entram na planta (as em branco ficam de fora).
    const stations: Record<string, { x: number; y: number }> = {};
    for (const r of rows) {
      const cell = pos[r.id];
      if (!cell) continue;
      const x = num(cell.x);
      const y = num(cell.y);
      if (x === null || y === null) continue;
      stations[r.id] = { x, y };
    }
    const res = await onSave({ widthM: w, heightM: h, stations });
    if (res.ok) onClose();
    else setErr(res.error ?? "Falha ao salvar a planta.");
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Configurar planta"
      description="Dimensões do local e a posição de cada antena BLE, em metros."
      footer={
        <div className="flex items-center gap-2">
          <Button variant="primary" size="sm" disabled={saving} onClick={submit}>
            {saving ? "Salvando…" : "Salvar planta"}
          </Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={onClose}>
            Cancelar
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        aria-label="Configurar planta BLE"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {err && <Alert tone="alert">{err}</Alert>}

        {/* ── Dimensões do galpão ── */}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Largura (m)" htmlFor="fp-w" className="w-32">
            <Input
              id="fp-w"
              type="number"
              min={0}
              step="0.1"
              inputMode="decimal"
              value={widthStr}
              onChange={(e) => setWidthStr(e.target.value)}
            />
          </Field>
          <Field label="Comprimento (m)" htmlFor="fp-h" className="w-32">
            <Input
              id="fp-h"
              type="number"
              min={0}
              step="0.1"
              inputMode="decimal"
              value={heightStr}
              onChange={(e) => setHeightStr(e.target.value)}
            />
          </Field>
        </div>

        {/* ── Antenas: uma linha por estação conhecida (posicionada ou não) ── */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] text-text-dim">Antenas (posição em metros)</span>
          {rows.length === 0 ? (
            <p className="text-[12px] text-text-muted">
              Nenhuma estação conhecida ainda. Ligue uma estação BLE para posicioná-la aqui.
            </p>
          ) : (
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-[11px] text-text-muted">
                  <th className="py-1 pr-2 font-medium">Nome</th>
                  <th className="w-24 py-1 pr-2 font-medium">X (m)</th>
                  <th className="w-24 py-1 font-medium">Y (m)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const cell = pos[r.id] ?? { x: "", y: "" };
                  return (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-1 pr-2">
                        <span className="flex items-center gap-2">
                          <StatusDot
                            tone={r.live ? "info" : "neutral"}
                            label={r.live ? "estação viva" : "estação sem sinal"}
                          />
                          <span className="truncate text-text">{r.label}</span>
                        </span>
                      </td>
                      <td className="py-1 pr-2">
                        <Input
                          type="number"
                          step="0.1"
                          inputMode="decimal"
                          className="min-w-0 w-20"
                          aria-label={`X de ${r.label} em metros`}
                          value={cell.x}
                          onChange={(e) => setCell(r.id, { x: e.target.value })}
                        />
                      </td>
                      <td className="py-1">
                        <Input
                          type="number"
                          step="0.1"
                          inputMode="decimal"
                          className="min-w-0 w-20"
                          aria-label={`Y de ${r.label} em metros`}
                          value={cell.y}
                          onChange={(e) => setCell(r.id, { y: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </form>
    </Dialog>
  );
}
