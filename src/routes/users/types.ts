// Tipos compartilhados entre UsersPage (pai/orquestrador) e as seções (abas).
// Estado que cruza seções (reveal/confirmRemove) e formulários que precisam
// sobreviver à troca de aba vivem no pai; estes tipos descrevem esses contratos.

export type Reveal = { usuario: string; senha: string };

export type NovoUser = { usuario: string; senha: string; papel: string };

// Confirmação destrutiva centralizada (substitui window.confirm) — Radix AlertDialog controlado.
export type ConfirmRemove = {
  title: string;
  description: string;
  run: () => void;
};
