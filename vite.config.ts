import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Headers de segurança SÓ do dev/preview (vite). Em produção o CSP é o do nginx (mesma origem).
// `http:` no connect-src libera o hub local (http://localhost:4000 / IP-da-LAN:4000) p/ o /api/login;
// em produção SPA e /api são mesma origem, então lá basta 'self'. `font-src data:` silencia fontes data:.
const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://storage.googleapis.com https://tfhub.dev https://www.kaggle.com; connect-src 'self' http: ws: wss: https://cdn.jsdelivr.net https://storage.googleapis.com https://tfhub.dev https://www.kaggle.com https://*.kaggle.com https://huggingface.co https://*.huggingface.co https://*.hf.co; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self';",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "X-Content-Type-Options": "nosniff"
};

export default defineConfig({
  plugins: [react()],
  server: { headers: securityHeaders },
  preview: { headers: securityHeaders }
});
