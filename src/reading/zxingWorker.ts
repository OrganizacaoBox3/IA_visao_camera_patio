/// <reference lib="webworker" />
// Worker de decodificação ZXing — roda FORA da main thread p/ não travar o feed.
// Recebe pixels RGBA (transferable) de um ROI; devolve o código ou null.
import {
  MultiFormatReader,
  DecodeHintType,
  BarcodeFormat,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
} from "@zxing/library";

const reader = new MultiFormatReader();
const hints = new Map<number, unknown>();
hints.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.ITF,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
]);
hints.set(DecodeHintType.TRY_HARDER, true);
reader.setHints(hints);

type Req = { id: number; rgba: ArrayBuffer; w: number; h: number };

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, rgba, w, h } = e.data;
  const data = new Uint8ClampedArray(rgba);
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++)
    lum[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  try {
    const src = new RGBLuminanceSource(lum, w, h);
    const bitmap = new BinaryBitmap(new HybridBinarizer(src));
    const res = reader.decodeWithState(bitmap);
    (self as unknown as Worker).postMessage({
      id,
      code: res.getText(),
      format: BarcodeFormat[res.getBarcodeFormat()],
    });
  } catch {
    (self as unknown as Worker).postMessage({ id, code: null, format: "" });
  }
};
