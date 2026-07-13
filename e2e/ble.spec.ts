import { test, expect, type Page } from "@playwright/test";

// TELA BLE — Tags + Estações numa tela só (spec-arquitetura-informacao §3, desenho C).
// Antes eram DUAS rotas em DOIS grupos de menu (/tags-ble em Operação, /estacoes em Administração).
// Agora: uma rota (/tags-ble), um h1 ("BLE"), duas abas Radix.
//
// ARQUIVO NOVO de propósito: o app.spec.ts está aberto por outras frentes desta onda (paralelismo
// por propriedade EXCLUSIVA de arquivo — CLAUDE.md §5); um spec próprio não colide com ninguém.
//
// O QUE ESTE SPEC **NÃO** COBRE (declarado, não escondido): o RBAC da aba Estações. O fixture do
// e2e só tem o `admin` (superadmin ⇒ canConfigure), então o caminho do OPERADOR (aba em
// somente-leitura, sem botão de escrita) não é alcançável daqui — ele é asserido em
// src/routes/ble/EstacoesList.test.tsx (Vitest, renderToStaticMarkup).

// Login real (mesmo do app.spec.ts/a11y.spec.ts — hub isolado do global-setup).
async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: /Mapa de tags/i })).toBeVisible();
}

test("BLE: uma tela, um h1, duas abas — Tags é a padrão", async ({ page }) => {
  await login(page);
  await page.goto("/tags-ble");

  // UM h1 só: a fusão tinha de matar um dos dois PageHeader (o da Tags e o da Estações).
  await expect(page.getByRole("heading", { name: "BLE", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

  const tablist = page.getByRole("tablist", { name: "Seção" });
  await expect(tablist.getByRole("tab")).toHaveCount(2);
  await expect(tablist.getByRole("tab", { name: "Tags" })).toHaveAttribute("aria-selected", "true");
  await expect(tablist.getByRole("tab", { name: "Estações" })).toHaveAttribute(
    "aria-selected",
    "false",
  );
  // O painel padrão é o das leituras (o operador cai onde já caía antes da fusão).
  await expect(page.getByRole("tabpanel")).toContainText(/ao vivo|conectando/i);
});

test("BLE: a aba Estações abre o cadastro, entra na URL e sobrevive ao F5", async ({ page }) => {
  await login(page);
  await page.goto("/tags-ble");

  await page.getByRole("tab", { name: "Estações" }).click();

  // O painel trocou: sem estação viva no hub do e2e, o vazio explica a auto-descoberta.
  const panel = page.getByRole("tabpanel");
  await expect(panel).toContainText(/Nenhuma estação ainda|Estações BLE|Carregando estações/i);
  // A aba vive na URL (F5 não perde o lugar; a /estacoes morta pode apontar para cá).
  await expect(page).toHaveURL(/\/tags-ble\?aba=estacoes/);

  await page.reload();
  await expect(page.getByRole("tab", { name: "Estações" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Voltar para Tags limpa o parâmetro (/tags-ble continua sendo /tags-ble).
  await page.getByRole("tab", { name: "Tags" }).click();
  await expect(page).toHaveURL(/\/tags-ble$/);
});

// DEEP-LINK da rota morta: quem tinha /estacoes salvo cai na tela nova, JÁ na aba certa.
// ⚠ NAVEGAÇÃO: este teste assume que a rota /estacoes segue registrada em main.tsx como REDIRECT
// (é o que o shim src/routes/EstacoesPage.tsx faz hoje). Se a costura da navegação preferir apagar
// a rota de vez, este teste sai no MESMO PR.
test("BLE: /estacoes (rota antiga) redireciona para a aba Estações", async ({ page }) => {
  await login(page);
  await page.goto("/estacoes");

  await expect(page).toHaveURL(/\/tags-ble\?aba=estacoes/);
  await expect(page.getByRole("heading", { name: "BLE", exact: true, level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Estações" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
