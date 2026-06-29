import { defineConfig } from "vitest/config";

// Vitest cobre TESTES DE UNIDADE da lógica pura (ex.: vision/counting, report/predict,
// server/alarmPolicy). O e2e é Playwright (script `e2e`/`playwright test`) e fica FORA daqui
// — senão o vitest tenta rodar `e2e/*.spec.ts` e quebra (test() do Playwright != do Vitest).
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/**/*.test.{js,cjs,mjs}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**", "test-results/**", "playwright-report/**"],
  },
});
