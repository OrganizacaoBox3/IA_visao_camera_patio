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

  const willReceive = optIn && prefs.ativo && whatsapp.replace(/\D/g, "").length >= 10;

  return (
    <div className="page">
      <PageHeader title="Meu perfil" />
      <div className="users-body">
        <section className="panel">
          <h3>Conta</h3>
          <p>
            Usuário <b>{user.usuario}</b> · papel <b>{user.papel}</b>
          </p>
        </section>

        <form className="panel profile-form" onSubmit={save}>
          <h3>Notificações por WhatsApp</h3>

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
              {willReceive ? "● receberá alertas" : "○ não receberá (opt-in/número/ativo)"}
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
