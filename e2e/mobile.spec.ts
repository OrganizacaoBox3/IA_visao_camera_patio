import { test, expect, type Page } from "@playwright/test";

// Gate MOBILE (iPhone 12 = 390×844): cada tela principal não pode ter scroll horizontal DA PÁGINA
// (o sintoma nº1 de layout quebrado no celular). Conteúdo largo (tabelas/heatmap) deve rolar DENTRO
// da própria caixa, não empurrar a página. Screenshots salvos p/ inspeção visual.
test.use({ viewport: { width: 390, height: 844 } });

const SCREENS = [
  { path: "/", name: "mapa", heading: /Mapa de tags/i },
  { path: "/monitoramento", name: "central", heading: /Central de câmeras/i },
  { path: "/cameras", name: "cameras", heading: /Câmeras/i },
  { path: "/relatorio", name: "relatorio", heading: /Relatório/i },
  { path: "/usuarios", name: "usuarios", heading: /Usuários/i },
  { path: "/perfil", name: "perfil", heading: /perfil/i },
  { path: "/alarmes-saude", name: "saude", heading: /.*/ },
];

async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: /Mapa de tags/i })).toBeVisible(); // home agora é o Mapa
}

test("mobile 390: nenhuma tela tem scroll horizontal da página", async ({ page }) => {
  await login(page);
  const bad: string[] = [];
  for (const s of SCREENS) {
    await page.goto(s.path);
    await page.waitForTimeout(1800); // deixa render/data assíncrona assentar
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
    }));
    const ok = m.sw <= m.iw + 1; // +1 tolera arredondamento sub-pixel
    await page.screenshot({ path: `test-results/mobile/${s.name}.png` });
    console.log(`[mobile] ${s.name}: scrollWidth=${m.sw} innerWidth=${m.iw} → ${ok ? "OK" : "OVERFLOW"}`);
    if (!ok) bad.push(`${s.name}(${m.sw}>${m.iw})`);
  }
  expect(bad, `telas com scroll horizontal no mobile: ${bad.join(", ")}`).toHaveLength(0);
});
