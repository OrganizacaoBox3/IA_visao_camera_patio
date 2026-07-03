import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import { Button, Input, Field, CheckboxRow, Alert, ToggleGroup, PageHeader, useToast } from "../ui";
import { getMe, updateMe, type MeProfile, type NotifPrefs } from "../api";

// "Meu perfil": o próprio usuário cadastra o WhatsApp que recebe os alertas + preferências + opt-in.
// O número é dado pessoal (LGPD) → o opt-in aqui registra o consentimento (optInEm no servidor).
const TIPOS = [
  { key: "atividade", label: "Atividade / parada" },
  { key: "fadiga", label: "Operador / fadiga" },
  { key: "objetos", label: "Objetos / presença" },
  { key: "leitura", label: "Leitura / taxa" },
];
const DEFAULT_PREFS: NotifPrefs = { ativo: true, somenteCriticos: true, tipos: [] };

// Título de seção: h2 semântico com o visual do `.panel h3` (padrão da casa).
// TODO(A1): trocar por <SectionTitle> de src/ui quando o átomo existir.
const H2_SEC =
  "m-0 mb-3 font-bold uppercase tracking-[0.12em] text-text-muted text-[length:var(--fs-label,11px)]";

export function ProfilePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [me, setMe] = useState<MeProfile | null>(null);
  const [whatsapp, setWhatsapp] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [prefs, setPrefs] = useState<NotifPrefs>(DEFAULT_PREFS);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getMe()
      .then((m) => {
        setMe(m);
        setWhatsapp(m.whatsapp || "");
        setOptIn(!!m.optInEm);
        setPrefs(m.filtros ?? DEFAULT_PREFS);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "falha ao carregar"));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setStatus(null);
    try {
      const m = await updateMe({ whatsapp, filtros: prefs, optIn });
      setMe(m);
      setWhatsapp(m.whatsapp || "");
      setOptIn(!!m.optInEm);
      setStatus("Perfil salvo.");
      toast("Perfil salvo.", "ok");
    } catch (e2) {
      const m = e2 instanceof Error ? e2.message : "Falha ao salvar.";
      setErr(m);
      toast(m, "alert");
    }
    setBusy(false);
  }

  const numeroOk = whatsapp.replace(/\D/g, "").length >= 10;
  const willReceive = optIn && prefs.ativo && numeroOk;
  // Microcopy honesta: em vez do críptico "(opt-in/número/ativo)", diz O QUE falta.
  const faltando = [
    !numeroOk && "número válido",
    !optIn && "consentimento",
    !prefs.ativo && "recebimento ativo",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="page">
      <PageHeader title="Meu perfil" />
      <div className="users-body">
        {/* Medida única de conteúdo: os DOIS painéis usam a mesma largura do form
            (.profile-form tem max-width 520px no index.css) — página segue full-width. */}
        <section className="panel w-full max-w-[520px]">
          <h2 className={H2_SEC}>Conta</h2>
          <p className="m-0">
            Usuário <b>{user.usuario}</b> · papel <b>{user.papel}</b>
          </p>
        </section>

        <form className="panel profile-form" onSubmit={save}>
          <h2 className={H2_SEC}>Notificações por WhatsApp</h2>

          <Field label="Número (com DDD)" htmlFor="prof-wpp">
            <Input
              id="prof-wpp"
              placeholder="+55 84 99999-9999"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
            />
          </Field>

          <CheckboxRow id="prof-optin" checked={optIn} onCheckedChange={setOptIn}>
            Autorizo receber alertas operacionais neste número (consentimento — LGPD).
          </CheckboxRow>
          <CheckboxRow
            id="prof-ativo"
            checked={prefs.ativo}
            onCheckedChange={(v) => setPrefs((p) => ({ ...p, ativo: v }))}
          >
            Receber alertas (pode pausar sem apagar o número).
          </CheckboxRow>
          <CheckboxRow
            id="prof-crit"
            checked={prefs.somenteCriticos}
            onCheckedChange={(v) => setPrefs((p) => ({ ...p, somenteCriticos: v }))}
          >
            Apenas alertas críticos.
          </CheckboxRow>

          <div className="prof-tipos">
            <span className="cfg-classes-lbl">Tipos (vazio = todos)</span>
            <ToggleGroup
              type="multiple"
              className="cfg-classes"
              ariaLabel="Tipos de alerta"
              value={prefs.tipos}
              onValueChange={(tipos) => setPrefs((p) => ({ ...p, tipos }))}
              items={TIPOS.map((t) => ({ value: t.key, label: t.label }))}
            />
          </div>

          <div className="prof-actions">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? "Salvando…" : "Salvar"}
            </Button>
            <span className={`prof-state ${willReceive ? "on" : ""}`}>
              {willReceive
                ? "● Este número receberá os alertas."
                : `○ Ainda não receberá alertas — falta: ${faltando}.`}
            </span>
          </div>
          {status && <Alert tone="ok">{status}</Alert>}
          {err && <Alert tone="alert">{err}</Alert>}
          {me?.optInEm ? (
            <p className="muted">
              Consentimento registrado em {new Date(me.optInEm).toLocaleString("pt-BR")}.
            </p>
          ) : null}
        </form>
      </div>
    </div>
  );
}
