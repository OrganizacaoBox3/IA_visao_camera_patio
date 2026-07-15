import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Portal SPA do control-plane. Em DEV, o vite faz proxy de /api -> control-plane (CP_PORT).
// Ajuste o alvo com CP_PROXY (default http://localhost:4100, a porta padrão do control-plane).
const CP_PROXY = process.env.CP_PROXY ?? "http://localhost:4100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4200,
    proxy: {
      "/api": {
        target: CP_PROXY,
        changeOrigin: true,
      },
      "/health": {
        target: CP_PROXY,
        changeOrigin: true,
      },
    },
  },
});
