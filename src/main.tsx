import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DashboardPage } from "./routes/DashboardPage";
import { CamerasPage } from "./routes/CamerasPage";
import { CameraPage } from "./routes/CameraPage";
import { ReportPage } from "./routes/ReportPage";
import { UsersPage } from "./routes/UsersPage";
import { ProfilePage } from "./routes/ProfilePage";
import { AlarmHealthPage } from "./routes/AlarmHealthPage";
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
      { path: "/", element: <DashboardPage /> },
      // Gestão de câmeras (IP + nó local) — ação única de "adicionar câmera" da Central.
      { path: "/cameras", element: <CamerasPage /> },
      { path: "/relatorio", element: <ReportPage /> },
      { path: "/alarmes-saude", element: <AlarmHealthPage /> },
      { path: "/usuarios", element: <UsersPage /> },
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
