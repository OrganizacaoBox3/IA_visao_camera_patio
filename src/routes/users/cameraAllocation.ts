// Lógica PURA por trás de CameraAllocationField.tsx — separada do componente para ter teste
// rápido (Vitest) sem precisar montar React. Duas responsabilidades:
//   ownerOf       — espelho de server/users.js `cameraOwner` (mesma regra de exclusividade,
//                   lida do que o front já tem em mãos — a lista de usuários).
//   matchesFiltro — o predicado de busca/filtro (nome, estado, conectividade, alocação).
import type { AdminUser, ConnectedCamera } from "../../api";
import { cameraEstadoDe, type CameraEstado } from "../../types/cameraEstado";

export type EstadoFiltro = "" | "ativa" | "parada" | CameraEstado;
export type Filtro = {
  busca: string;
  estado: EstadoFiltro;
  conectividade: "" | "online" | "offline";
  alocacao: "" | "disponivel" | "deste" | "deOutro";
};
export const FILTRO_DEFAULT: Filtro = { busca: "", estado: "", conectividade: "", alocacao: "" };

/** Dono ATUAL de `cameraId` entre os clientes ATIVOS (exceto `excludeUserId`), ou `null`.
 *  Espelho de server/users.js `cameraOwner` — mesma regra, sem round-trip novo: o front já
 *  recebe `cameraIds` de todo usuário em `GET /api/users` (superadmin). */
export function ownerOf(
  cameraId: string,
  allUsers: AdminUser[],
  excludeUserId: string | null,
): AdminUser | null {
  return (
    allUsers.find(
      (u) =>
        u.id !== excludeUserId &&
        u.papel === "cliente" &&
        u.ativo &&
        Array.isArray(u.cameraIds) &&
        u.cameraIds.includes(cameraId),
    ) ?? null
  );
}

export type LinhaCamera = {
  cam: ConnectedCamera;
  estado: CameraEstado;
  own: boolean;
  dono: AdminUser | null;
};

/** Monta uma linha por câmera (estado normalizado + quem é dono) — o componente só filtra/desenha. */
export function linhasDeCameras(
  cameras: ConnectedCamera[],
  allUsers: AdminUser[],
  currentUserId: string | null,
  value: string[],
): LinhaCamera[] {
  return cameras.map((cam) => {
    const estado = cameraEstadoDe(cam);
    const own = value.includes(cam.id);
    const dono = own ? null : ownerOf(cam.id, allUsers, currentUserId);
    return { cam, estado, own, dono };
  });
}

/** O predicado de busca/filtro. PURO — a mesma função decide o que a tela mostra e o que o
 *  teste prova, sem duplicar a regra em dois lugares. */
export function matchesFiltro(linha: LinhaCamera, filtro: Filtro): boolean {
  const { cam, estado, own, dono } = linha;
  const buscaLower = filtro.busca.trim().toLowerCase();
  if (buscaLower && !`${cam.label} ${cam.id}`.toLowerCase().includes(buscaLower)) return false;
  if (filtro.estado === "ativa" && estado === "desativada") return false;
  if (filtro.estado === "parada" && estado !== "desativada") return false;
  if (
    (filtro.estado === "producao" || filtro.estado === "teste" || filtro.estado === "manutencao") &&
    estado !== filtro.estado
  )
    return false;
  if (filtro.conectividade === "online" && !cam.online) return false;
  if (filtro.conectividade === "offline" && cam.online) return false;
  if (filtro.alocacao === "disponivel" && (own || dono)) return false;
  if (filtro.alocacao === "deste" && !own) return false;
  if (filtro.alocacao === "deOutro" && !dono) return false;
  return true;
}
