import { defineConfig } from "vitest/config";

// Vitest cobre TESTES DE UNIDADE da lógica pura (ex.: vision/counting, report/predict,
// server/alarmPolicy). O e2e é Playwright (script `e2e`/`playwright test`) e fica FORA daqui
// — senão o vitest tenta rodar `e2e/*.spec.ts` e quebra (test() do Playwright != do Vitest).
export default defineConfig({
  test: {
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "server/**/*.test.{js,cjs,mjs}",
      "control-plane/**/*.test.{js,cjs,mjs}",
      // `scripts/` entrou em 2026-08-16 com o diagnose-source: ele DECIDE um código de saída
      // (fila detectada = 1) a partir de lógica pura, e lógica que decide precisa de teste
      // (CLAUDE.md §6). Exige que o script seja IMPORTÁVEL sem efeito colateral — nada de
      // `process.exit` no topo do módulo, só dentro do guard de execução direta.
      "scripts/**/*.test.mjs",
    ],
    exclude: ["e2e/**", "node_modules/**", "dist/**", "test-results/**", "playwright-report/**"],
  },
});
