// Tipos compartilhados entre UsersPage (pai/orquestrador) e as seções (abas).
// Estado que cruza seções (reveal/confirmRemove) e formulários que precisam
// sobreviver à troca de aba vivem no pai; estes tipos descrevem esses contratos.

export type Reveal = { usuario: string; senha: string };

// cameraIds: só relevante quando papel === "cliente" (câmeras alocadas — RBAC com escopo);
// demais papéis ignoram o campo. Opcional aqui pra não obrigar todo call-site a preenchê-lo.
export type NovoUser = { usuario: string; senha: string; papel: string; cameraIds?: string[] };

// Confirmação destrutiva centralizada (substitui window.confirm) — Radix AlertDialog controlado.
export type ConfirmRemove = {
  title: string;
  description: string;
  run: () => void;
};
