import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DashboardPage } from "./routes/DashboardPage";
import { CameraPage } from "./routes/CameraPage";
import { ReportPage } from "./routes/ReportPage";
import { UsersPage } from "./routes/UsersPage";
import { ProfilePage } from "./routes/ProfilePage";
import { NotFoundPage } from "./routes/NotFoundPage";
import { AuthProvider } from "./auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TooltipProvider, ToastProvider } from "./ui";
import "./index.css";

const router = createBrowserRouter([
  {
    // Painel humano: gateado por login (AuthProvider). O Outlet renderiza as páginas dentro do contexto.
    element: <AuthProvider><AppShell /></AuthProvider>,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/relatorio", element: <ReportPage /> },
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
    <TooltipProvider><ToastProvider><RouterProvider router={router} /></ToastProvider></TooltipProvider>
  </ErrorBoundary>
);
