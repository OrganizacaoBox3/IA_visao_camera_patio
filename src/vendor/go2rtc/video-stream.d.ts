// Declaração p/ o módulo vendorizado `video-stream.js` (go2rtc), importado dinamicamente
// SÓ pelo efeito colateral de registrar o custom element `<video-stream>`
// (customElements.define). O arquivo JS não exporta nada — o namespace do módulo é vazio.
// Existe apenas para o TS resolver `import("./video-stream.js")` sem allowJs.
export {};
