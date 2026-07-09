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
import { BtTagsPage } from "./routes/BtTagsPage";
import { TagsMapPage } from "./routes/TagsMapPage";
import { CalibrationPage } from "./routes/CalibrationPage";
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
      // HOME: o Mapa de tags (estilo AirTag) é a tela principal do produto.
      { path: "/", element: <TagsMapPage /> },
      // Monitoramento (câmeras ao vivo): o antigo dashboard de "/" agora tem lar próprio,
      // continua acessível pela navegação ("Monitoramento").
      { path: "/monitoramento", element: <DashboardPage /> },
      // Gestão de câmeras (IP + nó local) — ação única de "adicionar câmera" da Central.
      { path: "/cameras", element: <CamerasPage /> },
      { path: "/relatorio", element: <ReportPage /> },
      // Tags BLE (identidade aumentada): tela crua das leituras ao vivo da estação.
      { path: "/tags-ble", element: <BtTagsPage /> },
      // Alias histórico do mapa (agora a home "/"): mantém deep-links antigos funcionando.
      { path: "/mapa", element: <TagsMapPage /> },
      // Calibração por câmera (homografia → metros no chão; base da posição por tag BLE).
      { path: "/calibracao", element: <CalibrationPage /> },
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
