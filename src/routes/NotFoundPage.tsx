import { useNavigate } from "react-router-dom";
import { Button } from "../ui";

// Rota catch-all (404): URL desconhecida → página com identidade do produto e caminho de volta,
// em vez da tela de erro padrão do React Router.
export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="page">
      <div className="dash-empty" role="alert">
        <p className="m-0 text-[32px]">404</p>
        <p>
          <b>Página não encontrada.</b>
        </p>
        <p className="muted">O endereço acessado não existe ou foi movido.</p>
        <p className="mt-3">
          <Button variant="primary" onClick={() => navigate("/")}>
            Voltar para a Central
          </Button>
        </p>
      </div>
    </div>
  );
}
