import { useEffect, useState } from "react";
import { Check, PencilRuler, Trash2, Undo2, X } from "lucide-react";
import { Badge, Button, Field, Input, useConfirm } from "../ui";
import type { useWorkAreaPolygonEditor } from "./useWorkAreaPolygonEditor";

type Editor = ReturnType<typeof useWorkAreaPolygonEditor>;

export function WorkAreaPanel({ editor, disabled }: { editor: Editor; disabled: boolean }) {
  const confirm = useConfirm();
  const [newLabel, setNewLabel] = useState("");
  const [renameLabel, setRenameLabel] = useState("");
  const selected = editor.areas.find((area) => area.id === editor.selectedId) ?? null;
  const pending = disabled || editor.saving;

  useEffect(() => setRenameLabel(selected?.label ?? ""), [selected?.id, selected?.label]);

  async function remove(id: string, label: string) {
    const accepted = await confirm({
      title: "Remover área de trabalho?",
      description: `A geometria de “${label}” deixará de aparecer no mapa e no cálculo de distância.`,
      confirmLabel: "Remover área",
      variant: "danger",
    });
    if (accepted) await editor.remove(id);
  }

  return (
    <section
      aria-labelledby="work-area-title"
      aria-busy={pending}
      className="flex min-w-0 flex-col gap-3 rounded-sm border border-border bg-panel-2 p-3"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <b id="work-area-title" className="text-body text-text">
            Áreas físicas
          </b>
          <p className="m-0 mt-1 text-sec text-text-muted">
            Desenhe mesas e postos no mapa. A área mede distância, mas nunca reposiciona uma tag.
          </p>
        </div>
        <Badge>{editor.areas.length}</Badge>
      </div>

      <Field label="Nome da nova área" htmlFor="work-area-label">
        <Input
          id="work-area-label"
          value={newLabel}
          placeholder="Ex.: Mesa serigrafia"
          disabled={pending || editor.active}
          onChange={(event) => setNewLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !editor.active) editor.start(newLabel);
          }}
        />
      </Field>

      <Button
        size="sm"
        variant={editor.active ? "ghost" : "primary"}
        active={editor.active}
        block
        disabled={pending}
        onClick={() => (editor.active ? editor.cancel() : editor.start(newLabel))}
      >
        {editor.active ? <X size={15} aria-hidden /> : <PencilRuler size={15} aria-hidden />}
        {editor.active ? "Cancelar desenho" : "Desenhar área no mapa"}
      </Button>

      {editor.active && editor.count > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={editor.undo}>
            <Undo2 size={14} aria-hidden /> Voltar
          </Button>
          <Button size="sm" disabled={pending || editor.count < 3} onClick={editor.close}>
            <Check size={14} aria-hidden /> Concluir
          </Button>
        </div>
      )}

      {(editor.hint || editor.active) && (
        <p className="m-0 rounded-sm border border-border bg-panel px-2 py-2 text-micro text-text-dim">
          {editor.hint ?? "Arraste para criar um retângulo ou clique para marcar os vértices."}
        </p>
      )}

      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
        <b className="text-sec text-text">Áreas cadastradas</b>
        {editor.areas.length === 0 ? (
          <p className="m-0 text-sec text-text-muted">Nenhuma área desenhada.</p>
        ) : (
          <ul
            className="m-0 flex list-none flex-col gap-2 p-0"
            aria-label="Áreas físicas cadastradas"
          >
            {editor.areas.map((area) => (
              <li key={area.id} className="flex min-w-0 items-center gap-1">
                <Button
                  className="h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left"
                  size="sm"
                  variant="ghost"
                  active={editor.selectedId === area.id}
                  disabled={pending || editor.active}
                  onClick={() => editor.selectItem(area.id)}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sec text-text">{area.label}</span>
                    <span className="block text-micro font-normal text-text-muted">
                      {area.polygon.length} vértices · {area.widthM.toFixed(2)} ×{" "}
                      {area.heightM.toFixed(2)} m
                    </span>
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || editor.active}
                  aria-label={`Remover ${area.label}`}
                  onClick={() => remove(area.id, area.label)}
                >
                  <Trash2 size={14} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && !editor.active && (
        <Field label="Nome da área selecionada" htmlFor="selected-work-area-label">
          <Input
            id="selected-work-area-label"
            value={renameLabel}
            disabled={pending}
            onChange={(event) => setRenameLabel(event.target.value)}
            onBlur={() => {
              if (renameLabel.trim() && renameLabel.trim() !== selected.label) {
                void editor.rename(selected.id, renameLabel);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </Field>
      )}

      {editor.message && (
        <p
          className={
            editor.message.tone === "alert"
              ? "m-0 text-micro text-critical"
              : "m-0 text-micro text-ok"
          }
          role={editor.message.tone === "alert" ? "alert" : "status"}
          aria-live="polite"
        >
          {editor.message.text}
        </p>
      )}
    </section>
  );
}
