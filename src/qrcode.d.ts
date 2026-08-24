// O pacote `qrcode` não traz tipos e não dependemos de @types/qrcode. Declaração ambiente MÍNIMA do que
// usamos no browser build (só `toDataURL`) — mantém o strict sem `any`. Ver src/routes/dvrs/NovoColetorDialog.tsx.
declare module "qrcode" {
  export interface QRCodeToDataURLOptions {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>;
  const _default: { toDataURL: typeof toDataURL };
  export default _default;
}
