import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// GATE DE A11Y (axe-core) — a regra 15 da doutrina ("a11y é contrato") vira SENSOR, no mesmo
// espírito do gate mobile-390: roda o axe em cada rota ESTÁVEL e FALHA em violação séria
// (impact critical/serious). Violações conhecidas ficam na ALLOWLIST documentada abaixo
// (dívida F1 da spec-padronizacao-interface.md) — o gate nasce VERDE hoje e APERTA conforme a
// F1 fecha: consertou a tela → remove a entrada no MESMO PR (o teste avisa quando sobra folga).
// Mesmo padrão-ratchet do gate estacionário do eval e do scripts/lint-tokens.mjs.
//
// APERTADO na F2 (varredura B): /turnos ENTROU no gate. As rotas BLE (/, /tags-ble, /planta-ble,
// /replay) saíram do gate quando o domínio migrou para o repo mvp_trilateracao_BLE (ADR-018) —
// a cobertura delas vive lá. A home "/" agora redireciona a /monitoramento (já varrida).

// ── Allowlist de dívida conhecida ─────────────────────────────────────────────────────────────
// Cada entrada: regra do axe + POR QUE está aqui + item da spec que a fecha. Só pode DIMINUIR.
//
// A dívida global de `color-contrast` foi fechada em 2026-07-15 nos tokens `--text-muted` e
// `--state-neutral-dim`; o teste unitário design-tokens.test.ts trava o AA nas superfícies escuras.
// A allowlist permanece explícita e vazia por rota: qualquer nova exceção exige justificativa local.
type AllowEntry = { id: string; why: string };
const ALLOW: Record<string, AllowEntry[]> = {
  login: [],
  monitoramento: [],
  relatorio: [],
  usuarios: [],
  perfil: [],
  // ("alarmes-saude" saiu: a rota morreu — a Saúde virou a faixa N1 + as ferramentas N5 DENTRO
  //  de /relatorio, e é lá que o axe a varre agora. A cobertura MUDOU DE LUGAR, não sumiu.)
  cameras: [],
  turnos: [],
};

// Mesmo login real do app.spec.ts (hub isolado do global-setup, bootstrap admin).
// Home "/" redireciona à Central (ADR-018) — o heading confirma o login E o redirect.
async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Central", exact: true })).toBeVisible();
}

// Roda o axe e compara com a allowlist da rota: violação séria FORA da lista = falha;
// entrada da lista que não dispara mais = aviso p/ apertar (remover no mesmo PR).
async function checkA11y(page: Page, routeKey: keyof typeof ALLOW) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "critical" || v.impact === "serious",
  );
  const allowed = new Set((ALLOW[routeKey] ?? []).map((a) => a.id));

  const known = serious.filter((v) => allowed.has(v.id));
  const blocked = serious.filter((v) => !allowed.has(v.id));
  const stale = [...allowed].filter((id) => !serious.some((v) => v.id === id));

  for (const v of known)
    console.log(`[a11y] ${routeKey}: dívida conhecida ${v.id} (${v.impact}, ${v.nodes.length} nó(s))`);
  if (stale.length > 0)
    console.log(
      `[a11y] ${routeKey}: allowlist com folga (regra(s) já não disparam): ${stale.join(", ")} — remova no mesmo PR`,
    );

  expect(
    blocked.map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help} → ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ")}${v.nodes.length > 3 ? ` (+${v.nodes.length - 3})` : ""}`,
    ),
    `violação séria de a11y em "${routeKey}" fora da allowlist`,
  ).toEqual([]);
}

test("axe: tela de login", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
  await checkA11y(page, "login");
});

test("axe: /monitoramento (Central)", async ({ page }) => {
  await login(page);
  await page.goto("/monitoramento");
  await expect(page.getByRole("heading", { name: "Central", exact: true })).toBeVisible();
  await checkA11y(page, "monitoramento");
});

// /relatorio ABSORVEU a Saúde de alarmes (spec-arquitetura-informacao §2): a faixa N1 ("o detector
// está confiável?") e as ferramentas N5 (silenciamentos · limpar histórico · fonte) vivem AQUI.
// As duas são asseridas antes do axe: se a fusão regredir e a seção sumir, o teste falha ANTES de
// varrer — em vez de dar "verde" varrendo uma página que perdeu o conteúdo (o axe não sabe o que
// FALTA). É o mesmo motivo de o antigo teste /alarmes-saude ter sido removido, e não só deletado.
test("axe: /relatorio (com a Saúde de alarmes absorvida: N1 + ferramentas N5)", async ({ page }) => {
  await login(page);
  await page.goto("/relatorio");
  await expect(page.getByRole("heading", { name: /Relatório Operacional/i })).toBeVisible();
  await expect(page.getByRole("region", { name: "Saúde do sistema de alarmes" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ferramentas" })).toBeVisible(); // admin = canConfigure
  await checkA11y(page, "relatorio");
});

test("axe: /usuarios", async ({ page }) => {
  await login(page);
  await page.goto("/usuarios");
  await expect(page.getByRole("heading", { name: /Usuários/i })).toBeVisible();
  await checkA11y(page, "usuarios");
  // A aba de destinatários contém os novos seletores de proprietário/principal; precisa ser
  // montada antes do axe, pois Tabs desmonta o conteúdo inativo.
  await page.getByRole("tab", { name: "Notificações" }).click();
  await expect(page.getByText(/Destinatários do WhatsApp/)).toBeVisible();
  await checkA11y(page, "usuarios");
});

test("axe: /perfil", async ({ page }) => {
  await login(page);
  await page.goto("/perfil");
  await expect(page.getByRole("heading", { name: /Meu perfil/i })).toBeVisible();
  await checkA11y(page, "perfil");
});

// (O teste "axe: /alarmes-saude" MORREU com a rota — o conteúdo dele é varrido no /relatorio,
//  onde as duas seções agora vivem e são asseridas explicitamente.)

test("axe: /cameras", async ({ page }) => {
  await login(page);
  await page.goto("/cameras");
  await expect(page.getByRole("heading", { name: "Câmeras", exact: true })).toBeVisible();
  await checkA11y(page, "cameras");
});

test("axe: /turnos", async ({ page }) => {
  await login(page);
  await page.goto("/turnos");
  await expect(page.getByRole("heading", { name: /Turnos/i })).toBeVisible();
  await checkA11y(page, "turnos");
});

// (Os testes de "/" (Mapa de tags), /tags-ble, /planta-ble e /replay MORRERAM com as rotas — o
//  domínio BLE migrou para o repo mvp_trilateracao_BLE (ADR-018) e o gate de a11y dele vive lá.
//  A home "/" redireciona a /monitoramento, já coberta acima.)
