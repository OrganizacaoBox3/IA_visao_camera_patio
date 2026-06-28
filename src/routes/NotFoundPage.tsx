import { useNavigate } from "react-router-dom";
import { Button } from "../ui";

// Rota catch-all (404): URL desconhecida → página com identidade do produto e caminho de volta,
// em vez da tela de erro padrão do React Router.
export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="page">
      <div className="dash-empty" role="alert">
        <p style={{ fontSize: 32, margin: 0 }}>404</p>
        <p><b>Página não encontrada.</b></p>
        <p className="muted">O endereço acessado não existe ou foi movido.</p>
        <p style={{ marginTop: "var(--sp-3)" }}><Button variant="primary" onClick={() => navigate("/")}>Voltar para a Central</Button></p>
      </div>
    </div>
  );
}
