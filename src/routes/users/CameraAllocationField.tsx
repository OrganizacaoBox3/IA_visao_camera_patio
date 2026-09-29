// ─────────────────────────────────────────────────────────────────────────────
// CameraAllocationField.tsx — o seletor de "Câmeras alocadas" do papel cliente.
//
// Substitui o ToggleGroup plano anterior por uma lista com busca/filtros (gestão de muitas
// câmeras), indicação de quem já tem cada câmera (exclusividade — server/users.js
// findCameraConflict), feedback por-câmera de salvando/salvo/erro, e restauração do PONTO onde
// o operador estava (scroll + destaque) mesmo depois de um refresh da página — sessionStorage,
// nunca localStorage (é "onde eu estava agora", não preferência permanente).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, AlertTriangle } from "lucide-react";
import { Input, Select, Field, Tooltip, Spinner, Checkbox } from "../../ui";
import type { AdminUser, ConnectedCamera } from "../../api";
import { CAMERA_ESTADO_LABEL } from "../../types/cameraEstado";
import {
  linhasDeCameras,
  matchesFiltro,
  FILTRO_DEFAULT,
  type Filtro,
  type EstadoFiltro,
} from "./cameraAllocation";

// Radix Select trata value="" como "sem valor": o gatilho fica EM BRANCO (achado nos prints do
// teste ao vivo de 2026-09-24 — os filtros apareciam sem rótulo). O filtro puro continua usando
// "" = sem filtro; o sentinela vive só na fronteira do Select.
const TODOS = "__todos__";
const semTodos = (v: string) => (v === TODOS ? "" : v);

export function CameraAllocationField({
  cameras,
  allUsers,
  currentUserId,
  value,
  onToggle,
  storageKey,
}: {
  cameras: ConnectedCamera[];
  allUsers: AdminUser[];
  /** `null` no formulário de "novo usuário" — ele ainda não tem id, então nunca é excluído de
   *  si mesmo (não precisa: um usuário que não existe não pode já possuir nada). */
  currentUserId: string | null;
  value: string[];
  /** Aplica UMA mudança (marcar/desmarcar uma câmera) e resolve/rejeita — o componente usa o
   *  resultado pra mostrar salvando/salvo/erro por câmera. Quem chama decide COMO persistir
   *  (PATCH imediato numa linha existente; só estado local no formulário de criação). */
  onToggle: (cameraId: string, next: boolean) => Promise<void>;
  /** Chave estável desta instância (id do usuário, ou "novo") — cada picker restaura o
   *  PRÓPRIO último ponto, não o de outro cliente na mesma tabela. */
  storageKey: string;
}) {
  const [filtro, setFiltro] = useState<Filtro>(FILTRO_DEFAULT);
  const [pending, setPending] = useState<string | null>(null); // cameraId em voo (1 por vez neste picker)
  const [done, setDone] = useState<{ id: string; ok: boolean; msg?: string } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const STORAGE_KEY = `vp-cam-alloc-last:${storageKey}`;

  // Restaura o PONTO onde o operador estava ao montar (entrar na aba OU voltar de um refresh
  // de página — sessionStorage sobrevive a F5, ao contrário do estado em memória). Só na
  // montagem: é "onde eu estava ao chegar aqui", não algo pra re-disparar a cada render.
  useEffect(() => {
    let lastId: string | null = null;
    try {
      lastId = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      /* storage privado/bloqueado — segue sem restaurar; a tela funciona igual */
    }
    if (!lastId) return;
    const el = rowRefs.current.get(lastId);
    if (!el) return; // filtro escondeu a linha, ou a câmera saiu do registro — nada a destacar
    el.scrollIntoView({ block: "center", behavior: "auto" });
    setHighlight(lastId);
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleToggle(cameraId: string, next: boolean) {
    if (pending) return; // 1 salvamento por vez NESTE picker: o PATCH substitui a lista
    // INTEIRA — dois cliques em paralelo poderiam fazer o 2º apagar o 1º (base desatualizada).
    setPending(cameraId);
    setDone(null);
    try {
      await onToggle(cameraId, next);
      setDone({ id: cameraId, ok: true });
      try {
        sessionStorage.setItem(STORAGE_KEY, cameraId);
      } catch {
        /* sem storage — só perde a restauração pós-refresh, não a ação em si */
      }
    } catch (e) {
      setDone({ id: cameraId, ok: false, msg: e instanceof Error ? e.message : "Falha ao salvar." });
    } finally {
      setPending(null);
      setTimeout(() => setDone((d) => (d && d.id === cameraId ? null : d)), 3000);
    }
  }

  const linhas = useMemo(
    () => linhasDeCameras(cameras, allUsers, currentUserId, value).filter((l) => matchesFiltro(l, filtro)),
    [cameras, allUsers, currentUserId, value, filtro],
  );

  return (
    <Field
      label="Câmeras alocadas"
      hint="Este cliente só vê e recebe notificação das câmeras marcadas aqui. Nenhuma marcada = não vê nenhuma câmera. Uma câmera pertence a um cliente por vez."
    >
      {cameras.length === 0 ? (
        <p className="muted">Nenhuma câmera conectada ainda.</p>
      ) : (
        // DIV, não Fragment: Field injeta aria-describedby quando o filho é ÚNICO
        // (src/ui/form.tsx injectAria) — cloná-lo num Fragment quebra ("Fragment só aceita
        // key/children"). Achado ao testar ao vivo (2026-09-24) — não aparecia em nenhum teste
        // porque nenhum outro Field da casa tinha essa combinação (filho único = Fragment).
        <div>
          <div className="cam-alloc-filtros">
            <Input
              placeholder="Buscar por nome…"
              aria-label="Buscar câmera por nome"
              value={filtro.busca}
              onChange={(e) => setFiltro((f) => ({ ...f, busca: e.target.value }))}
            />
            <Select
              value={filtro.estado || TODOS}
              onChange={(v) => setFiltro((f) => ({ ...f, estado: semTodos(v) as EstadoFiltro }))}
              ariaLabel="Filtrar por estado"
              options={[
                { value: TODOS, label: "Qualquer estado" },
                { value: "ativa", label: "Ativa" },
                { value: "parada", label: "Parada" },
                { value: "producao", label: CAMERA_ESTADO_LABEL.producao },
                { value: "teste", label: CAMERA_ESTADO_LABEL.teste },
                { value: "manutencao", label: CAMERA_ESTADO_LABEL.manutencao },
              ]}
            />
            <Select
              value={filtro.conectividade || TODOS}
              onChange={(v) =>
                setFiltro((f) => ({ ...f, conectividade: semTodos(v) as Filtro["conectividade"] }))
              }
              ariaLabel="Filtrar por conectividade"
              options={[
                { value: TODOS, label: "Online e offline" },
                { value: "online", label: "Online" },
                { value: "offline", label: "Offline" },
              ]}
            />
            <Select
              value={filtro.alocacao || TODOS}
              onChange={(v) => setFiltro((f) => ({ ...f, alocacao: semTodos(v) as Filtro["alocacao"] }))}
              ariaLabel="Filtrar por alocação"
              options={[
                { value: TODOS, label: "Qualquer alocação" },
                { value: "disponivel", label: "Disponível" },
                { value: "deste", label: "Vinculada a este cliente" },
                { value: "deOutro", label: "Vinculada a outro cliente" },
              ]}
            />
          </div>
          {linhas.length === 0 ? (
            <p className="muted">Nenhuma câmera bate com o filtro.</p>
          ) : (
            <ul className="cam-alloc-list">
              {linhas.map(({ cam, estado, own, dono }) => {
                const disabled = !own && !!dono;
                const isPending = pending === cam.id;
                const isDone = done && done.id === cam.id ? done : null;
                return (
                  <li
                    key={cam.id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(cam.id, el);
                      else rowRefs.current.delete(cam.id);
                    }}
                    className={
                      "cam-alloc-row" + (highlight === cam.id ? " cam-alloc-row--highlight" : "")
                    }
                  >
                    <Checkbox
                      checked={own}
                      disabled={disabled || isPending}
                      onCheckedChange={(v) => handleToggle(cam.id, v)}
                      ariaLabel={`Alocar ${cam.label}`}
                    />
                    <span className="cam-alloc-row__label">{cam.label}</span>
                    <span
                      className={
                        "cam-alloc-row__badge " +
                        (cam.online ? "cam-alloc-row__badge--online" : "cam-alloc-row__badge--offline")
                      }
                    >
                      {cam.online ? "online" : "offline"}
                    </span>
                    <span className="cam-alloc-row__badge">{CAMERA_ESTADO_LABEL[estado]}</span>
                    {dono && (
                      <Tooltip
                        content={`Vinculada a "${dono.usuario}" — desvincule lá antes de alocar aqui.`}
                      >
                        <span className="cam-alloc-row__owner">vinculada a {dono.usuario}</span>
                      </Tooltip>
                    )}
                    <span className="cam-alloc-row__status">
                      {isPending && <Spinner />}
                      {isDone?.ok && (
                        <span className="cam-alloc-row__ok">
                          <Check size={14} aria-hidden /> salvo
                        </span>
                      )}
                      {isDone && !isDone.ok && (
                        <span className="cam-alloc-row__err" role="alert">
                          <AlertTriangle size={14} aria-hidden /> {isDone.msg}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Field>
  );
}
