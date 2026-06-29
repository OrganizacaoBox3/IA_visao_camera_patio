// @ts-check
/**
 * ESLint (flat config) — fundação de verificação (Onda 0 / R1). Ver CLAUDE.md §6.
 *
 * Doutrina (anti-overengineering): o gate só pode falhar por PROBLEMA REAL.
 *  - Meta de `eslint .`: ZERO errors. Warnings são tolerados e baixados depois.
 *  - `no-unused-vars` => warn (código legado tem muitos; não bloqueia o gate).
 *  - react-hooks: habilitamos só `rules-of-hooks` (error) + `exhaustive-deps` (warn).
 *    As demais regras do "recommended-latest" do plugin v7 (React Compiler: purity,
 *    immutability, set-state-in-effect, static-components, etc.) ficam DESLIGADAS por
 *    ora — são análises agressivas que sinalizam padrão legado e NÃO são regras de
 *    segurança. Reavaliar quando/se adotarmos o React Compiler.
 *  - `eslint-config-prettier` por último: desliga regras de ESTILO (formatação é do Prettier).
 *
 * Rebaixes documentados (regra real -> warn) para zerar errors sem mascarar bug de
 * segurança — ver bloco "Rebaixes pragmáticos" abaixo.
 */
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      "coverage/**",
      "server/wa-auth/**",
      "visao_computacional_mvp/**",
      "**/*.json",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  // Base comum a todos os arquivos lintados.
  {
    rules: {
      // Não-utilizados são ruído de legado, não bug -> warn (TS já pega o resto).
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },

  // Front-end (browser + Web Workers): React + Hooks.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // Node: hub server, scripts e arquivos de config/e2e (globals do Node).
  {
    files: [
      "server/**/*.{js,cjs,mjs}",
      "scripts/**/*.{js,mjs,cjs}",
      "e2e/**/*.ts",
      "*.{js,mjs,cjs,ts}",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // JS puro (Node CJS): o hub usa CommonJS (`require`), que é correto aqui.
  {
    files: ["server/**/*.{js,cjs,mjs}", "scripts/**/*.{js,mjs,cjs}", "*.{js,mjs,cjs}"],
    rules: {
      // unused vars como warn (o recommended marca como error).
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // require() é o padrão do hub Node (CJS) — não é problema.
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // Rebaixes pragmáticos (regra REAL -> warn) para zerar errors sem mascarar bug
  // de segurança nem reescrever lógica de legado (CLAUDE.md §6, anti-overengineering):
  //  - no-useless-assignment: padrão defensivo `let x = null; try { x = ... } catch { x = ... }`.
  //  - no-misleading-character-class: regex de emoji legado (server/dispatch.js, strip de "⚠️").
  // Reavaliar/baixar a dívida depois; nenhum é regra de segurança.
  {
    rules: {
      "no-useless-assignment": "warn",
      "no-misleading-character-class": "warn",
    },
  },

  prettier,
);
