import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";

// Bundle-analyzer sob flag: `ANALYZE=1 npm run build` (ou `npm run analyze`) gera dist/stats.html
// com o treemap dos chunks. Sem a flag, o build normal fica intocado (plugin não entra).
const analyze = !!process.env.ANALYZE;

// Headers de segurança SÓ do dev/preview (vite). Em produção o CSP é o do nginx (mesma origem).
// `http:` no connect-src libera o hub local (http://localhost:4000 / IP-da-LAN:4000) p/ o /api/login;
// em produção SPA e /api são mesma origem, então lá basta 'self'. `font-src data:` silencia fontes data:.
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://storage.googleapis.com https://tfhub.dev https://www.kaggle.com; connect-src 'self' http: ws: wss: https://cdn.jsdelivr.net https://storage.googleapis.com https://tfhub.dev https://www.kaggle.com https://*.kaggle.com https://huggingface.co https://*.huggingface.co https://*.hf.co; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self';",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "X-Content-Type-Options": "nosniff",
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(analyze
      ? [visualizer({ filename: "dist/stats.html", gzipSize: true, brotliSize: true })]
      : []),
  ],
  server: {
    headers: securityHeaders,
    // Proxy de DEV para o go2rtc (Fases 1/3/5): o front usa o default same-origin `/go2rtc`
    // (config.ts) e o Vite encaminha para o go2rtc :1984 — paridade com o `location /go2rtc/`
    // do nginx em produção (que também tira o prefixo). `ws: true` = sinalização WebRTC (/api/ws).
    // O go2rtc sobe pelo hub quando `GO2RTC_ENABLED=1`. Sem isso, o tile WebRTC fica vazio (rollback
    // = manter a câmera em transport "mjpeg"). Override por VITE_GO2RTC_BASE se o go2rtc não for local.
    proxy: {
      "/go2rtc": {
        target: "http://localhost:1984",
        changeOrigin: true,
        ws: true,
        rewrite: (p) => p.replace(/^\/go2rtc/, ""),
      },
    },
  },
  preview: { headers: securityHeaders },
});
