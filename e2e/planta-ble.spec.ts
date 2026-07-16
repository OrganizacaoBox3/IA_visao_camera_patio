import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const HUB = "http://127.0.0.1:4100";

async function seedPlanta(request: APIRequestContext) {
  const login = await request.post(`${HUB}/api/login`, {
    data: { usuario: "admin", senha: "admin@box3" },
  });
  expect(login.ok()).toBe(true);
  const session = (await login.json()) as { token: string };
  const headers = { authorization: `Bearer ${session.token}` };

  for (const stationId of ["e2e-norte", "e2e-sul", "e2e-leste"]) {
    const seen = await request.post(`${HUB}/api/bt/reading`, {
      data: { stationId, readings: [] },
    });
    expect(seen.ok()).toBe(true);
  }

  const saved = await request.put(`${HUB}/api/floorplan`, {
    headers,
    data: {
      floorplan: {
        widthM: 50,
        heightM: 40,
        stations: {
          "e2e-norte": { x: 5, y: 5 },
          "e2e-sul": { x: 45, y: 5 },
          "e2e-leste": { x: 25, y: 35 },
        },
      },
    },
  });
  expect(saved.ok()).toBe(true);
}

async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: /Mapa de tags/i })).toBeVisible();
}

test.describe("Planta BLE", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("configuração mobile reutiliza o mapa para desenhar áreas e mantém a calibração alcançável", async ({
    page,
    request,
  }) => {
    await seedPlanta(request);
    await login(page);
    await page.goto("/planta-ble");
    await expect(page.getByRole("heading", { name: "Planta BLE" })).toBeVisible();
    await page.getByRole("button", { name: "Configurar planta" }).click();

    const titleFits = await page.getByRole("heading", { name: "Planta BLE" }).evaluate((el) => {
      const parent = el.parentElement;
      return !!parent && parent.scrollWidth <= parent.clientWidth + 1;
    });
    expect(titleFits, "o bloco do titulo nao pode ser comprimido/cortado").toBe(true);

    await expect(page.getByLabel(/^X de .*\(m\)$/)).toHaveCount(0);
    await page.getByRole("button", { name: "Ajustar" }).first().click();
    await expect(page.getByLabel(/^X de .*\(m\)$/)).toHaveCount(1);

    await page.getByRole("tab", { name: "Áreas" }).click();
    await page.getByLabel("Nome da nova área").fill("Mesa E2E");
    await page.getByRole("button", { name: "Desenhar área no mapa" }).click();
    const areaCanvas = page.getByLabel("Planta baixa 2D — edição das áreas físicas");
    const areaBox = await areaCanvas.boundingBox();
    expect(areaBox).not.toBeNull();
    await page.mouse.move(areaBox!.x + 95, areaBox!.y + 95);
    await page.mouse.down();
    await page.mouse.move(areaBox!.x + 175, areaBox!.y + 155, { steps: 4 });
    await page.mouse.up();
    await expect(
      page.getByRole("list", { name: "Áreas físicas cadastradas" }).getByText("Mesa E2E"),
    ).toBeVisible();
    await expect(page.getByText("Área de trabalho salva.")).toBeVisible();

    await page.getByRole("tab", { name: "Calibração BLE" }).click();
    const calibrar = page.getByRole("button", { name: "Capturar amostra" }).last();
    await calibrar.scrollIntoViewIfNeeded();
    await expect(calibrar).toBeVisible();
    const box = await calibrar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844 - 52);

    const width = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(width.page).toBeLessThanOrEqual(width.viewport + 1);

    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations
        .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
        .map((violation) => violation.id),
      "a configuração da Planta BLE não pode introduzir violações sérias de acessibilidade",
    ).toEqual([]);
  });
});
