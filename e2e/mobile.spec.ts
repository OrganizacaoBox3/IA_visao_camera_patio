import { test, expect, type Page } from "@playwright/test";

// Gate MOBILE (iPhone 12 = 390×844): cada tela principal não pode ter scroll horizontal DA PÁGINA
// (o sintoma nº1 de layout quebrado no celular). Conteúdo largo (tabelas/heatmap) deve rolar DENTRO
// da própria caixa, não empurrar a página. Screenshots salvos p/ inspeção visual.
test.use({ viewport: { width: 390, height: 844 } });

const SCREENS = [
  // "/" redireciona à Central (a home BLE migrou de repo — ADR-018); o gate cobre a rota canônica.
  { path: "/monitoramento", name: "central", heading: /Central de câmeras/i },
  { path: "/cameras", name: "cameras", heading: /Câmeras/i },
  // /relatorio ABSORVEU a /alarmes-saude (spec-arquitetura-informacao §2): a rota morreu, e com
  // ela a linha deste gate. A cobertura mobile do conteúdo NÃO se perdeu — a faixa de saúde (N1)
  // e as ferramentas/silenciamentos (N5) agora renderizam DENTRO desta mesma tela, no mesmo
  // viewport de 390px. Uma tela a menos para o gestor decidir; nenhuma a menos para o gate.
  { path: "/relatorio", name: "relatorio", heading: /Relatório/i },
  { path: "/usuarios", name: "usuarios", heading: /Usuários/i },
  { path: "/perfil", name: "perfil", heading: /perfil/i },
];

async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  // Home "/" redireciona à Central (ADR-018) — o heading confirma o login E o redirect.
  await expect(page.getByRole("heading", { name: "Central", exact: true })).toBeVisible();
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
    if (s.name === "usuarios") {
      await page.getByRole("tab", { name: "Notificações" }).click();
      await expect(page.getByText(/Destinatários do WhatsApp/)).toBeVisible();
      const notif = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        iw: window.innerWidth,
      }));
      const notifOk = notif.sw <= notif.iw + 1;
      await page.screenshot({ path: "test-results/mobile/usuarios-notificacoes.png" });
      console.log(
        `[mobile] usuarios-notificacoes: scrollWidth=${notif.sw} innerWidth=${notif.iw} → ${notifOk ? "OK" : "OVERFLOW"}`,
      );
      if (!notifOk) bad.push(`usuarios-notificacoes(${notif.sw}>${notif.iw})`);
    }
  }
  expect(bad, `telas com scroll horizontal no mobile: ${bad.join(", ")}`).toHaveLength(0);
});
