import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// GATE DE A11Y (axe-core) — a regra 15 da doutrina ("a11y é contrato") vira SENSOR, no mesmo
// espírito do gate mobile-390: roda o axe em cada rota ESTÁVEL e FALHA em violação séria
// (impact critical/serious). Violações conhecidas ficam na ALLOWLIST documentada abaixo
// (dívida F1 da spec-padronizacao-interface.md) — o gate nasce VERDE hoje e APERTA conforme a
// F1 fecha: consertou a tela → remove a entrada no MESMO PR (o teste avisa quando sobra folga).
// Mesmo padrão-ratchet do gate estacionário do eval e do scripts/lint-tokens.mjs.
//
// FORA por ora (telas em fluxo — frentes de produto editando AGORA; entram quando pousarem,
// F2 da spec): "/" (Mapa de tags), /turnos, /tags-ble, /replay, /calibracao.

// ── Allowlist de dívida conhecida ─────────────────────────────────────────────────────────────
// Cada entrada: regra do axe + POR QUE está aqui + item da spec que a fecha. Só pode DIMINUIR.
//
// BASELINE (2026-07-12, allowlist vazia): as 7 rotas falham numa ÚNICA regra, color-contrast
// (serious) — zero violação critical. É dívida de TOKEN, não de tela: `--text-muted` sobre
// `--panel`/rail fica abaixo de 4.5:1 nos papéis pequenos (rail-group-h label 11 uppercase — o
// mesmo seletor reprova em TODAS as rotas autenticadas — e textos muted/dim das páginas; no
// login, o parágrafo de rodapé LGPD). Fecha na F1 via ajuste do token (spec §3 DoD "Tokens" +
// doutrina regra 2: -fg deve ter "contraste AA sobre --panel") — 1 token conserta o app; aí a
// entrada sai de TODAS as rotas de uma vez.
type AllowEntry = { id: string; why: string };
const CONTRASTE_MUTED: AllowEntry = {
  id: "color-contrast",
  why: "dívida F1 de token: --text-muted/--text-dim < 4.5:1 sobre --panel/rail (spec §3 'Tokens'; doutrina regra 2)",
};
const ALLOW: Record<string, AllowEntry[]> = {
  login: [CONTRASTE_MUTED],
  monitoramento: [CONTRASTE_MUTED],
  relatorio: [CONTRASTE_MUTED],
  usuarios: [CONTRASTE_MUTED],
  perfil: [CONTRASTE_MUTED],
  "alarmes-saude": [CONTRASTE_MUTED],
  cameras: [CONTRASTE_MUTED],
};

// Mesmo login real do app.spec.ts (hub isolado do global-setup, bootstrap admin).
async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: /Mapa de tags/i })).toBeVisible();
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

test("axe: /relatorio", async ({ page }) => {
  await login(page);
  await page.goto("/relatorio");
  await expect(page.getByRole("heading", { name: /Relatório Operacional/i })).toBeVisible();
  await checkA11y(page, "relatorio");
});

test("axe: /usuarios", async ({ page }) => {
  await login(page);
  await page.goto("/usuarios");
  await expect(page.getByRole("heading", { name: /Usuários/i })).toBeVisible();
  await checkA11y(page, "usuarios");
});

test("axe: /perfil", async ({ page }) => {
  await login(page);
  await page.goto("/perfil");
  await expect(page.getByRole("heading", { name: /Meu perfil/i })).toBeVisible();
  await checkA11y(page, "perfil");
});

test("axe: /alarmes-saude", async ({ page }) => {
  await login(page);
  await page.goto("/alarmes-saude");
  await expect(page.getByRole("heading", { name: /Saúde de alarmes/i })).toBeVisible();
  await checkA11y(page, "alarmes-saude");
});

test("axe: /cameras", async ({ page }) => {
  await login(page);
  await page.goto("/cameras");
  await expect(page.getByRole("heading", { name: "Câmeras", exact: true })).toBeVisible();
  await checkA11y(page, "cameras");
});
