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

test("regressão: Select abre e seleciona DENTRO do modal de config da zona", async ({ page, context }) => {
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
  await expect(opt).toBeVisible();              // dropdown na frente do overlay
  await opt.click();                            // clique funciona
  await expect(modo).toContainText("Leitura");  // valor mudou → confirmado
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
