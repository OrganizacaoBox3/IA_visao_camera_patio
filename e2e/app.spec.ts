import { test, expect, type Page, type BrowserContext } from "@playwright/test";

// Login real (hub valida POST /api/login → token → socket autenticado).
async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: /Central de câmeras/i })).toBeVisible();
}

// Abre um nó de câmera (webcam fake) e espera ele aparecer no dashboard.
async function connectCamera(context: BrowserContext, dashboard: Page) {
  const cam = await context.newPage();
  await cam.goto("/camera?key=e2e-cam&name=E2E-CAM");
  await expect(dashboard.getByText("E2E-CAM")).toBeVisible({ timeout: 30_000 });
  return cam;
}

test("login + navegação das telas principais", async ({ page }) => {
  await login(page);
  await page.getByRole("link", { name: /Relatório/i }).click();
  await expect(page.getByRole("heading", { name: /Relatório Operacional/i })).toBeVisible();
  await page.getByRole("link", { name: /Usuários/i }).click();
  await expect(page).toHaveURL(/\/usuarios/);
  await page.getByRole("link", { name: /Meu perfil/i }).click();
  await expect(page).toHaveURL(/\/perfil/);
});

test("regressão: Select abre e seleciona DENTRO do modal de config da zona", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);

  // abre a câmera (workspace cheio com as zonas padrão)
  await page.locator(".tile[title='Abrir câmera']").first().click();

  // ⚙ Configurar zona → Dialog
  await page.getByRole("button", { name: "Configurar zona" }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();

  // O BUG: o dropdown do Select abria ATRÁS do overlay → clique não pegava.
  const modo = dlg.getByLabel("Modo da zona");
  await modo.click();
  const opt = page.getByRole("option", { name: "Leitura" });
  await expect(opt).toBeVisible(); // dropdown na frente do overlay
  await opt.click(); // clique funciona
  await expect(modo).toContainText("Leitura"); // valor mudou → confirmado
});

test("regressão: Select funciona no modal '⚙ Câmeras' do dashboard", async ({ page, context }) => {
  await login(page);
  await connectCamera(context, page);

  await page.getByRole("button", { name: /Câmeras/i }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();

  const tipo = dlg.getByLabel("Tipo da câmera");
  await tipo.click();
  const opt = page.getByRole("option", { name: /Operador \(fadiga\)/i });
  await expect(opt).toBeVisible();
  await opt.click();
  await expect(tipo).toContainText(/Operador/i);
});

// BUG relatado: abrir um Select e fechá-lo (ESC ou clique fora) estava FECHANDO O MODAL.
// O Radix deve dismissar só a camada de cima (o Select), mantendo o Dialog aberto.
test("Select aberto: ESC e clique-fora fecham só o Select, não o Dialog (dashboard)", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);

  await page.getByRole("button", { name: /Câmeras/i }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  const tipo = dlg.getByLabel("Tipo da câmera");

  // 1) ESC fecha só o Select
  await tipo.click();
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0); // select fechou
  await expect(dlg).toBeVisible(); // dialog continua aberto

  // 2) clique no OVERLAY com o Select aberto deve fechar só o Select (Radix:
  //    Select tem disableOutsidePointerEvents → blinda o Dialog na 1ª interação).
  //    Usa locator CSS porque o Select aberto deixa o resto aria-hidden.
  await tipo.click();
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.locator(".ui-overlay").click({ position: { x: 5, y: 5 } });
  await expect(page.getByRole("option")).toHaveCount(0); // select fechou
  await expect(page.locator(".ui-dialog")).toBeVisible(); // dialog NÃO deve fechar

  // 3) sem Select aberto, clicar no overlay DEVE fechar o dialog (dismiss normal preservado)
  await page.locator(".ui-overlay").click({ position: { x: 5, y: 5 } });
  await expect(page.locator(".ui-dialog")).toHaveCount(0);
});

test("Select aberto: ESC fecha só o Select, não a câmera fullscreen (config de zona)", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await page.getByRole("button", { name: "Configurar zona" }).first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();

  const modo = dlg.getByLabel("Modo da zona");
  await modo.click();
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0); // select fechou
  await expect(dlg).toBeVisible(); // dialog de zona continua
  // e a câmera fullscreen (overlay) continua aberta
  await expect(page.locator(".cam")).toBeVisible();
});

// Câmera IP/RTSP pela home (superadmin). O e2e loga como "admin", que É superadmin, então o
// botão "+ Câmera IP" aparece. Cobre: abrir o Dialog e a VALIDAÇÃO de url no cliente (url inválida
// bloqueia antes de chamar a API). Não confirmamos uma url válida aqui para não cadastrar uma
// câmera real no hub (subiria ffmpeg); a criação em si é coberta pelo unit test do client + backend.
test("+ Câmera IP: abre o Dialog e a validação de url bloqueia url inválida (superadmin)", async ({
  page,
}) => {
  await login(page);

  const btn = page.getByRole("button", { name: /\+ Câmera IP/i });
  await expect(btn).toBeVisible(); // visível p/ superadmin
  await btn.click();

  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(/Câmeras IP/i);

  // URL inválida (sem esquema rtsp/http) → validação no cliente bloqueia com mensagem, sem enviar.
  await dlg.getByLabel("URL da câmera").fill("nao-e-uma-url");
  await dlg.getByRole("button", { name: "Adicionar câmera" }).click();
  await expect(dlg.getByText(/URL inválida/i)).toBeVisible();
  await expect(dlg).toBeVisible(); // dialog continua aberto (nada foi criado)
});

// ── R3.3 — cobertura das primitivas Radix da migração (Onda G): Tabs + AlertDialog ──

// Tabs internas do Relatório (Radix Tabs): semântica ARIA (role tab/tabpanel), navegação por
// SETAS (ativação automática) e clique; só o painel ativo fica no DOM.
//
// NOTA DETERMINISMO: as abas internas do Relatório só montam quando há histórico (`!noData`).
// O hub do E2E sobe SEM Postgres (global-setup), então `GET /api/data/ativ/buckets` devolve [] e
// a página fica no estado "sem dados" — as abas nunca renderizariam. Mockamos APENAS essa rota
// (só metadados agregados, coerente com LGPD) para exercitar a SEMÂNTICA das abas, não os dados.
test("Tabs (Relatório): setas/clique trocam a aba e só o tabpanel ativo é exibido", async ({
  page,
}) => {
  await login(page);

  const hourStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  await page.route("**/api/data/ativ/buckets", (route) =>
    route.fulfill({
      json: [
        {
          id: `e2e|z1|${hourStart}`,
          cameraId: "e2e",
          area: "Doca 1",
          atividade: "Separação",
          hourStart,
          idleMs: 1_800_000,
          alerts: 2,
          samples: 100,
          activeSamples: 60,
          peoplePeak: 3,
        },
      ],
    }),
  );

  await page.getByRole("link", { name: /Relatório/i }).click();
  await expect(page.getByRole("heading", { name: /Relatório Operacional/i })).toBeVisible();

  // Modo "Atividade" (SegmentedControl) → expõe as abas internas Radix.
  await page.getByRole("button", { name: "Atividade" }).click();

  const tablist = page.getByRole("tablist", { name: "Seção" });
  await expect(tablist).toBeVisible();
  await expect(tablist.getByRole("tab")).toHaveCount(4);

  // Estado inicial: "Quando para" ativa; um único tabpanel no DOM, com o conteúdo certo.
  const tQuando = tablist.getByRole("tab", { name: "Quando para" });
  const tOnde = tablist.getByRole("tab", { name: "Onde para" });
  const tTendencia = tablist.getByRole("tab", { name: "Tendência" });
  await expect(tQuando).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toContainText("horários críticos");

  // Navegação por SETA (Radix ativa automaticamente a aba focada) → "Onde para".
  await tQuando.click(); // garante o foco na aba selecionada
  await page.keyboard.press("ArrowRight");
  await expect(tOnde).toHaveAttribute("aria-selected", "true");
  await expect(tQuando).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel")).toHaveCount(1); // continua só o ativo
  await expect(page.getByRole("tabpanel")).toContainText("Por área");

  // Troca por CLIQUE → "Tendência".
  await tTendencia.click();
  await expect(tTendencia).toHaveAttribute("aria-selected", "true");
  await expect(tOnde).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(page.getByRole("tabpanel")).toContainText("Tendência (14 dias)");
});

// AlertDialog destrutivo (Radix) na remoção de usuário — substitui o antigo window.confirm.
// Cobre: abrir (role=alertdialog), Cancelar fecha SEM efeito, Confirmar dispara a ação.
// É seguro confirmar: o hub do E2E é isolado/efêmero e o usuário removido é criado no próprio
// teste (descartável), então a ação é reversível no ambiente.
test("AlertDialog (Usuários): abre na remoção; Cancelar não apaga, Confirmar apaga", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("link", { name: /Usuários/i }).click();
  await expect(page).toHaveURL(/\/usuarios/);

  // Cria um usuário descartável para exercitar a remoção sem afetar nada real.
  const nome = `e2e_del_${Date.now()}`;
  await page.getByPlaceholder("Usuário").fill(nome);
  await page.getByRole("button", { name: "Criar" }).click();
  const row = page.getByRole("row").filter({ hasText: nome });
  await expect(row).toBeVisible();

  // 1) Abrir o AlertDialog destrutivo.
  await row.getByRole("button", { name: "Remover" }).click();
  const dlg = page.getByRole("alertdialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("Remover usuário?");
  await expect(dlg).toContainText(nome);

  // 2) Cancelar fecha o diálogo SEM efeito — o usuário permanece na tabela.
  await dlg.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(row).toBeVisible();

  // 3) Confirmar dispara a remoção — o diálogo fecha e o usuário some.
  await row.getByRole("button", { name: "Remover" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remover" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: nome })).toHaveCount(0);
});
