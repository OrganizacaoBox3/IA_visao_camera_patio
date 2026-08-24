import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, encerrarSessaoDvr, listAuditoriaDvr, listDvrs } from "../api";
import type { AuditoriaDvr, Dvr } from "../types";
import { Badge, Button, EmptyState, ErrorState, Loading, Select } from "../ui";
import { formatTs } from "../format";
import {
  agruparPorCliente,
  descricaoDvr,
  dvrTemSessaoAtiva,
  dvrUrl,
  enderecoDvr,
  rotuloAcao,
} from "../dvrLogic";

// UI do TÉCNICO da Ponte DVR (C-fe-1 + C-fe-2). Fluxo (NÃO inverter): quem ABRE a sessão/túnel é o
// COLETOR (a pessoa no site libera pelo app) — o técnico só LISTA os DVRs por cliente, vê o status
// da sessão e, para uma sessão ATIVA, abre a web do DVR em NOVA ABA (host_publico) ou ENCERRA.
// Exibição em nova aba, NUNCA iframe (o DVR manda X-Frame-Options, vive em subdomínio próprio e
// depende do redirect 401→login do nginx). "Solicitar acesso"/notificar o site é fora de escopo.

const POLL_MS = 15000; // poll leve p/ refletir timeout/encerramento sem recarregar a página

type Aba = "dvrs" | "auditoria";

// ── inline-confirm de "Encerrar" (padrão mínimo da casa: sem modal/dep nova; 2 passos) ──
function EncerrarSessao({ sessaoId, onDone }: { sessaoId: string; onDone: () => void }) {
  const [confirmando, setConfirmando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function encerrar() {
    setBusy(true);
    setErro(null);
    try {
      await encerrarSessaoDvr(sessaoId);
      onDone(); // o pai re-busca; esta linha some/atualiza
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // api.ts volta ao login
      setErro(err instanceof ApiError ? err.message : "falha ao encerrar");
      setBusy(false);
      setConfirmando(false);
    }
  }

  if (!confirmando) {
    return (
      <Button type="button" onClick={() => setConfirmando(true)}>
        Encerrar
      </Button>
    );
  }
  return (
    <span className="cp-confirm">
      <span className="cp-confirm__q">Encerrar a sessão?</span>
      <Button type="button" variant="primary" onClick={encerrar} disabled={busy}>
        {busy ? "Encerrando…" : "Confirmar"}
      </Button>
      <Button type="button" onClick={() => setConfirmando(false)} disabled={busy}>
        Cancelar
      </Button>
      {erro && <span className="cp-confirm__err">{erro}</span>}
    </span>
  );
}

function DvrRow({ dvr, onChange }: { dvr: Dvr; onChange: () => void }) {
  const ativa = dvrTemSessaoAtiva(dvr);
  const url = ativa && dvr.sessao ? dvrUrl(dvr.sessao.hostPublico) : "";
  return (
    <li className="cp-list__row">
      <div className="cp-list__main">
        <div className="cp-list__name">{dvr.coletor_nome || dvr.id}</div>
        <div className="cp-list__sub">
          {descricaoDvr(dvr)} · <span className="cp-mono">{enderecoDvr(dvr)}</span> · empresa{" "}
          <span className="cp-mono">{dvr.empresa_id_box3}</span>
        </div>
        {ativa && dvr.sessao && (
          <div className="cp-list__sub cp-mono">{dvr.sessao.hostPublico}</div>
        )}
      </div>
      {dvr.coletor_revogado ? (
        <Badge tone="alarm">COLETOR REVOGADO</Badge>
      ) : ativa ? (
        <Badge tone="online">SESSÃO ATIVA</Badge>
      ) : (
        <Badge tone="offline">SEM SESSÃO</Badge>
      )}
      <div className="cp-dvr-acoes">
        {ativa && dvr.sessao ? (
          <>
            {/* NOVA ABA — nunca iframe. rel=noopener: a aba do DVR não acessa window.opener. */}
            <a className="cp-btn cp-btn--primary" href={url} target="_blank" rel="noopener noreferrer">
              Abrir DVR ↗
            </a>
            <EncerrarSessao sessaoId={dvr.sessao.sessaoId} onDone={onChange} />
          </>
        ) : (
          <span className="cp-scope">Aguardando o coletor liberar o acesso</span>
        )}
      </div>
    </li>
  );
}

// ── aba DVRs (C-fe-1) ──
function AbaDvrs() {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; items: Dvr[] }
  >({ kind: "loading" });

  const carregar = useCallback(async (silencioso: boolean) => {
    if (!silencioso) setState({ kind: "loading" });
    try {
      const items = await listDvrs();
      setState({ kind: "ready", items });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // api.ts volta ao login
      const message = err instanceof ApiError ? err.message : "falha ao carregar os DVRs";
      // poll silencioso não sobrescreve uma lista boa com erro transitório.
      setState((prev) => (silencioso && prev.kind === "ready" ? prev : { kind: "error", message }));
    }
  }, []);

  useEffect(() => {
    carregar(false);
    const t = setInterval(() => carregar(true), POLL_MS);
    return () => clearInterval(t);
  }, [carregar]);

  return (
    <div className="cp-section">
      <div className="cp-toolbar">
        <h2>DVRs por cliente</h2>
        <span className="spacer" />
        <Button type="button" onClick={() => carregar(false)}>
          Atualizar
        </Button>
      </div>
      <p className="cp-hint">
        Quem abre a sessão é o coletor no site. Com a sessão ativa, abra a web do DVR em uma nova aba
        ou encerre o acesso.
      </p>
      {state.kind === "loading" && <Loading label="Carregando os DVRs…" />}
      {state.kind === "error" && <ErrorState message={state.message} />}
      {state.kind === "ready" &&
        (state.items.length === 0 ? (
          <EmptyState>Nenhum DVR registrado no seu escopo ainda.</EmptyState>
        ) : (
          agruparPorCliente(state.items).map((g) => (
            <section className="cp-tree-cliente" key={g.clienteId}>
              <h3>{g.clienteNome}</h3>
              <ul className="cp-list">
                {g.dvrs.map((d) => (
                  <DvrRow key={d.id} dvr={d} onChange={() => carregar(false)} />
                ))}
              </ul>
            </section>
          ))
        ))}
    </div>
  );
}

// ── aba Auditoria (C-fe-2) ──
function AbaAuditoria() {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ready"; items: AuditoriaDvr[] }
  >({ kind: "loading" });
  const [filtroColetor, setFiltroColetor] = useState("");

  const carregar = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const items = await listAuditoriaDvr({ limit: 300 });
      setState({ kind: "ready", items });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      setState({ kind: "error", message: err instanceof ApiError ? err.message : "falha ao carregar a auditoria" });
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // Coletores distintos presentes na auditoria (p/ o filtro), no rótulo mais legível disponível.
  const coletores = useMemo(() => {
    if (state.kind !== "ready") return [] as Array<{ id: string; nome: string }>;
    const vistos = new Map<string, string>();
    for (const a of state.items) {
      if (a.coletor_id && !vistos.has(a.coletor_id)) {
        vistos.set(a.coletor_id, a.coletor_nome || a.coletor_id);
      }
    }
    return [...vistos].map(([id, nome]) => ({ id, nome }));
  }, [state]);

  const linhas = useMemo(() => {
    if (state.kind !== "ready") return [];
    return filtroColetor ? state.items.filter((a) => a.coletor_id === filtroColetor) : state.items;
  }, [state, filtroColetor]);

  return (
    <div className="cp-section">
      <div className="cp-toolbar">
        <h2>Auditoria</h2>
        <span className="spacer" />
        <Button type="button" onClick={() => carregar()}>
          Atualizar
        </Button>
      </div>
      <p className="cp-hint">
        Quem/qual DVR/quando: enrollment, registro, sessão (abrir/encerrar/timeout) e acesso do
        técnico.
      </p>
      {state.kind === "ready" && coletores.length > 0 && (
        <div className="cp-create">
          <label className="cp-field">
            <span>Coletor</span>
            <Select value={filtroColetor} onChange={(e) => setFiltroColetor(e.target.value)}>
              <option value="">Todos os coletores</option>
              {coletores.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )}
      {state.kind === "loading" && <Loading label="Carregando a auditoria…" />}
      {state.kind === "error" && <ErrorState message={state.message} />}
      {state.kind === "ready" &&
        (linhas.length === 0 ? (
          <EmptyState>Nenhum evento de auditoria no seu escopo.</EmptyState>
        ) : (
          <div className="cp-table-wrap cp-panel" style={{ padding: 0 }}>
            <table className="cp-table">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Ação</th>
                  <th>Ator</th>
                  <th>Coletor</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((a) => (
                  <tr key={a.id}>
                    <td>{formatTs(a.em)}</td>
                    <td>{rotuloAcao(a.acao)}</td>
                    <td className="cp-mono">{a.ator}</td>
                    <td>{a.coletor_nome || a.coletor_id || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

export function DvrView() {
  const [aba, setAba] = useState<Aba>("dvrs");
  return (
    <div>
      <nav className="cp-subtabs" aria-label="Seções do DVR">
        <button
          className="cp-subtab"
          aria-current={aba === "dvrs" ? "page" : undefined}
          onClick={() => setAba("dvrs")}
        >
          DVRs
        </button>
        <button
          className="cp-subtab"
          aria-current={aba === "auditoria" ? "page" : undefined}
          onClick={() => setAba("auditoria")}
        >
          Auditoria
        </button>
      </nav>
      {aba === "dvrs" ? <AbaDvrs /> : <AbaAuditoria />}
    </div>
  );
}
