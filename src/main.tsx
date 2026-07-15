import ReactDOM from "react-dom/client";
import { Navigate, createBrowserRouter, RouterProvider } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DashboardPage } from "./routes/DashboardPage";
import { CamerasPage } from "./routes/CamerasPage";
import { CameraPage } from "./routes/CameraPage";
import { ReportPage } from "./routes/ReportPage";
import { UsersPage } from "./routes/UsersPage";
import { ProfilePage } from "./routes/ProfilePage";
import { TurnosPage } from "./routes/TurnosPage";
import { BlePage } from "./routes/ble/BlePage";
import { TagsMapPage } from "./routes/TagsMapPage";
import { PlantaBlePage } from "./routes/PlantaBlePage";
import { ReplayPlayerPage } from "./routes/ReplayPlayerPage";
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
      // Relatório: o histórico E a saúde do sistema de alarme (a faixa do topo). A rota
      // /alarmes-saude morreu na unificação — spec-arquitetura-informacao §2.
      { path: "/relatorio", element: <ReportPage /> },
      // BLE: uma tela, duas abas (Tags | Estações — esta sob canConfigure para escrever).
      // A tag e a estação são os dois lados da mesma pergunta ("por que a tag sumiu?"): viviam
      // em grupos de menu diferentes e agora vivem juntas. spec-arquitetura-informacao §3.
      { path: "/tags-ble", element: <BlePage /> },
      // Alias histórico do mapa (agora a home "/"): mantém deep-links antigos funcionando.
      { path: "/mapa", element: <TagsMapPage /> },
      // Turnos de trabalho (cadastro global — spec-turnos-por-zona F1): o contexto operacional
      // "quando a área deveria estar trabalhando".
      { path: "/turnos", element: <TurnosPage /> },
      // Planta BLE: vista 2D do local por Bluetooth (sem câmera) — ponto X,Y de cada tag em relação
      // às antenas. Leitura livre; a edição do setup (dimensões + antenas) é gateada dentro da página.
      { path: "/planta-ble", element: <PlantaBlePage /> },
      // ── Redirects de cortesia (rotas que MORRERAM; o favorito antigo não leva a 404) ──────────
      // A calibração virou MODO do palco da câmera (não tem mais tela): manda para a Central, que
      // é de onde se abre a câmera e se calibra. A Saúde de alarmes virou a faixa do topo do
      // Relatório. As Estações viraram aba da tela BLE.
      { path: "/calibracao", element: <Navigate to="/monitoramento" replace /> },
      { path: "/alarmes-saude", element: <Navigate to="/relatorio" replace /> },
      { path: "/estacoes", element: <Navigate to="/tags-ble?aba=estacoes" replace /> },
      // Bancada de simulação (docs/cientifica/simulador.md) — player de replay, Fase 0/Trilha P.
      { path: "/replay", element: <ReplayPlayerPage /> },
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
