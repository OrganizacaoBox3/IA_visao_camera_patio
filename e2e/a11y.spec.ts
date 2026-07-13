import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// GATE DE A11Y (axe-core) — a regra 15 da doutrina ("a11y é contrato") vira SENSOR, no mesmo
// espírito do gate mobile-390: roda o axe em cada rota ESTÁVEL e FALHA em violação séria
// (impact critical/serious). Violações conhecidas ficam na ALLOWLIST documentada abaixo
// (dívida F1 da spec-padronizacao-interface.md) — o gate nasce VERDE hoje e APERTA conforme a
// F1 fecha: consertou a tela → remove a entrada no MESMO PR (o teste avisa quando sobra folga).
// Mesmo padrão-ratchet do gate estacionário do eval e do scripts/lint-tokens.mjs.
//
// APERTADO na F2 (varredura B): "/" (Mapa de tags), /turnos, /tags-ble e /replay ENTRARAM no gate
// — as 4 telas novas foram varridas (tokens, semântica, estados, Lucide, canvas/mapa com
// alternativa textual). FORA ainda: /calibracao (frente de produto editando AGORA — entra quando
// pousar, é o último item da F2).

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
  // ("alarmes-saude" saiu: a rota morreu — a Saúde virou a faixa N1 + as ferramentas N5 DENTRO
  //  de /relatorio, e é lá que o axe a varre agora. A cobertura MUDOU DE LUGAR, não sumiu.)
  cameras: [CONTRASTE_MUTED],
  // F2 (varredura B) — mesma dívida de TOKEN das demais (rail-group-h + textos muted da página);
  // zero violação própria de tela.
  mapa: [CONTRASTE_MUTED],
  turnos: [CONTRASTE_MUTED],
  "tags-ble": [CONTRASTE_MUTED],
  replay: [CONTRASTE_MUTED],
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

// ── F2 (varredura B): as 4 telas novas — as que MAIS violavam a constituição ───────────────────
// O login já pousa na home ("/" = Mapa de tags). A lista de tags é a ALTERNATIVA TEXTUAL do mapa
// Leaflet (e existe no mobile agora — antes era `hidden md:flex`).
test("axe: / (Mapa de tags — home)", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("region", { name: "Mapa das tags" })).toBeVisible();
  await checkA11y(page, "mapa");
});

test("axe: /turnos", async ({ page }) => {
  await login(page);
  await page.goto("/turnos");
  await expect(page.getByRole("heading", { name: /Turnos/i })).toBeVisible();
  await checkA11y(page, "turnos");
});

// /tags-ble = a tela BLE unificada (Tags | Estações — spec-arquitetura-informacao §3). O h1 virou
// "BLE" (o menu diz "BLE": mesma palavra na navegação e no título — o achado nº 3 da spec). As DUAS
// abas passam pelo axe: a de Estações é conteúdo novo NESTA rota (veio da /estacoes, que morreu) e
// ficaria fora do gate se o teste só varresse a aba padrão.
test("axe: /tags-ble (abas Tags e Estações)", async ({ page }) => {
  await login(page);
  await page.goto("/tags-ble");
  await expect(page.getByRole("heading", { name: "BLE", exact: true })).toBeVisible();
  await checkA11y(page, "tags-ble");

  await page.getByRole("tab", { name: "Estações" }).click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await checkA11y(page, "tags-ble");
});

// Replay: canvases com role=img + descrição textual do tick; controles ◀▶✕ agora são Lucide.
test("axe: /replay", async ({ page }) => {
  await login(page);
  await page.goto("/replay");
  await expect(page.getByRole("heading", { name: /player de replay/i })).toBeVisible();
  await expect(page.getByRole("img", { name: /Planta \(top-down\)/i })).toBeVisible();
  await checkA11y(page, "replay");
});
