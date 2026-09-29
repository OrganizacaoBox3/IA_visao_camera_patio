// Lógica PURA da busca/filtro da tela de Câmeras (IpCamerasSection) — separada do componente
// para ter teste rápido sem montar React. Mesmo espírito de users/cameraAllocation.ts.
import type { CameraEstado } from "../../types/cameraEstado";
import type { CameraUtilidade } from "../../api";

export type FiltroCameras = {
  busca: string;
  conexao: "" | "online" | "offline";
  estado: "" | CameraEstado;
  /** "problema" = inútil OU atenção — o atalho de "o que precisa de mim hoje". */
  utilidade: "" | "problema" | "inutil" | "atencao" | "ok";
};
export const FILTRO_CAMERAS_DEFAULT: FiltroCameras = {
  busca: "",
  conexao: "",
  estado: "",
  utilidade: "",
};

export type LinhaFiltravel = {
  id: string;
  label: string;
  online: boolean;
  estado: CameraEstado;
  /** `null` = sem diagnóstico (perfil sem acesso, ou ainda carregando) — filtro de utilidade não se aplica. */
  utilidade: CameraUtilidade | null;
};

/** Casa por nome OU id, sem diferenciar maiúsculas/acentos ("portaria" acha "Portária"). */
function normaliza(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function passaFiltro(l: LinhaFiltravel, f: FiltroCameras): boolean {
  const busca = normaliza(f.busca.trim());
  if (busca && !normaliza(`${l.label} ${l.id}`).includes(busca)) return false;
  if (f.conexao === "online" && !l.online) return false;
  if (f.conexao === "offline" && l.online) return false;
  if (f.estado && l.estado !== f.estado) return false;
  if (f.utilidade) {
    // Sem diagnóstico, a câmera NÃO some da lista quando filtram por problema — ela sai só do
    // filtro "ok": não sabemos se ela é útil, e esconder o desconhecido seria falso-OK.
    if (l.utilidade === null) return false;
    if (f.utilidade === "problema") return l.utilidade === "inutil" || l.utilidade === "atencao";
    return l.utilidade === f.utilidade;
  }
  return true;
}

/** Contagem para o resumo do topo ("12 câmeras · 3 inúteis · 1 pede atenção"). */
export function resumo(linhas: LinhaFiltravel[]) {
  return {
    total: linhas.length,
    offline: linhas.filter((l) => !l.online).length,
    inuteis: linhas.filter((l) => l.utilidade === "inutil").length,
    atencao: linhas.filter((l) => l.utilidade === "atencao").length,
  };
}
