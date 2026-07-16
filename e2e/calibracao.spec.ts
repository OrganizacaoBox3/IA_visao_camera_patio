import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// ── CALIBRAÇÃO COMO MODO DO PALCO (spec-arquitetura-informacao §1) ────────────────────────────
// A rota /calibracao morreu: calibrar é uma coisa que se faz NA câmera, sobre o VÍDEO REAL — não
// numa tela à parte, sobre um JPEG parado (ou, quando o go2rtc não servia a câmera, sobre um
// XADREZ: o operador calibrava às cegas).
//
// Este spec é o critério de aceite do movimento, e ele cobre os dois riscos que decidiam o diff:
//
//  1. CLICAR COM A IMAGEM PARADA. Com ⏸ Pausar, o rAF retorna ANTES do drawScene — o canvas não é
//     redesenhado. Se as marcações fossem desenhadas nele, os cantos SUMIRIAM justo quando o
//     operador congela a imagem para clicar com precisão. Por isso elas vivem numa camada SVG irmã
//     do canvas. O teste PAUSA o vídeo antes de marcar: se alguém "otimizar" a camada de volta para
//     dentro do rAF, os cantos somem e este teste fica vermelho.
//  2. O MEDIR DO OPERADOR. Ver useStageModes.test.ts (a ordem pura) — aqui a régua é de UI: o botão
//     "Calibrar" NÃO pode ser desabilitado como Zona/Polígono/Linha, senão o operador perde o medir.
//
// Coordenadas: o palco tem LETTERBOX (tarja) — os cliques são mapeados pelo content-rect, então o
// teste marca pontos BEM DENTRO da imagem (35%..65%), longe das bordas.
async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  // Home "/" redireciona à Central (ADR-018) — o heading confirma o login E o redirect.
  await expect(page.getByRole("heading", { name: "Central", exact: true })).toBeVisible();
}

// `key` é o TOKEN do nó de câmera (CAMERA_TOKEN do global-setup), não um nome livre — só o `name`
// muda. Usar outra chave faz o hub recusar a conexão e a câmera nunca aparece na Central.
async function connectCamera(context: BrowserContext, dashboard: Page) {
  const cam = await context.newPage();
  await cam.goto("/camera?key=e2e-cam&name=E2E-CAL");
  await expect(dashboard.getByText("E2E-CAL")).toBeVisible({ timeout: 30_000 });
  return cam;
}

// O 1º frame do relé demora (webcam fake + decode + socket): medido em ~6 s numa máquina ociosa, e
// bem mais quando o CI/dev roda outras coisas em paralelo. A CAMADA é o sinal de que ele chegou
// (ela só monta com o content-rect conhecido) — esperamos por ela com folga, e não pelo relógio.
const FRAME_MS = 60_000;

/** Abre a câmera, entra no modo Calibrar e espera o palco ter frame (a camada montar). */
async function abrirModoCalibrar(page: Page) {
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await expect(page.locator(".cam-stage")).toBeVisible();
  await page.getByRole("button", { name: "Calibrar", exact: true }).click();
  // O toggle troca de nome ao ligar (estado no TEXTO, nunca só-por-cor).
  await expect(page.getByRole("button", { name: "Calibrando…" })).toBeVisible();
  // Calibrar é um MODO, não uma aba: o painel vira O passo-a-passo da calibração (não um TabsContent
  // entre as abas de operação). O tablist de operação some — coberto em app.spec.ts "Calibrar é um MODO".
  await expect(page.getByText("Calibração de distância")).toBeVisible();
  await expect(page.locator(".cam-stage .cal-layer")).toHaveCount(1, { timeout: FRAME_MS });
}

// Clica os 4 cantos de um retângulo no chão, EM ORDEM (1 próx-esq · 2 próx-dir · 3 longe-dir ·
// 4 longe-esq).
//
// SEM RETRY CEGO: o palco só converte clique→coordenada quando JÁ HÁ FRAME (o content-rect sai das
// dimensões do vídeo). A própria camada dá esse sinal — ela só monta com o content-rect conhecido.
// Esperar por ela é determinístico; o retry de N tentativas do drawZone/polígono é a versão cega
// da mesma corrida.
async function marcarCantos(page: Page) {
  const stage = page.locator(".cam-stage");
  const box = await stage.boundingBox();
  if (!box) throw new Error(".cam-stage sem boundingBox");
  const cantos: Array<[number, number]> = [
    [0.35, 0.65],
    [0.65, 0.65],
    [0.6, 0.4],
    [0.4, 0.4],
  ];
  for (const [fx, fy] of cantos)
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await expect(page.getByText("4 cantos marcados")).toBeVisible();
}

// O 1º frame pode demorar sob carga (ver FRAME_MS) — o teste inteiro ganha folga sobre o default.
test.setTimeout(150_000);

test("Calibrar é MODO do palco: 4 cantos + L×C sobre o vídeo PAUSADO → salva e a grade assenta", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);
  await abrirModoCalibrar(page);
  const layer = page.locator(".cam-stage .cal-layer");

  // ⏸ PAUSAR: daqui em diante o canvas NÃO é mais redesenhado (o rAF retorna antes do drawScene).
  // É exatamente o cenário em que a marcação teria sumido se ela morasse no canvas — e é o que o
  // operador FAZ para clicar com precisão.
  await page.getByRole("button", { name: "Pausar" }).click();
  await expect(page.getByRole("button", { name: "Retomar" })).toBeVisible();

  await marcarCantos(page);

  // Os 4 cantos APARECEM com a imagem PARADA (risco nº 1). Desenhados no canvas, não apareceriam.
  await expect(layer.locator("circle")).toHaveCount(4);

  // L×C reais do retângulo → a homografia fica válida e o Salvar habilita.
  await page.getByLabel("Largura 1→2 (m)").fill("4");
  await page.getByLabel("Comprimento 2→3 (m)").fill("6");

  // GRADE MÉTRICA DE CONFERÊNCIA ("deve assentar no chão"): aparece no palco (linhas SVG) e a
  // legenda diz o passo. É o único sensor que o operador tem de que a calibração está boa.
  await expect(page.getByText(/Grade de conferência: 1 m por linha/)).toBeVisible();
  expect(await layer.locator("line").count()).toBeGreaterThan(4);

  const salvar = page.getByRole("button", { name: /Salvar calibração/ });
  await expect(salvar).toBeEnabled();
  await salvar.click();
  await expect(page.getByText("Calibração salva.")).toBeVisible();
  // Round-trip: o hub aceitou e a câmera passa a se declarar calibrada.
  await expect(page.getByText("calibrada", { exact: true })).toBeVisible();
});

test("Calibrar × os outros modos: a camada SVG monta no modo e some ao SAIR (ESC → operação)", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);
  // abrirModoCalibrar já espera a camada MONTAR — sem isso este teste passaria de graça (assertir
  // "a camada sumiu" numa camada que nunca apareceu não prova nada).
  await abrirModoCalibrar(page);
  await expect(page.locator(".cam-stage .cal-layer")).toHaveCount(1);

  // Calibrar é um MODO EXCLUSIVO: enquanto ele está ativo os outros editores nem aparecem na barra
  // (não se misturam dois vocabulários — app.spec.ts "Calibrar é um MODO"). Para chegar a Área é
  // preciso SAIR do modo. ESC sai da calibração (não fecha a câmera): a camada some e a operação volta.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cam-stage .cal-layer")).toHaveCount(0);
  const area = page.getByRole("button", { name: "Área", exact: true });
  await expect(area).toBeVisible();

  // Entrar em Área arma o editor de zona — a camada de calibração NÃO volta (o palco tem um dono só,
  // senão um clique criaria um canto E uma zona).
  await area.click();
  await expect(page.locator(".cam-stage .cal-layer")).toHaveCount(0);
});

// O axe da "câmera ABERTA" (app.spec.ts) NÃO enxerga esta tela: aquele teste varre a câmera em
// OPERAÇÃO, e o painel do MODO Calibrar (o passo-a-passo que substitui as abas) só existe com
// cal.active. Superfície nova pede sensor novo — senão o modo entraria no produto sem nunca ter
// passado pelo gate (a rota /calibracao, aliás, estava explicitamente FORA dele: a11y.spec.ts:13).
// Mesma régua da casa: falha em critical/serious; `color-contrast` segue como a dívida F1 de TOKEN
// (--text-muted sobre --panel), que não é desta tela.
test("axe: o modo Calibrar (painel do drawer na câmera aberta) sem violação séria", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);
  await abrirModoCalibrar(page);

  const results = await new AxeBuilder({ page }).analyze();
  const blocked = results.violations.filter(
    (v) => (v.impact === "critical" || v.impact === "serious") && v.id !== "color-contrast",
  );
  expect(
    blocked.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes[0]?.target.join(" ") ?? "?"}`),
    "violação séria de a11y na aba Calibrar",
  ).toEqual([]);
});
