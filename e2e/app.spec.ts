import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Login real (hub valida POST /api/login → token → socket autenticado).
async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login-user").fill("admin");
  await page.locator("#login-pass").fill("admin@box3");
  await page.getByRole("button", { name: "Entrar" }).click();
  // Home agora é o Mapa (estilo AirTag). Confirma o login e segue p/ a Central
  // (dashboard de câmeras, rota /monitoramento), onde os testes de câmera operam.
  await expect(page.getByRole("heading", { name: /Mapa de tags/i })).toBeVisible();
  await page.goto("/monitoramento");
  await expect(page.getByRole("heading", { name: "Central", exact: true })).toBeVisible();
}

// Abre um nó de câmera (webcam fake) e espera ele aparecer no dashboard.
async function connectCamera(context: BrowserContext, dashboard: Page) {
  const cam = await context.newPage();
  await cam.goto("/camera?key=e2e-cam&name=E2E-CAM");
  await expect(dashboard.getByText("E2E-CAM")).toBeVisible({ timeout: 30_000 });
  return cam;
}

// MUDANÇA DE PRODUTO (2026-07): a câmera nova abre LIMPA — sem zonas-semente. Os testes de
// config de zona agora DESENHAM a própria zona primeiro: UM toggle "Área" (área-um-botão) + drag
// real no .cam-stage. O ARRASTE (cruza o limiar) decide RETÂNGULO de 4 vértices — o mesmo caso comum
// de sempre. Espera o estado vazio da aba Zonas (garante que a carga assíncrona terminou E prova o
// novo comportamento) e retry no drag (o onUp descarta o traço se o 1º frame ainda não chegou ao palco).
async function drawZone(page: Page) {
  // "Área" ENTRA no modo do palco (spec-tela-camera-arquitetura §3-A): Zona/Linha saíram das abas do
  // drawer e viram o painel CONTEXTUAL do modo. Só depois de armar o modo o painel de zonas (e seu
  // estado-vazio) aparece — por isso a espera do estado-vazio vem AGORA, não antes do toggle.
  await page.getByRole("button", { name: "Área", exact: true }).click();
  await expect(page.getByText(/Use “Área” para desenhar/)).toBeVisible();
  const stage = page.locator(".cam-stage");
  const cfgBtn = page.getByRole("button", { name: "Configurar zona" }).first();
  // 8 tentativas (era 5): sob carga (probe WHIP do nó + fetch /go2rtc/api/streams) o 1º frame
  // pode demorar a chegar ao palco; o onUp descarta o traço até lá. Mais retry = menos flake.
  for (let attempt = 0; attempt < 8; attempt++) {
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

// ── Varredura F3 / área-um-botão: o CLIQUE ponto a ponto do modo Área ──────────────────────────
// UM toggle "Área" e o GESTO decide: CLIQUE (soltar no lugar) desenha um POLÍGONO vértice a vértice.
// Este teste é o critério de aceite do gesto-clique (CA-1: clico N vértices + Concluir ⇒ zona criada)
// e o controle negativo do arraste-vs-clique (o gesto-arraste tem seu próprio teste, "Área: arraste").
//
// O palco só aceita vértice quando JÁ HÁ FRAME (toNorm precisa do content-rect do vídeo) — mesma
// corrida do drawZone acima. O rascunho dá um sinal MELHOR que o retry cego: "Concluir polígono" só
// habilita com ≥3 vértices. Se os cliques não pegaram (sem frame), ESC descarta o rascunho e a
// tentativa recomeça limpa — sem acumular vértices de tentativas anteriores.
test("Área (clique): a barra do palco cria uma zona de N vértices (arma → cliques → Concluir)", async ({
  page,
  context,
}) => {
  // O teste paga conexão do nó + chegada do 1º frame ao palco (+ cold-start do dev server quando
  // é o primeiro do arquivo): o orçamento de 90s estoura por INFRA, não por bug. Medido: ~12s com
  // o servidor quente, ~70s+ frio.
  test.slow();
  await login(page);
  await connectCamera(context, page);
  await page.locator(".tile[title='Abrir câmera']").first().click();
  // Guard de carga: a barra do palco montou (a câmera abre em OBSERVAÇÃO — Zona/Linha viram modos,
  // então o estado-vazio da zona só aparece DENTRO do modo, exercido pelo laço abaixo ao armar
  // "Área" e clicar os vértices, o que faz o painel de zonas subir).
  const stage = page.locator(".cam-stage");
  const areaBtn = page.getByRole("button", { name: "Área", exact: true });
  await expect(areaBtn).toBeVisible();
  const concluir = page.getByRole("button", { name: "Concluir polígono" });
  const cfgBtn = page.getByRole("button", { name: "Configurar zona" }).first();
  const VERTICES = [
    [0.3, 0.3],
    [0.65, 0.32],
    [0.6, 0.65],
    [0.32, 0.62],
  ] as const;

  for (let attempt = 0; attempt < 8; attempt++) {
    await areaBtn.click(); // arma o modo Área (indeciso); o 1º CLIQUE decide "polígono"
    const box = await stage.boundingBox();
    if (!box) throw new Error(".cam-stage sem boundingBox");
    // mouse.click = down+up SEM movimento = CLIQUE: o 1º semeia o vértice, os demais adicionam.
    for (const [fx, fy] of VERTICES)
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    try {
      // Espera de verdade (não polling instantâneo): sem esta janela, as 8 tentativas queimam
      // em ~2s — antes do 1º frame chegar ao palco — e o teste falha por corrida, não por bug.
      await expect(concluir).toBeEnabled({ timeout: 2_000 });
      break; // vértices registraram → dá p/ fechar o polígono
    } catch {
      await page.keyboard.press("Escape"); // sem frame ainda: descarta o rascunho e repete
    }
  }

  await expect(concluir).toBeEnabled(); // falha com mensagem clara se nenhum vértice pegou
  await concluir.click();
  await expect(concluir).toHaveCount(0); // rascunho fechou → controles do rascunho somem

  // Fechar o polígono SAI do modo Área (o rascunho fecha) → o drawer volta às abas de observação.
  // Re-arma o modo Área (toggle "Área") p/ ver o card da zona criada — o painel CONTEXTUAL do modo.
  await page.getByRole("button", { name: "Área", exact: true }).click();
  await expect(cfgBtn).toBeVisible(); // a zona poligonal existe (card no painel de zonas do modo)

  // Limpa o que este teste criou: as zonas são PERSISTIDAS por câmera no hub, e o e2e reusa a
  // mesma câmera (key=e2e-cam) — deixar a zona aqui quebraria o estado-vazio que os testes
  // seguintes (drawZone) exigem. Também exerce o caminho de remoção.
  await page.getByRole("button", { name: "Remover zona" }).first().click();
  await expect(page.getByText(/Use “Área” para desenhar/)).toBeVisible();
});

// ── spec-zona-unificada F3: a zona É um polígono — e agora se EDITA ───────────────────────────
// O pedido do dono, literal: "quero poder EDITAR OS PONTOS depois". Até esta onda, a primitiva que
// 21 das 22 zonas de produção usavam — o retângulo — não tinha edição NENHUMA: nascia por arraste e
// morria no X. Este teste percorre o ciclo inteiro pelo PALCO (é lá que a geometria vive):
//   desenhar (o preset retângulo, mesma gestualidade de sempre) → SELECIONAR → INSERIR um vértice
//   pelo midpoint → REMOVER com Delete → MOVER a forma inteira.
// A prova de que a forma REALMENTE se moveu não é um print: depois de arrastar o interior em +5% do
// palco, o teste CLICA onde o canto DEVE ter ido parar e exige que haja um vértice ali (o alvo é de
// 14 px; o deslocamento é de 35-60 px — se a forma não tivesse andado, o clique cairia no vazio).
// A barra do palco carrega o estado em TEXTO ("Zona selecionada · N vértices" / "Vértice i de N") —
// going-gray: informação nunca só-por-cor —, e é esse texto que serve de oráculo aqui.
test("Área (arraste): o retângulo nasce POLÍGONO editável — seleciona, insere vértice, remove e move", async ({
  page,
  context,
}) => {
  test.slow(); // paga conexão do nó + 1º frame no palco (mesmo orçamento do teste do clique)
  await login(page);
  await connectCamera(context, page);
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await drawZone(page); // "Área" + ARRASTE 35%→65% ⇒ zona de 4 vértices (o gesto decide RETÂNGULO)

  const stage = page.locator(".cam-stage");
  const tip = page.locator(".cam-head-tip"); // a dica do editor (role=status)
  const box = (await stage.boundingBox())!;
  const px = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;

  // O modo "Área" continua armado depois do arraste (arraste = nova zona). Desarma p/ EDITAR
  // (com count 0 o toggle segue mostrando "Área", não "N vértices").
  await page.getByRole("button", { name: "Área", exact: true }).click();

  // 1) SELECIONAR: clicar dentro da zona (o `simple_select` do Mapbox) — 4 vértices, em texto.
  await page.mouse.click(...px(0.5, 0.5));
  await expect(tip).toContainText(/Zona selecionada · 4 vértices/);

  // 2) INSERIR: arrastar o MIDPOINT da aresta de cima (meio de (35%,35%)→(65%,35%) = (50%,35%)).
  //    É o que o Frigate literalmente não implementa e a Axis não documenta.
  await page.mouse.move(...px(0.5, 0.35));
  await page.mouse.down();
  await page.mouse.move(...px(0.5, 0.25), { steps: 10 });
  await page.mouse.up();
  await expect(tip).toContainText(/Vértice 2 de 5/); // o vértice NOVO nasce selecionado

  // 3) REMOVER pelo TECLADO (nunca só clique-direito — P7: o operador usa TABLET).
  await page.keyboard.press("Delete");
  await expect(tip).toContainText(/Zona selecionada · 4 vértices/); // voltou aos 4 cantos

  // 4) MOVER A FORMA: arrastar o interior +5% do palco (antes, mover uma zona exigia REDESENHAR).
  await page.mouse.move(...px(0.5, 0.5));
  await page.mouse.down();
  await page.mouse.move(...px(0.55, 0.55), { steps: 10 });
  await page.mouse.up();

  // …e a PROVA geométrica: o canto que estava em (35%,35%) tem de estar agora em (40%,40%).
  await page.mouse.click(...px(0.4, 0.4));
  await expect(tip).toContainText(/Vértice \d+ de 4/); // há um VÉRTICE exatamente ali ⇒ a forma andou

  // Limpa o que este teste criou (as zonas são PERSISTIDAS por câmera no hub e o e2e reusa a
  // mesma câmera): o estado-vazio que os testes seguintes exigem volta a valer. O modo Área foi
  // DESARMADO acima (p/ editar) → o painel voltou às abas de observação; re-arma o modo p/ acessar
  // o painel de zonas e remover.
  await page.getByRole("button", { name: "Área", exact: true }).click();
  await page.getByRole("button", { name: "Remover zona" }).first().click();
  await expect(page.getByText(/Use “Área” para desenhar/)).toBeVisible();
});

// GATE DE A11Y do console que o operador mais vive (a a11y.spec.ts varre só as rotas — a câmera
// ABERTA exige um nó de câmera conectado, então o axe dela mora aqui, junto dos helpers).
// Mesma régua do a11y.spec.ts: falha em violação critical/serious; `color-contrast` segue como a
// dívida F1 conhecida (token --text-muted/--text-dim sobre --panel), não é da tela.
// A TELA DO PORQUÊ (bug B8 do laudo 2026-07-13): quando o sistema não associa a tag à pessoa, ele
// CALAVA. O diagnóstico (`diagnoseFunnel`) existia, testado, com ZERO consumidor de UI. Este teste
// prova que ele CHEGOU NA TELA e que a aba fala em português — no nó de webcam do e2e não há
// estação BLE nem motor do hub, então o estado esperado aqui é justamente o HONESTO: "o diagnóstico
// não está rodando / a fusão não roda", em vez do silêncio de antes. (O funil COM tag/rádio é
// coberto por unidade em src/camera/tabs/PorQueTab.test.tsx, com os números medidos em campo.)
test("Por quê: a aba do diagnóstico existe e DIZ por que não identifica (nunca cala)", async ({
  page,
  context,
}) => {
  test.slow(); // paga conexão do nó + 1º frame no palco (mesmo orçamento dos demais testes de câmera)
  await login(page);
  await connectCamera(context, page);
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await expect(page.locator(".cam-stage")).toBeVisible();

  const tablist = page.getByRole("tablist", { name: "Aba do painel" });
  await tablist.getByRole("tab", { name: "Por quê" }).click();
  const panel = page.getByRole("tabpanel");
  await expect(panel.getByRole("heading", { name: "Por que não identificou?" })).toBeVisible();
  // O contrato com o operador: a tela NUNCA fica muda — ou explica a cadeia, ou explica por que
  // nem há cadeia (sem leituras BLE nesta câmera / sem pistas do motor do hub).
  await expect(
    panel.getByText(/Diagnóstico desligado|A fusão não está rodando|Ninguém em cena/),
  ).toBeVisible();
});

// CALIBRAR É UM MODO, não uma camada empilhada (spec-tela-camera-modos §3): a queixa do dono era
// "com a junção calibração+câmera os elementos estão TOTALMENTE SOBREPOSTOS". O conserto reconfigura
// o CHROME ao entrar no modo (padrão Figma Dev Mode / NN/g "não misturar os vocabulários de dois
// modos"): os toggles de OPERAÇÃO (Área/Linha) somem, o painel vira SÓ o passo-a-passo da
// calibração (não a 7ª aba espremida), e ESC sai do MODO sem fechar a câmera.
test("Calibrar é um MODO: entrar esconde os toggles de operação e o painel; ESC volta à operação", async ({
  page,
  context,
}) => {
  test.slow(); // paga conexão do nó + 1º frame no palco (mesmo orçamento dos demais testes de câmera)
  await login(page); // admin = superadmin (canConfigure) — calibra de verdade
  await connectCamera(context, page);
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await expect(page.locator(".cam-stage")).toBeVisible();

  const area = page.getByRole("button", { name: "Área", exact: true });
  const linha = page.getByRole("button", { name: "Linha" });
  const tablist = page.getByRole("tablist", { name: "Aba do painel" });
  await expect(area).toBeVisible(); // operação: os toggles de edição vivem na barra do palco
  await expect(tablist).toBeVisible(); // e o painel tem as abas de OBSERVAÇÃO
  // F1 (spec-tela-camera-arquitetura §3-A): Zona e Linha DEIXARAM de ser abas — viram MODOS do palco
  // (entram pelo toggle do header e ocupam o painel contextual). O strip de abas guarda só
  // observação; nenhuma aba "Zonas"/"Linhas" (fim da duplicação header×aba).
  await expect(tablist.getByRole("tab", { name: /Zonas|Linhas/ })).toHaveCount(0);

  // Entra no 5º modo do palco (o toggle "Calibrar"; antes da ativação há UM só botão com esse nome).
  await page.getByRole("button", { name: "Calibrar" }).click();

  // Os toggles de OPERAÇÃO (Área/Linha) somem da barra — não se misturam os dois vocabulários.
  await expect(area).toHaveCount(0);
  await expect(linha).toHaveCount(0);
  // O painel vira SÓ o passo-a-passo da calibração (as abas de operação somem).
  await expect(page.getByText("Calibração de distância")).toBeVisible();
  await expect(tablist).toHaveCount(0);

  // ESC sai do MODO — NÃO fecha a câmera — e a operação volta com os toggles e as abas normais.
  await page.keyboard.press("Escape");
  await expect(page.locator(".cam")).toBeVisible(); // a câmera continua aberta (ESC saiu só do modo)
  await expect(area).toBeVisible();
  await expect(linha).toBeVisible();
  await expect(tablist).toBeVisible();
});

test("axe: câmera ABERTA (console do operador) sem violação séria", async ({ page, context }) => {
  await login(page);
  await connectCamera(context, page);
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await expect(page.locator(".cam-stage")).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  const blocked = results.violations.filter(
    (v) => (v.impact === "critical" || v.impact === "serious") && v.id !== "color-contrast",
  );
  expect(
    blocked.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes[0]?.target.join(" ") ?? "?"}`),
    "violação séria de a11y na câmera aberta",
  ).toEqual([]);
});

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
  // A opção de CALIBRAÇÃO "Exclusão" existe no mesmo Select (não é o default — o padrão é Atividade).
  await expect(page.getByRole("option", { name: "Exclusão" })).toBeVisible();
  await opt.click(); // clique funciona
  await expect(modo).toContainText("Leitura"); // valor mudou → confirmado
});

// MIGRAÇÃO (2026-07): o modal standalone "⚙ Câmeras" da Central foi INCORPORADO à tela /cameras
// (seção "Ajustes desta câmera") — fim da fragmentação da config por-câmera. O Select "Tipo da
// câmera" (papel: área × operador/fadiga) agora vive lá, numa seção comum (não mais num Dialog).
// Este teste mantém a COBERTURA DO PAPEL: a câmera conectada aparece em /cameras e o Select muda
// o tipo. (A cobertura de Select-DENTRO-de-Dialog segue nos testes de "Modo da zona" acima e no
// teste do form de cadastro IP abaixo.)
test("Ajustes da câmera (/cameras): o Select de papel (área × fadiga) muda o tipo", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);

  // Navega à tela de câmeras pelo menu lateral; a câmera conectada entra na seção de ajustes
  // (CameraSettingsSection abre seu próprio socket p/ a lista, sem receber frames de vídeo).
  await page.getByRole("link", { name: "Câmeras" }).click();
  await expect(page).toHaveURL(/\/cameras/);

  const tipo = page.getByLabel("Tipo da câmera").first();
  await expect(tipo).toBeVisible({ timeout: 30_000 });
  await tipo.click();
  const opt = page.getByRole("option", { name: /Operador \(fadiga\)/i });
  await expect(opt).toBeVisible();
  await opt.click();
  await expect(tipo).toContainText(/Operador/i);
});

// BUG relatado: abrir um Select e fechá-lo (ESC ou clique fora) estava FECHANDO O MODAL.
// O Radix deve dismissar só a camada de cima (o Select), mantendo o Dialog aberto.
// MIGRAÇÃO (2026-07): o antigo alvo (modal "⚙ Câmeras") saiu da Central; a cobertura de
// Select-em-Dialog + dismiss por camadas passa a usar o Dialog do CADASTRO DE CÂMERA IP em
// /cameras (Select "Transporte RTSP", visível por padrão pois rtsp é o esquema default do form).
test("Select aberto em Dialog: ESC e clique-fora fecham só o Select, não o Dialog (/cameras)", async ({
  page,
}) => {
  await login(page); // admin = superadmin → vê o cadastro de câmeras IP
  await page.getByRole("link", { name: "Câmeras" }).click();
  await expect(page).toHaveURL(/\/cameras/);

  await page.getByRole("button", { name: "+ Adicionar câmera IP" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  const sel = dlg.getByLabel("Transporte RTSP");

  // 1) ESC fecha só o Select
  await sel.click();
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("option")).toHaveCount(0); // select fechou
  await expect(dlg).toBeVisible(); // dialog continua aberto

  // 2) clique no OVERLAY com o Select aberto deve fechar só o Select (Radix:
  //    Select tem disableOutsidePointerEvents → blinda o Dialog na 1ª interação).
  //    Usa locator CSS porque o Select aberto deixa o resto aria-hidden.
  await sel.click();
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

// BUG PRÉ-EXISTENTE (achado pela U2): com o Dialog de config de zona aberto, ESC fechava o
// Dialog E TAMBÉM a casca fullscreen da câmera. Causa: o Radix dismissa no CAPTURE do document
// e o React 19 flusha o setState + passive effects num microtask ENTRE os listeners do mesmo
// keydown — quando o bubble do trap manual rodava, cfgOpenRef já era false. O fix checa
// e.defaultPrevented (o DismissableLayer marca o evento ao dismissar) — síncrono, por-evento.
// Seletores: o Radix Dialog é `.ui-dialog` (a casca da câmera também tem role="dialog", então
// getByRole("dialog") seria ambíguo depois que o aria-hidden do Radix sai).
test("ESC com o Dialog de config de zona aberto fecha SÓ o Dialog; 2º ESC fecha a câmera", async ({
  page,
  context,
}) => {
  await login(page);
  await connectCamera(context, page);
  await page.locator(".tile[title='Abrir câmera']").first().click();
  await drawZone(page);
  await page.getByRole("button", { name: "Configurar zona" }).first().click();
  await expect(page.locator(".ui-dialog")).toBeVisible();

  // 1º ESC: fecha só o Dialog — a câmera fullscreen permanece aberta (o Dialog do Radix tem
  // precedência; o editor de área NÃO rouba o ESC quando há `.ui-dialog` aberto — guard do hook).
  await page.keyboard.press("Escape");
  await expect(page.locator(".ui-dialog")).toHaveCount(0); // dialog fechou
  await expect(page.locator(".cam")).toBeVisible(); // câmera continua aberta

  // O modo Área seguiu ARMADO desde o drawZone (arraste = nova zona). Como no Calibrar, o próximo
  // ESC SAI DO MODO — não fecha a câmera (o mesmo que o antigo modo Polígono já fazia).
  await page.keyboard.press("Escape");
  await expect(page.locator(".cam")).toBeVisible(); // ainda aberta: ESC saiu do modo Área

  // Agora, sem modo armado nem Dialog, o ESC fecha a câmera (volta à Central).
  await page.keyboard.press("Escape");
  await expect(page.locator(".cam")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Central", exact: true })).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Central", exact: true })).toBeVisible();
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
