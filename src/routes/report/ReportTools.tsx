// N5 — FERRAMENTAS do Relatório (o rodapé de engenharia): silenciamentos (shelving) · limpar
// histórico · fonte do histórico. Vinha da rota /alarmes-saude, que morreu.
//
// RBAC — O RISCO QUE ESTE ARQUIVO EXISTE PARA NÃO DEIXAR PASSAR (spec §2.5):
// a Saúde de alarmes era protegida pela ROTA (o link só aparecia p/ canConfigure). Ao virar SEÇÃO
// de uma tela que TODO operador abre, a proteção da rota some — então o gate tem de ser EXPLÍCITO
// aqui dentro, senão ação de configuração vaza para o operador:
//   • a seção inteira (lista + form de silenciamento) exige `canConfigure`;
//   • "limpar histórico" exige `isSuper` — é o gate que o SERVIDOR já aplica (requireSuper,
//     server/routes/data.js:36). O botão antigo aparecia para todos só para dizer "não": um botão
//     que existe para negar é ruído, não é segurança.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Hourglass, Trash2 } from "lucide-react";
import {
  AlertDialog,
  Alert,
  Button,
  EmptyState,
  Field,
  Input,
  ScrollArea,
  Select,
  SectionTitle,
  Spinner,
  Tooltip,
  useToast,
} from "../../ui";
import {
  createShelve,
  deleteShelve,
  getConnectedCameras,
  getZones,
  listShelves,
  type ConnectedCamera,
  type DataPersistence,
  type Shelve,
} from "../../api";
import "./health.css";

// Opções de duração do silenciamento (com expiração automática — nunca desliga permanente).
const DUR_OPTS = [
  { value: String(15 * 60_000), label: "15 minutos" },
  { value: String(30 * 60_000), label: "30 minutos" },
  { value: String(60 * 60_000), label: "1 hora" },
  { value: String(120 * 60_000), label: "2 horas" },
  { value: String(8 * 60 * 60_000), label: "8 horas (turno)" },
];

// Tipos de alerta da política (contrato AlarmTipo) — "*" = curinga do back ("qualquer").
const ANY = "*";
const TIPO_LABEL: Record<string, string> = {
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Operador (fadiga)",
  presenca: "Presença", // violação de zona proibida (spec alerta-por-atividade)
};
const TIPO_OPTS = [
  { value: ANY, label: "Qualquer tipo" },
  ...Object.entries(TIPO_LABEL).map(([value, label]) => ({ value, label })),
];

function fmtDuration(ms: number): string {
  if (ms <= 0) return "expirado";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function ReportTools({
  isSuper,
  dataSource,
  busy,
  onClear,
}: {
  /** superadmin — o gate REAL de "limpar histórico" (o servidor barra o resto). */
  isSuper: boolean;
  /** persistência do histórico (pg/json). Desceu da toolbar do gestor p/ cá: ninguém AGE sobre
   *  "banco vs arquivo" no meio de um relatório — é informação de engenharia. */
  dataSource: DataPersistence | null | undefined;
  busy: boolean;
  onClear: () => void;
}) {
  const { toast } = useToast();
  const [shelves, setShelves] = useState<Shelve[] | null>(null);
  const [cams, setCams] = useState<ConnectedCamera[]>([]);
  const [confirmClear, setConfirmClear] = useState(false);

  // Builder do silenciamento: 3 Selects (câmera → zona → tipo) MONTAM a chave `cameraId|zona|tipo`
  // do contrato do back por baixo — ninguém digita chave crua.
  const [fCam, setFCam] = useState(ANY);
  const [fZona, setFZona] = useState(ANY);
  const [fTipo, setFTipo] = useState(ANY);
  const [fDur, setFDur] = useState(DUR_OPTS[1].value);
  const [fReason, setFReason] = useState("");
  const [fBusy, setFBusy] = useState(false);
  const [fErr, setFErr] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [zoneOpts, setZoneOpts] = useState<string[]>([]);

  // CARGA ÚNICA (sem timer): o corpo do Relatório não pisca embaixo do gestor — só a faixa N1
  // tem relógio. A lista de shelves se atualiza nas AÇÕES (criar/remover) e no F5.
  // Câmeras vêm por HTTP (/api/cameras/connected — só identidade+estado, sem url): a tela antiga
  // abria um SOCKET só p/ ter os rótulos; um relatório não precisa de socket.
  const loadShelves = useCallback(async () => {
    try {
      setShelves(await listShelves());
    } catch {
      setShelves([]); // falha aqui não derruba o relatório — a seção mostra "nenhum"
    }
  }, []);
  useEffect(() => {
    void loadShelves();
    getConnectedCameras()
      .then((r) => setCams(r.cameras))
      .catch(() => setCams([]));
  }, [loadShelves]);

  // Zonas da câmera escolhida (rótulos) — zonas de exclusão nunca alarmam, ficam de fora.
  useEffect(() => {
    if (fCam === ANY) {
      setZoneOpts([]);
      return;
    }
    let dead = false;
    getZones(fCam)
      .then((zs) => {
        if (dead) return;
        const labels = zs
          .filter((z) => z.modo !== "exclusao")
          .map((z) => z.label.trim())
          .filter(Boolean);
        setZoneOpts([...new Set(labels)]);
      })
      .catch(() => {
        if (!dead) setZoneOpts([]); // sem zonas → só "qualquer zona" (a câmera inteira)
      });
    return () => {
      dead = true;
    };
  }, [fCam]);

  // Rótulos legíveis (a chave crua nunca renderiza; fica no tooltip p/ diagnóstico).
  const camLabel = useCallback(
    (seg: string) =>
      seg === ANY
        ? "qualquer câmera"
        : (cams.find((c) => c.id.toLowerCase() === seg.toLowerCase())?.label ?? seg),
    [cams],
  );
  const zonaLabel = (seg: string) => (seg === ANY ? "qualquer zona" : seg);
  const tipoLabel = (seg: string) => (seg === ANY ? "qualquer tipo" : (TIPO_LABEL[seg] ?? seg));
  const shelveLabel = useCallback(
    (key: string) => {
      const [cam = ANY, zona = ANY, tipo = ANY] = key.split("|");
      return `${camLabel(cam)} · ${zonaLabel(zona)} · ${tipoLabel(tipo)}`;
    },
    [camLabel],
  );
  const camOpts = useMemo(
    () => [
      { value: ANY, label: "Qualquer câmera" },
      ...cams.map((c) => ({ value: c.id, label: c.label })),
    ],
    [cams],
  );

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    // Guard-rail: "qualquer" nas TRÊS dimensões silenciaria o sistema inteiro.
    if (fCam === ANY && fZona === ANY && fTipo === ANY) {
      setFErr("Escolha ao menos uma dimensão específica (câmera, zona ou tipo).");
      return;
    }
    // Chave do contrato do back ("cameraId|zona|tipo", "*" = curinga) montada aqui;
    // o servidor normaliza (trim/lowercase) via normShelveKey — contrato intacto.
    const key = `${fCam}|${fZona}|${fTipo}`;
    setFBusy(true);
    setFErr(null);
    try {
      await createShelve({ key, ms: Number(fDur), reason: fReason.trim() || undefined });
      setFCam(ANY);
      setFZona(ANY);
      setFTipo(ANY);
      setFReason("");
      toast("Silenciamento criado.", "ok");
      await loadShelves();
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "Falha ao criar o silenciamento.";
      setFErr(msg);
      toast(msg, "alert");
    } finally {
      setFBusy(false);
    }
  }

  async function onRemove(key: string) {
    setRemoving(key);
    try {
      await deleteShelve(key);
      setShelves((s) => (s ? s.filter((x) => x.key !== key) : s));
      toast("Silenciamento removido.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao remover o silenciamento.", "alert");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <section className="ah-tools" aria-label="Ferramentas">
      <SectionTitle>Ferramentas — engenharia</SectionTitle>
      <div className="ah-cols">
        <section className="ah-kpi">
          <h3 className="ah-kpi__label">Silenciamentos ativos</h3>
          {shelves == null ? (
            <div className="ah-foot">
              <Spinner /> carregando…
            </div>
          ) : shelves.length === 0 ? (
            <EmptyState>Nenhum alarme silenciado. Os alertas seguem o fluxo normal.</EmptyState>
          ) : (
            <ScrollArea className="ah-shelves-scroll">
              <div className="ah-shelves">
                {shelves.map((s) => (
                  <div className="ah-shelve" key={s.key}>
                    <div className="ah-shelve__top">
                      {/* Rótulo legível (câmera · zona · tipo); a chave crua do contrato só
                          aparece no tooltip (diagnóstico). */}
                      <Tooltip content={`chave: ${s.key}`}>
                        <span className="ah-shelve__label">{shelveLabel(s.key)}</span>
                      </Tooltip>
                      <span className="ah-shelve__remaining">
                        <Hourglass size={12} strokeWidth={1.75} aria-hidden />{" "}
                        {fmtDuration(s.remainingMs)}
                      </span>
                    </div>
                    <div className="ah-shelve__meta">
                      {s.reason && <span>motivo: {s.reason}</span>}
                      {s.by && <span>por: {s.by}</span>}
                      <span>expira: {new Date(s.expiresAt).toLocaleTimeString("pt-BR")}</span>
                    </div>
                    <div className="ah-shelve__actions">
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={removing === s.key}
                        onClick={() => setConfirmKey(s.key)}
                      >
                        {removing === s.key ? "Removendo…" : "Remover"}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </section>

        <form className="ah-kpi ah-form" onSubmit={onCreate}>
          <h3 className="ah-kpi__label">Silenciar alertas temporariamente</h3>
          <Field label="Câmera">
            <Select
              ariaLabel="Câmera"
              value={fCam}
              onChange={(v) => {
                setFCam(v);
                setFZona(ANY); // zona pertence à câmera — troca de câmera reseta
              }}
              options={camOpts}
            />
          </Field>
          <Field
            label="Zona"
            hint={fCam === ANY ? "Escolha uma câmera para listar as zonas." : undefined}
          >
            <Select
              ariaLabel="Zona"
              value={fZona}
              onChange={setFZona}
              disabled={fCam === ANY}
              options={[
                { value: ANY, label: "Qualquer zona" },
                ...zoneOpts.map((z) => ({ value: z, label: z })),
              ]}
            />
          </Field>
          <Field label="Tipo de alerta">
            <Select ariaLabel="Tipo de alerta" value={fTipo} onChange={setFTipo} options={TIPO_OPTS} />
          </Field>
          <Field label="Duração">
            <Select
              ariaLabel="Duração do silenciamento"
              value={fDur}
              onChange={setFDur}
              options={DUR_OPTS}
            />
          </Field>
          <Field
            label="Motivo (registro)"
            htmlFor="ah-reason"
            hint="Ex.: limpeza da doca, manutenção da câmera."
          >
            <Input
              id="ah-reason"
              placeholder="motivo do silenciamento"
              value={fReason}
              onChange={(e) => setFReason(e.target.value)}
            />
          </Field>
          <p className="ah-form__hint">
            Vai silenciar:{" "}
            <b>
              {camLabel(fCam)} · {zonaLabel(fZona)} · {tipoLabel(fTipo)}
            </b>{" "}
            — expira sozinho ao fim da duração.
          </p>
          <div>
            <Button variant="primary" type="submit" disabled={fBusy}>
              {fBusy ? "Silenciando…" : "Silenciar"}
            </Button>
          </div>
          {fErr && <Alert tone="alert">{fErr}</Alert>}
        </form>
      </div>

      {/* Histórico: a FONTE (informação) e a ação destrutiva (superadmin). */}
      <div className="ah-hist">
        <span className="ah-foot">
          histórico:{" "}
          {dataSource ? (dataSource === "pg" ? "banco" : "arquivo local") : "fonte desconhecida"}
        </span>
        {isSuper && (
          <Button variant="ghost" className="rep-clear" disabled={busy} onClick={() => setConfirmClear(true)}>
            <Trash2 size={16} strokeWidth={1.75} aria-hidden /> Limpar histórico
          </Button>
        )}
      </div>

      <AlertDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        variant="danger"
        title="Limpar todo o histórico?"
        description="Esta ação apaga permanentemente todos os indicadores, eventos e alarmes registrados no histórico do servidor. Não é possível desfazer."
        confirmLabel="Limpar histórico"
        cancelLabel="Cancelar"
        onConfirm={onClear}
        busy={busy}
      />

      <AlertDialog
        open={confirmKey !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmKey(null);
        }}
        title="Remover silenciamento?"
        description={
          confirmKey ? (
            <>
              O silenciamento de <b>{shelveLabel(confirmKey)}</b> será removido e os alertas
              correspondentes voltam ao fluxo normal.
            </>
          ) : undefined
        }
        confirmLabel="Remover"
        cancelLabel="Cancelar"
        variant="danger"
        onConfirm={() => {
          const k = confirmKey;
          setConfirmKey(null);
          if (k) void onRemove(k);
        }}
      />
    </section>
  );
}
