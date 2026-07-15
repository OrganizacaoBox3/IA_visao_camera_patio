import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ApiError,
  createCliente,
  createMembership,
  createPartner,
  createSite,
  createUser,
  deleteMembership,
  listClientes,
  listMemberships,
  listPartners,
  listSites,
  listUsers,
} from "../api";
import type {
  AdminSite,
  AdminUser,
  Cliente,
  Membership,
  Partner,
  Scope,
  ScopeType,
  SiteCreated,
} from "../types";
import { Badge, Button, EmptyState, ErrorState, Field, Input, Loading, Select } from "../ui";

// GERENCIAR — o onboard de um cliente novo pela tela. Cada seção: listar + criar, respeitando o
// ESCOPO (mostramos só os forms de criar que o escopo permite; o gate REAL é a API 403).
//
// Refresh: um contador `version` compartilhado. Criar em qualquer seção o incrementa → todas as
// listas re-buscam (um partner novo aparece no select de cliente etc.). Simples e suficiente.

type Tab = "partners" | "clientes" | "sites" | "users" | "memberships";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "partners", label: "Partners" },
  { id: "clientes", label: "Clientes" },
  { id: "sites", label: "Sites" },
  { id: "users", label: "Usuários" },
  { id: "memberships", label: "Acessos" },
];

// ── hook: lista assíncrona com os 3 estados (carregando/erro/pronto) ──
type ListState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: T[] };

function useAsyncList<T>(loader: () => Promise<T[]>, version: number): ListState<T> {
  const [state, setState] = useState<ListState<T>>({ kind: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    loader()
      .then((items) => alive && setState({ kind: "ready", items }))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) return; // api.ts volta ao login
        setState({
          kind: "error",
          message: err instanceof ApiError ? err.message : "falha ao carregar",
        });
      });
    return () => {
      alive = false;
    };
    // loader é estável (import); re-busca só quando a version muda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return state;
}

// Renderiza os 3 estados de uma lista de forma uniforme.
function ListView<T>({
  state,
  empty,
  children,
}: {
  state: ListState<T>;
  empty: string;
  children: (items: T[]) => ReactNode;
}) {
  if (state.kind === "loading") return <Loading />;
  if (state.kind === "error") return <ErrorState message={state.message} />;
  if (state.items.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <>{children(state.items)}</>;
}

// Botão COPIAR com feedback e fallback p/ contexto sem clipboard API (http/inseguro).
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* silencioso: o valor segue visível p/ cópia manual */
    }
  }
  return (
    <Button type="button" variant="primary" onClick={copy}>
      {copied ? "Copiado!" : "Copiar"}
    </Button>
  );
}

// Banner da site_key CRUA — a credencial do hub, mostrada UMA única vez.
function SiteKeyBanner({ site, onDismiss }: { site: SiteCreated; onDismiss: () => void }) {
  return (
    <div className="cp-sitekey" role="alert">
      <p className="cp-sitekey__title">Site "{site.nome}" criado — a chave do hub</p>
      <div className="cp-sitekey__key">
        <code className="cp-sitekey__value">{site.site_key}</code>
        <CopyButton text={site.site_key} />
      </div>
      <p className="cp-scope" style={{ margin: 0 }}>
        Site ID: <span className="cp-mono">{site.id}</span>
      </p>
      <p className="cp-sitekey__warn">
        Guarde agora: esta chave (a credencial do hub) NÃO será mostrada de novo.
      </p>
      <div style={{ marginTop: "var(--sp-3)" }}>
        <Button type="button" onClick={onDismiss}>
          Já guardei
        </Button>
      </div>
    </div>
  );
}

// Escopo → quem pode CRIAR o quê (só a UI; o backend re-valida com 403).
function canCreate(scope: Scope, what: Tab): boolean {
  const t = scope.scope_type;
  switch (what) {
    case "partners":
      return t === "platform";
    case "clientes":
      return t === "platform" || t === "partner";
    case "sites":
    case "users":
      return t === "platform" || t === "partner" || t === "cliente";
    case "memberships":
      return true; // guardScope decide; até site-admin concede dentro do próprio site
  }
}

// ═══ Partners ═══
function PartnersSection({ scope, version, bump }: SectionProps) {
  const state = useAsyncList<Partner>(listPartners, version);
  const [nome, setNome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = canCreate(scope, "partners");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createPartner(nome.trim());
      setNome("");
      bump();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "falha ao criar partner");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cp-section">
      <h2>Partners</h2>
      {allowed ? (
        <form className="cp-create" onSubmit={submit}>
          <Field label="Nome do partner">
            <Input value={nome} onChange={(e) => setNome(e.target.value)} required disabled={busy} />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !nome.trim()}>
            {busy ? "Criando…" : "Criar partner"}
          </Button>
        </form>
      ) : (
        <p className="cp-hint">Apenas a plataforma cria partners.</p>
      )}
      {error && <ErrorState message={error} />}
      <ListView state={state} empty="Nenhum partner no seu escopo.">
        {(items) => (
          <ul className="cp-list">
            {items.map((p) => (
              <li className="cp-list__row" key={p.id}>
                <div className="cp-list__main">
                  <div className="cp-list__name">{p.nome}</div>
                  <div className="cp-list__sub cp-mono">{p.id}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ListView>
    </div>
  );
}

// ═══ Clientes ═══
function ClientesSection({ scope, version, bump }: SectionProps) {
  const state = useAsyncList<Cliente>(listClientes, version);
  const partners = useAsyncList<Partner>(listPartners, version);
  const [partnerId, setPartnerId] = useState("");
  const [nome, setNome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = canCreate(scope, "clientes");
  const partnerList = partners.kind === "ready" ? partners.items : [];
  const partnerName = (id: string) => partnerList.find((p) => p.id === id)?.nome ?? id;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createCliente(partnerId, nome.trim());
      setNome("");
      bump();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "falha ao criar cliente");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cp-section">
      <h2>Clientes</h2>
      {allowed ? (
        <form className="cp-create" onSubmit={submit}>
          <Field label="Partner">
            <Select
              value={partnerId}
              onChange={(e) => setPartnerId(e.target.value)}
              required
              disabled={busy}
            >
              <option value="">Selecione…</option>
              {partnerList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome do cliente">
            <Input value={nome} onChange={(e) => setNome(e.target.value)} required disabled={busy} />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !partnerId || !nome.trim()}>
            {busy ? "Criando…" : "Criar cliente"}
          </Button>
        </form>
      ) : (
        <p className="cp-hint">Seu escopo não permite criar clientes.</p>
      )}
      {error && <ErrorState message={error} />}
      <ListView state={state} empty="Nenhum cliente no seu escopo.">
        {(items) => (
          <ul className="cp-list">
            {items.map((c) => (
              <li className="cp-list__row" key={c.id}>
                <div className="cp-list__main">
                  <div className="cp-list__name">{c.nome}</div>
                  <div className="cp-list__sub">
                    Partner: {partnerName(c.partner_id)} · <span className="cp-mono">{c.id}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ListView>
    </div>
  );
}

// ═══ Sites ═══
function SitesSection({ scope, version, bump }: SectionProps) {
  const state = useAsyncList<AdminSite>(listSites, version);
  const clientes = useAsyncList<Cliente>(listClientes, version);
  const [clienteId, setClienteId] = useState("");
  const [nome, setNome] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<SiteCreated | null>(null);
  const allowed = canCreate(scope, "sites");
  const clienteList = clientes.kind === "ready" ? clientes.items : [];
  const clienteName = (id: string) => clienteList.find((c) => c.id === id)?.nome ?? id;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const site = await createSite(clienteId, nome.trim());
      setNome("");
      setCreated(site); // mostra a site_key CRUA (uma vez)
      bump();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "falha ao criar site");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cp-section">
      <h2>Sites</h2>
      {created && <SiteKeyBanner site={created} onDismiss={() => setCreated(null)} />}
      {allowed ? (
        <form className="cp-create" onSubmit={submit}>
          <Field label="Cliente">
            <Select
              value={clienteId}
              onChange={(e) => setClienteId(e.target.value)}
              required
              disabled={busy}
            >
              <option value="">Selecione…</option>
              {clienteList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Nome do site">
            <Input value={nome} onChange={(e) => setNome(e.target.value)} required disabled={busy} />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !clienteId || !nome.trim()}>
            {busy ? "Criando…" : "Criar site"}
          </Button>
        </form>
      ) : (
        <p className="cp-hint">Seu escopo não permite criar sites.</p>
      )}
      {error && <ErrorState message={error} />}
      <ListView state={state} empty="Nenhum site no seu escopo.">
        {(items) => (
          <ul className="cp-list">
            {items.map((s) => (
              <li className="cp-list__row" key={s.id}>
                <div className="cp-list__main">
                  <div className="cp-list__name">{s.nome}</div>
                  <div className="cp-list__sub">
                    Cliente: {clienteName(s.cliente_id)} · <span className="cp-mono">{s.id}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </ListView>
    </div>
  );
}

// ═══ Usuários ═══
function UsersSection({ scope, version, bump }: SectionProps) {
  const state = useAsyncList<AdminUser>(listUsers, version);
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = canCreate(scope, "users");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createUser(email.trim(), senha);
      setEmail("");
      setSenha("");
      bump();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "falha ao criar usuário");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cp-section">
      <h2>Usuários</h2>
      {allowed ? (
        <form className="cp-create" onSubmit={submit}>
          <Field label="E-mail">
            <Input
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={busy}
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              autoComplete="new-password"
              value={senha}
              onChange={(e) => setSenha(e.target.value)}
              required
              disabled={busy}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || !email.trim() || !senha}>
            {busy ? "Criando…" : "Criar usuário"}
          </Button>
        </form>
      ) : (
        <p className="cp-hint">Seu escopo não permite criar usuários.</p>
      )}
      <p className="cp-hint">
        Um usuário novo só entra depois de receber um acesso (papel) na aba Acessos.
      </p>
      {error && <ErrorState message={error} />}
      <ListView state={state} empty="Nenhum usuário no seu escopo.">
        {(items) => (
          <ul className="cp-list">
            {items.map((u) => (
              <li className="cp-list__row" key={u.id}>
                <div className="cp-list__main">
                  <div className="cp-list__name">{u.email}</div>
                  <div className="cp-list__sub cp-mono">{u.id}</div>
                </div>
                {u.ativo === false && <Badge tone="neutral">inativo</Badge>}
              </li>
            ))}
          </ul>
        )}
      </ListView>
    </div>
  );
}

// ═══ Acessos (memberships) ═══
const SCOPE_TYPES: ScopeType[] = ["platform", "partner", "cliente", "site"];

function MembershipsSection({ version, bump }: Omit<SectionProps, "scope">) {
  const state = useAsyncList<Membership>(listMemberships, version);
  const users = useAsyncList<AdminUser>(listUsers, version);
  const partners = useAsyncList<Partner>(listPartners, version);
  const clientes = useAsyncList<Cliente>(listClientes, version);
  const sites = useAsyncList<AdminSite>(listSites, version);

  const [userId, setUserId] = useState("");
  const [scopeType, setScopeType] = useState<ScopeType>("site");
  const [scopeId, setScopeId] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const userList = users.kind === "ready" ? users.items : [];
  const partnerList = partners.kind === "ready" ? partners.items : [];
  const clienteList = clientes.kind === "ready" ? clientes.items : [];
  const siteList = sites.kind === "ready" ? sites.items : [];

  // Alvos do scope_id dependem do scope_type escolhido (platform não tem alvo).
  const targets: Array<{ id: string; nome: string }> =
    scopeType === "partner"
      ? partnerList
      : scopeType === "cliente"
        ? clienteList
        : scopeType === "site"
          ? siteList
          : [];
  const needsScopeId = scopeType !== "platform";

  const userEmail = (id: string) => userList.find((u) => u.id === id)?.email ?? id;
  function scopeLabel(m: Membership): string {
    if (m.scope_type === "platform" || !m.scope_id) return m.scope_type;
    const pool =
      m.scope_type === "partner" ? partnerList : m.scope_type === "cliente" ? clienteList : siteList;
    const nome = pool.find((x) => x.id === m.scope_id)?.nome ?? m.scope_id;
    return `${m.scope_type}: ${nome}`;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createMembership({
        user_id: userId,
        scope_type: scopeType,
        scope_id: needsScopeId ? scopeId : null,
        role: role.trim(),
      });
      setRole("");
      setScopeId("");
      bump();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "falha ao conceder acesso");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    setError(null);
    try {
      await deleteMembership(id);
      bump();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "falha ao revogar acesso");
    } finally {
      setRevoking(null);
    }
  }

  const submitDisabled =
    busy || !userId || !role.trim() || (needsScopeId && !scopeId);

  return (
    <div className="cp-section">
      <h2>Acessos</h2>
      <form className="cp-create" onSubmit={submit}>
        <Field label="Usuário">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} required disabled={busy}>
            <option value="">Selecione…</option>
            {userList.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Escopo">
          <Select
            value={scopeType}
            onChange={(e) => {
              setScopeType(e.target.value as ScopeType);
              setScopeId("");
            }}
            disabled={busy}
          >
            {SCOPE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        {needsScopeId && (
          <Field label="Alvo">
            <Select value={scopeId} onChange={(e) => setScopeId(e.target.value)} required disabled={busy}>
              <option value="">Selecione…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nome}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Papel">
          <Input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="ex.: admin, operator, viewer"
            required
            disabled={busy}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={submitDisabled}>
          {busy ? "Concedendo…" : "Conceder acesso"}
        </Button>
      </form>
      {error && <ErrorState message={error} />}
      <ListView state={state} empty="Nenhum acesso no seu escopo.">
        {(items) => (
          <ul className="cp-list">
            {items.map((m) => (
              <li className="cp-list__row" key={m.id}>
                <div className="cp-list__main">
                  <div className="cp-list__name">{userEmail(m.user_id)}</div>
                  <div className="cp-list__sub">
                    {scopeLabel(m)} · <Badge tone="neutral">{m.role}</Badge>
                  </div>
                </div>
                <Button
                  type="button"
                  onClick={() => revoke(m.id)}
                  disabled={revoking === m.id}
                >
                  {revoking === m.id ? "Revogando…" : "Revogar"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ListView>
    </div>
  );
}

interface SectionProps {
  scope: Scope;
  version: number;
  bump: () => void;
}

export function Manage({ scope }: { scope: Scope }) {
  const [tab, setTab] = useState<Tab>("partners");
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const props: SectionProps = { scope, version, bump };

  return (
    <div>
      <nav className="cp-subtabs" aria-label="Seções do gerenciar">
        {TABS.map((t) => (
          <button
            key={t.id}
            className="cp-subtab"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "partners" && <PartnersSection {...props} />}
      {tab === "clientes" && <ClientesSection {...props} />}
      {tab === "sites" && <SitesSection {...props} />}
      {tab === "users" && <UsersSection {...props} />}
      {tab === "memberships" && <MembershipsSection {...props} />}
    </div>
  );
}
