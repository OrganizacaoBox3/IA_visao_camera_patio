import { LocalNodeSection } from "../cameras/LocalNodeSection";

type Props = {
  camToken: string | null;
};

// Aba Câmeras do painel de Usuários: card compacto do nó local (link de inscrição + nota
// apontando a gestão completa em /cameras). A UI/lógica vive em LocalNodeSection (fonte única,
// compartilhada com a tela /cameras); aqui só a consumimos em modo `compact`. O parent
// (UsersPage, superadmin-only) já busca o token e o repassa.
export function CamerasTab({ camToken }: Props) {
  return <LocalNodeSection camToken={camToken} compact />;
}
