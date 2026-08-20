// Lógica PURA da UI do técnico da Ponte DVR (sem React/DOM) — testável, no molde de format.ts.
// Casa DVR↔sessão↔"Abrir DVR" (nova aba) e traduz as ações da auditoria p/ pt-BR.

import type { Dvr } from "./types";

// Um DVR tem túnel utilizável agora? Só então a UI oferece "Abrir DVR" (nova aba) / "Encerrar".
export function dvrTemSessaoAtiva(dvr: Pick<Dvr, "sessao">): boolean {
  return !!dvr.sessao && dvr.sessao.status === "ativa";
}

// URL da web do DVR (aberta em NOVA ABA — nunca iframe: o DVR manda X-Frame-Options, vive em
// subdomínio próprio e depende do redirect 401→login do nginx). host vazio → "" (a UI não linka).
export function dvrUrl(hostPublico: string | null | undefined): string {
  const h = String(hostPublico ?? "").trim();
  return h ? `https://${h}` : "";
}

// Agrupa os DVRs por cliente preservando a ordem de chegada (backend já ordena por criado_em).
export function agruparPorCliente(
  dvrs: Dvr[],
): Array<{ clienteId: string; clienteNome: string; dvrs: Dvr[] }> {
  const ordem: string[] = [];
  const porCliente = new Map<string, { clienteId: string; clienteNome: string; dvrs: Dvr[] }>();
  for (const d of dvrs) {
    let g = porCliente.get(d.cliente_id);
    if (!g) {
      g = { clienteId: d.cliente_id, clienteNome: d.cliente_nome, dvrs: [] };
      porCliente.set(d.cliente_id, g);
      ordem.push(d.cliente_id);
    }
    g.dvrs.push(d);
  }
  return ordem.map((id) => porCliente.get(id)!);
}

// Rótulo pt-BR da ação auditada. Ação desconhecida cai para o próprio código (honesto, sem mascarar).
const ROTULOS_ACAO: Record<string, string> = {
  enrollment: "Enrollment (cliente ↔ coletor)",
  "dvr.registrar": "DVR registrado",
  "dvr.atualizar": "DVR atualizado",
  "sessao.abrir": "Sessão aberta",
  "sessao.encerrar": "Sessão encerrada",
  "sessao.timeout": "Sessão expirada (timeout)",
  "acesso.tecnico": "Acesso do técnico",
};
export function rotuloAcao(acao: string): string {
  return ROTULOS_ACAO[acao] ?? acao;
}

// Descrição curta do aparelho (marca/modelo) p/ a linha — vazio vira "—".
export function descricaoDvr(dvr: Pick<Dvr, "marca" | "modelo">): string {
  const partes = [dvr.marca, dvr.modelo].filter((s): s is string => !!s);
  return partes.length ? partes.join(" ") : "—";
}

// Endereço LAN do DVR (ip:porta) p/ exibição — vazio vira "—".
export function enderecoDvr(dvr: Pick<Dvr, "ip" | "porta">): string {
  if (!dvr.ip) return "—";
  return dvr.porta != null ? `${dvr.ip}:${dvr.porta}` : dvr.ip;
}
