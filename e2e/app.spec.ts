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

// MUDANÇA DE PRODUTO (2026-07): a câmera nova abre LIMPA — sem zonas-semente. Os testes de
// config de zona agora DESENHAM a própria zona primeiro: "✎ Zona" + drag real no .cam-stage
// (mesmo padrão dos specs de diagnóstico). Espera o estado vazio da aba Zonas (garante que a
// carga assíncrona terminou E prova o novo comportamento) e retry no drag (o onUp descarta o
// traço se o 1º frame ainda não chegou ao palco).
async function drawZone(page: Page) {
  await expect(page.getByText(/Use “✎ Zona” para desenhar/)).toBeVisible();
  await page.getByRole("button", { name: "✎ Zona" }).click();
  const stage = page.locator(".cam-stage");
  const cfgBtn = page.getByRole("button", { name: "Configurar zona" }).first();
  for (let attempt = 0; attempt < 5; attempt++) {
    const box = await stage.boundingBox();
    if (!box) throw new Error(".cam-stage sem boundingBox");
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65, { steps: 8 });
    await page.mouse.up();
    try {
      await expect(cfgBtn).toBeVisible({ timeout: 2_000 });
      return;
    } catch {
      /* frame ainda não disponível → tenta de novo */
    }
  }
  await expect(cfgBtn).toBeVisible(); // falha com mensagem clara se nenhum drag pegou
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

  // abre a câmera (workspace abre LIMPO — sem zonas-semente) e desenha a zona do teste
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await drawZone(page);

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
  await drawZone(page); // câmera nova abre sem zonas — desenha antes de configurar
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

// Tela de câmeras (/cameras) — fluxo NOVO que unifica "+ Nó de câmera" e "+ Câmera IP" numa ação
// só. O e2e loga como "admin", que É superadmin, então vê a seção de câmeras IP. Cobre: o botão
// único do header da Central navega p/ /cameras; a tela é alcançável pelo MENU; o form de cadastro
// abre em Dialog; e a VALIDAÇÃO de url no cliente (url inválida bloqueia antes de chamar a API).
// Não confirmamos uma url válida aqui para não cadastrar uma câmera real no hub (subiria ffmpeg);
// a criação em si é coberta pelo unit test do client + backend.
test("Câmeras: botão único leva a /cameras e a validação de url bloqueia url inválida (superadmin)", async ({
  page,
}) => {
  await login(page);

  // O header da Central tem UM só botão de câmeras (link p/ /cameras); os antigos sumiram.
  await expect(page.getByRole("button", { name: /\+ Câmera IP/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /\+ Nó de câmera/i })).toHaveCount(0);
  const add = page.getByRole("link", { name: "+ Câmera" });
  await expect(add).toBeVisible();
  await add.click();
  await expect(page).toHaveURL(/\/cameras/);
  // exact: o h2 "Câmeras IP / RTSP" da mesma tela também casaria por substring (strict mode).
  await expect(page.getByRole("heading", { name: "Câmeras", exact: true })).toBeVisible();

  // Seções da tela: câmeras IP (superadmin) + câmera local (nó/webcam).
  await expect(page.getByText("Nenhuma câmera IP cadastrada ainda.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Abrir nó neste dispositivo" })).toBeVisible();

  // Cadastro IP: o form abre em Dialog.
  await page.getByRole("button", { name: "+ Adicionar câmera IP" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(/Adicionar câmera IP/i);

  // URL inválida (sem esquema rtsp/http) → validação no cliente bloqueia com mensagem, sem enviar.
  await dlg.getByLabel("URL da câmera").fill("nao-e-uma-url");
  await dlg.getByRole("button", { name: "Adicionar câmera" }).click();
  await expect(dlg.getByText(/URL inválida/i)).toBeVisible();
  await expect(dlg).toBeVisible(); // dialog continua aberto (nada foi criado)

  // A tela também é alcançável pelo item "Câmeras" do menu lateral.
  await page.keyboard.press("Escape"); // fecha o dialog
  await page.getByRole("link", { name: "Central" }).click();
  await expect(page.getByRole("heading", { name: /Central de câmeras/i })).toBeVisible();
  await page.getByRole("link", { name: "Câmeras" }).click();
  await expect(page).toHaveURL(/\/cameras/);
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
  // 5 abas: Quando/Onde/Tendência/Eventos + "Fluxo de pessoas" (o hub do e2e expõe o
  // kind "flow", então a aba condicional existe — comportamento real do produto).
  await expect(tablist.getByRole("tab")).toHaveCount(5);
  await expect(tablist.getByRole("tab", { name: "Fluxo de pessoas" })).toBeVisible();

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
