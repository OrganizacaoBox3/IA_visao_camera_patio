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
    env: { VITE_HUB_URL: "http://127.0.0.1:4100" },
  },
});
