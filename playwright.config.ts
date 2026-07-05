import { defineConfig, devices } from "@playwright/test";

// E2E do Visão de Pátio. Orquestra: hub isolado na 4100 (global-setup, sem PG, bootstrap admin),
// vite dev na 5180 apontando p/ esse hub (VITE_HUB_URL), e Chromium com WEBCAM FAKE
// (--use-fake-device-for-media-stream) p/ o nó de câmera funcionar headless.
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: "http://127.0.0.1:5180",
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: undefined } }],
  webServer: {
    command: "npm run dev -- --port 5180 --host 127.0.0.1 --strictPort",
    url: "http://127.0.0.1:5180",
    reuseExistingServer: false,
    timeout: 120_000,
    // VITE_GO2RTC_BASE numa porta MORTA: o e2e não tem go2rtc próprio, e o default "/go2rtc"
    // (proxy Vite → 127.0.0.1:1984) bateria em QUALQUER go2rtc rodando na máquina (ex.: um hub de
    // dev do desenvolvedor) — cross-talk que faz o transporte "auto" resolver WebRTC sem frames.
    // Apontando p/ um endpoint que ninguém escuta, toda chamada go2rtc falha → "auto" cai p/ MJPEG
    // (o caminho que o e2e testa), isolando-o de qualquer go2rtc externo.
    env: { VITE_HUB_URL: "http://127.0.0.1:4100", VITE_GO2RTC_BASE: "http://127.0.0.1:59999" },
  },
});
