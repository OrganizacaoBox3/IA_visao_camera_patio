import { useNavigate } from "react-router-dom";
import { Button, EmptyState, PageHeader } from "../ui";

// Rota catch-all (404): URL desconhecida → página com identidade do produto e caminho de volta,
// em vez da tela de erro padrão do React Router. Padrão da casa: PageHeader (h1 único) +
// EmptyState (status + causa + ação). "Voltar para a Central" leva à Central de câmeras
// (/monitoramento) — terminologia canônica unificada com o nav e o título do dashboard.
export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="page">
      <PageHeader title="Página não encontrada" />
      {/* role=alert: anuncia o erro de rota ao carregar (comportamento anterior preservado). */}
      <div className="grid flex-1 min-h-0 place-items-center" role="alert">
        <EmptyState>
          {/* Display "404" no papel kpi (24, o maior da escala) — fim do 32px bespoke. */}
          <p className="m-0 text-kpi text-text" aria-hidden>
            404
          </p>
          <p className="m-0">
            <b>Página não encontrada.</b>
          </p>
          <p className="muted m-0">O endereço acessado não existe ou foi movido.</p>
          <Button variant="primary" onClick={() => navigate("/monitoramento")}>
            Voltar para a Central
          </Button>
        </EmptyState>
      </div>
    </div>
  );
}
