import { useState, type Dispatch, type SetStateAction } from "react";
import { Button, IconButton, Input, Dialog, Tooltip, ScrollArea, useToast } from "../../ui";
import { saveViews, ApiError, type SavedView } from "../../api";
import { type Camera } from "./types";

function newViewId(): string {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

type ViewsManagerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  views: SavedView[];
  setViews: Dispatch<SetStateAction<SavedView[]>>;
  setActiveViewId: Dispatch<SetStateAction<string | null>>;
  cameras: Camera[];
  viewsLoading: boolean;
};

// Gerenciador de views por setor (Onda C · item 11) — criar/renomear/excluir + ordenar.
// A LISTA de views é compartilhada (backend): salvar usa PUT /api/views (otimista com rollback).
// A seleção (activeViewId) é preferência local do operador, controlada pelo pai.
export function ViewsManager({
  open,
  onOpenChange,
  views,
  setViews,
  setActiveViewId,
  cameras,
  viewsLoading,
}: ViewsManagerProps) {
  const { toast } = useToast();
  // Editor do gerenciador: editId = id da view em edição, "new" (criando) ou null (nada aberto).
  const [editId, setEditId] = useState<string | "new" | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftIds, setDraftIds] = useState<string[]>([]);

  function handleOpenChange(o: boolean) {
    onOpenChange(o);
    if (!o) setEditId(null);
  }

  function startNewView() {
    setEditId("new");
    setDraftName("");
    setDraftIds([]);
  }
  function startEditView(v: SavedView) {
    setEditId(v.id);
    setDraftName(v.name);
    setDraftIds([...v.cameraIds]);
  }
  function cancelEditView() {
    setEditId(null);
  }
  function toggleDraftCam(id: string) {
    setDraftIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function moveDraftCam(id: string, dir: -1 | 1) {
    setDraftIds((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[i];
      next[i] = next[j];
      next[j] = tmp;
      return next;
    });
  }
  // Salva a LISTA inteira no backend (PUT /api/views), otimista com rollback + toast em erro —
  // mesmo padrão dos alarmes. `prev` é a lista antes da mudança (para reverter se a API falhar).
  async function persistViews(
    next: SavedView[],
    prev: SavedView[],
    okMsg: string,
    okVariant: "ok" | "default" = "ok",
  ) {
    setViews(next); // otimista
    try {
      const saved = await saveViews(next);
      setViews(saved); // adota o que o servidor confirmou
      toast(okMsg, okVariant);
    } catch (e) {
      setViews(prev); // rollback
      toast(e instanceof ApiError ? e.message : "Não foi possível salvar as views.", "alert");
    }
  }
  function saveEditView() {
    const name = draftName.trim() || "View sem nome";
    const prev = views;
    if (editId === "new") {
      const id = newViewId();
      setActiveViewId(id);
      setEditId(null);
      void persistViews([...prev, { id, name, cameraIds: draftIds }], prev, "View salva.");
    } else if (editId) {
      setEditId(null);
      void persistViews(
        prev.map((v) => (v.id === editId ? { ...v, name, cameraIds: draftIds } : v)),
        prev,
        "View salva.",
      );
    } else {
      setEditId(null);
    }
  }
  function deleteView(id: string) {
    const prev = views;
    setActiveViewId((cur) => (cur === id ? null : cur));
    if (editId === id) setEditId(null);
    void persistViews(
      prev.filter((v) => v.id !== id),
      prev,
      "View excluída.",
      "default",
    );
  }
  const camLabel = (id: string): string => cameras.find((c) => c.id === id)?.label ?? id;

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Views por setor"
      description={
        <>
          Monte conjuntos de câmeras por setor (ex.: <b>Docas</b>, <b>Expedição</b>) e alterne
          rápido pelo seletor do cabeçalho. <b>Todas as câmeras</b> é a view padrão. Compartilhadas
          entre todos os operadores (salvas no servidor).
        </>
      }
    >
      {editId === null ? (
        <div className="views-mgr">
          <div className="views-mgr__row views-mgr__row--all">
            <div className="views-mgr__name">
              <b>Todas as câmeras</b>
              <span className="muted">padrão · {cameras.length} câmera(s)</span>
            </div>
          </div>
          {viewsLoading && <p className="empty-note">Carregando views…</p>}
          {!viewsLoading && views.length === 0 && (
            <p className="empty-note">Nenhuma view salva ainda.</p>
          )}
          {views.map((v) => (
            <div key={`vrow-${v.id}`} className="views-mgr__row">
              <div className="views-mgr__name">
                <b>{v.name}</b>
                <span className="muted">{v.cameraIds.length} câmera(s)</span>
              </div>
              <Tooltip content="Editar câmeras, ordem e nome">
                <Button size="sm" onClick={() => startEditView(v)}>
                  Editar
                </Button>
              </Tooltip>
              <Tooltip content="Excluir esta view">
                <Button size="sm" variant="danger" onClick={() => deleteView(v.id)}>
                  Excluir
                </Button>
              </Tooltip>
            </div>
          ))}
          <div className="views-mgr__foot">
            <Button variant="primary" onClick={startNewView}>
              + Nova view
            </Button>
          </div>
        </div>
      ) : (
        <div className="views-mgr views-editor">
          <label className="views-editor__name">
            <span className="ui-label">Nome da view</span>
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Ex.: Docas"
              autoFocus
            />
          </label>

          <div className="views-editor__col">
            <span className="ui-label">Câmeras na view (ordem dos tiles)</span>
            {draftIds.length === 0 ? (
              <p className="empty-note">Adicione câmeras da lista abaixo.</p>
            ) : (
              <ScrollArea className="views-editor__scroll">
                <div className="views-editor__items">
                  {draftIds.map((id, i) => (
                    <div key={`sel-${id}`} className="views-editor__item">
                      <span className="views-editor__pos">{i + 1}</span>
                      <span className="views-editor__lbl">{camLabel(id)}</span>
                      <IconButton
                        label="Subir"
                        onClick={() => moveDraftCam(id, -1)}
                        disabled={i === 0}
                      >
                        ↑
                      </IconButton>
                      <IconButton
                        label="Descer"
                        onClick={() => moveDraftCam(id, 1)}
                        disabled={i === draftIds.length - 1}
                      >
                        ↓
                      </IconButton>
                      <IconButton label="Remover da view" onClick={() => toggleDraftCam(id)}>
                        ✕
                      </IconButton>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>

          <div className="views-editor__col">
            <span className="ui-label">Câmeras disponíveis</span>
            {cameras.filter((c) => !draftIds.includes(c.id)).length === 0 ? (
              <p className="empty-note">Todas as câmeras conectadas já estão na view.</p>
            ) : (
              <ScrollArea className="views-editor__scroll">
                <div className="views-editor__items">
                  {cameras
                    .filter((c) => !draftIds.includes(c.id))
                    .map((c) => (
                      <div key={`av-${c.id}`} className="views-editor__item">
                        <span className="views-editor__lbl">{c.label}</span>
                        <Tooltip content="Adicionar à view">
                          <Button size="sm" onClick={() => toggleDraftCam(c.id)}>
                            + Adicionar
                          </Button>
                        </Tooltip>
                      </div>
                    ))}
                </div>
              </ScrollArea>
            )}
          </div>

          <div className="views-mgr__foot">
            <Button onClick={cancelEditView}>Cancelar</Button>
            <Button variant="primary" onClick={saveEditView}>
              Salvar view
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
