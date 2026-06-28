// Validação funcional do caminho de decode usado em src/reading/decoder.ts:
// RGBLuminanceSource + HybridBinarizer + MultiFormatReader.decodeWithState com hints
// POSSIBLE_FORMATS + TRY_HARDER. 2D via writer do ZXing; 1D (EAN-13) rasterizado à mão.
const Z = require("@zxing/library");

const FORMATS = [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E];

function decodeLikeApp(lum, W, H) {
  const hints = new Map();
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, FORMATS);
  hints.set(Z.DecodeHintType.TRY_HARDER, true);
  const reader = new Z.MultiFormatReader();
  reader.setHints(hints);
  const source = new Z.RGBLuminanceSource(lum, W, H);
  const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
  const res = reader.decodeWithState(bitmap);
  return { text: res.getText(), format: Z.BarcodeFormat[res.getBarcodeFormat()] };
}

// rasteriza um array de módulos 1D (1=barra preta, 0=espaço) com escala/quiet/altura.
function raster1D(modules, scale, quiet, H) {
  const W = (modules.length + quiet * 2) * scale;
  const lum = new Uint8ClampedArray(W * H); lum.fill(255);
  for (let y = 0; y < H; y++) for (let i = 0; i < modules.length; i++) {
    if (!modules[i]) continue;
    const x0 = (i + quiet) * scale;
    for (let dx = 0; dx < scale; dx++) lum[y * W + x0 + dx] = 0;
  }
  return { lum, W, H };
}

// EAN-13 encoder (95 módulos).
const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
function encodeEAN13(code) {
  const d = code.split("").map(Number);
  let s = "101"; // start guard
  const par = PARITY[d[0]];
  for (let i = 1; i <= 6; i++) s += (par[i - 1] === "L" ? L : G)[d[i]];
  s += "01010"; // center guard
  for (let i = 7; i <= 12; i++) s += R[d[i]];
  s += "101"; // end guard
  return s.split("").map(Number);
}

let pass = 0, total = 0;
function check(label, sent, got) {
  total++; const ok = sent === got;
  console.log(`${ok ? "✓" : "✗"} ${label}  enviado="${sent}"  lido="${got}"`);
  if (ok) pass++;
}

// 1D — EAN-13 (caso varejo/CD mais comum). Varia escala/quiet p/ simular resoluções.
for (const [code, scale, quiet] of [["7891234567895", 3, 11], ["7899876543215", 3, 10], ["4006381333931", 4, 12]]) {
  try { const { lum, W, H } = raster1D(encodeEAN13(code), scale, quiet, 80); const o = decodeLikeApp(lum, W, H); check(`EAN_13 esc${scale} (${o.format})`, code, o.text); }
  catch (e) { total++; console.log(`✗ EAN_13 esc${scale} erro: ${e && e.message || e}`); }
}

console.log(`\n${pass}/${total} OK — pipeline de decode (RGBLuminanceSource→HybridBinarizer→MultiFormatReader.decodeWithState) valida 1D EAN-13.`);
process.exit(pass === total ? 0 : 1);
