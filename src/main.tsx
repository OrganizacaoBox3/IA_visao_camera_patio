import ReactDOM from "react-dom/client";
import { Navigate, createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DashboardPage } from "./routes/DashboardPage";
import { CamerasPage } from "./routes/CamerasPage";
import { CameraPage } from "./routes/CameraPage";
import { ReportPage } from "./routes/ReportPage";
import { UsersPage } from "./routes/UsersPage";
import { DvrsPage } from "./routes/DvrsPage";
import { IngestLogPage } from "./routes/IngestLogPage";
import { ProfilePage } from "./routes/ProfilePage";
import { TurnosPage } from "./routes/TurnosPage";
import { NotFoundPage } from "./routes/NotFoundPage";
import { AuthProvider } from "./auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TooltipProvider, ToastProvider, ConfirmProvider } from "./ui";
import "./index.css";
import "./tailwind.css";

const router = createBrowserRouter([
  {
    // Painel humano: gateado por login (AuthProvider). O Outlet renderiza as páginas dentro do contexto.
    // ConfirmProvider fica DENTRO da árvore autenticada (só monta quando AuthProvider libera os children),
    // habilitando useConfirm() (confirmações via AlertDialog) nas páginas do shell. Aditivo; não altera rotas.
    element: (
      <AuthProvider>
        <ConfirmProvider>
          <AppShell />
        </ConfirmProvider>
      </AuthProvider>
    ),
    children: [
      // HOME: a Central de câmeras. Redirect (e não render direto) para manter UMA url canônica
      // do dashboard — o item de menu "Central" acende em qualquer entrada. (ADR-018: o Mapa de
      // tags BLE que morava aqui migrou para o repo mvp_trilateracao_BLE.)
      { path: "/", element: <Navigate to="/monitoramento" replace /> },
      { path: "/monitoramento", element: <DashboardPage /> },
      // Gestão de câmeras (IP + nó local) — ação única de "adicionar câmera" da Central.
      { path: "/cameras", element: <CamerasPage /> },
      // Relatório: o histórico E a saúde do sistema de alarme (a faixa do topo). A rota
      // /alarmes-saude morreu na unificação — spec-arquitetura-informacao §2.
      { path: "/relatorio", element: <ReportPage /> },
      // Turnos de trabalho (cadastro global — spec-turnos-por-zona F1): o contexto operacional
      // "quando a área deveria estar trabalhando".
      { path: "/turnos", element: <TurnosPage /> },
      // ── Redirects de cortesia (rotas que MORRERAM; o favorito antigo não leva a 404) ──────────
      // A calibração virou MODO do palco da câmera (não tem mais tela): manda para a Central, que
      // é de onde se abre a câmera e se calibra. A Saúde de alarmes virou a faixa do topo do
      // Relatório. (As rotas BLE — /tags-ble, /mapa, /planta-ble, /estacoes, /replay — migraram
      // para o repo mvp_trilateracao_BLE; ADR-018. Sem redirect: outro produto, outra porta.)
      { path: "/calibracao", element: <Navigate to="/monitoramento" replace /> },
      { path: "/alarmes-saude", element: <Navigate to="/relatorio" replace /> },
      { path: "/usuarios", element: <UsersPage /> },
      // Ponte DVR (suporte): lista os DVRs por cliente + auditoria (gate superadmin dentro da página).
      { path: "/dvrs", element: <DvrsPage /> },
      // Log de ingest RTMP (suporte): canal que chega no relé × câmera cadastrada, sem SSH.
      { path: "/ingest-log", element: <IngestLogPage /> },
      { path: "/perfil", element: <ProfilePage /> },
      // Catch-all (404) dentro do shell autenticado: mantém navegação + identidade do produto.
      { path: "*", element: <NotFoundPage /> },
    ],
  },
  // Nó de câmera: FORA do login humano — autentica por token de dispositivo (?key=) ou sessão local.
  { path: "/camera", element: <CameraPage /> },
]);

ReactDOM.createRoot(document.getElementById("app")!).render(
  <ErrorBoundary>
    <TooltipProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </TooltipProvider>
  </ErrorBoundary>,
);
