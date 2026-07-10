// Mapa de tags OCUPADAS nos passos de calibração que escolhem uma tag BLE (âncoras/referência).
// Puro e testável (sem React/I-O): dado o estado (âncora por canto + tag de referência) e o CONTEXTO
// do passo, devolve MAC (MAIÚSCULO) → papel legível ("âncora do canto 2", "tag de referência").
// O TagPicker usa o mapa p/ DESABILITAR (não esconder) itens já usados — sumir da lista leria
// como "tag fora de alcance".
//   • Passo âncoras do canto N: ocupam as âncoras dos OUTROS cantos + a tag de referência.
//     A âncora do PRÓPRIO canto fica FORA (aparece habilitada/selecionada — trocável/limpável).
//   • Passo referência: ocupam TODAS as âncoras de canto (a referência atual é a seleção corrente).
//   • Duplicata LEGADA (mesmo MAC em 2 cantos, salva antes deste guard): o papel mostrado é o do
//     ÚLTIMO canto — cosmético; a tag segue corretamente desabilitada.

export type TakenContext = { step: "ancoras"; corner: number } | { step: "referencia" };

export function takenTags(
  cornerMacs: readonly string[],
  refTagMac: string | null | undefined,
  ctx: TakenContext,
): ReadonlyMap<string, string> {
  const taken = new Map<string, string>();
  cornerMacs.forEach((mac, i) => {
    if (!mac) return; // "" = canto sem âncora
    if (ctx.step === "ancoras" && ctx.corner === i) return; // o próprio canto não se auto-ocupa
    taken.set(mac.toUpperCase(), `âncora do canto ${i + 1}`);
  });
  // A referência só ocupa no passo de âncoras — no passo referência ela É a seleção corrente.
  if (ctx.step === "ancoras" && refTagMac) taken.set(refTagMac.toUpperCase(), "tag de referência");
  return taken;
}
