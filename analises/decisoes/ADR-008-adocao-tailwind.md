# ADR-008 — Adoção incremental do Tailwind CSS (v4)

**Status:** aceito · **Data:** 2026-07-01

## Contexto
O design system já usa **Radix Primitives** (`src/ui/`) + **design tokens** (going-gray:
`--state-*`, `--cam-*`, `--accent`, `--sp-*`) com CSS escrito à mão. O usuário pediu adotar
**Tailwind** para "os melhores componentes possíveis" (DRY + Atomic Design). Recomendei
consolidar o sistema atual (menor risco); o usuário optou explicitamente por **adotar Tailwind**.

## Decisão
Adotar **Tailwind v4** de forma **incremental e coexistente**, sem big-bang:

1. **Toolchain:** `@tailwindcss/vite` no `vite.config.ts` (Vite 8).
2. **Sem preflight:** `src/tailwind.css` importa só `theme` + `utilities` (NÃO o reset/preflight),
   para não resetar o app existente. Migração componente a componente.
3. **DRY / fonte única:** o `@theme` **mapeia os tokens do projeto** (`var(--accent)`, `var(--panel-2)`,
   `var(--state-*)`, …). Utilities (`bg-panel-2`, `text-accent`, `border-border`) usam as MESMAS
   variáveis do going-gray — cor continua sendo informação, sem paleta duplicada.
4. **Ordem:** átomos primeiro; cada migração valida `verify` + e2e; CSS antigo removido junto
   (sem CSS morto).

## Piloto (feito nesta ADR)
`Switch`, `Checkbox`, `CheckboxRow` (`controls.tsx`) e `ToggleRow` migrados para utilities;
os `.ui-switch/.ui-check/.ui-togglerow/.ui-checkrow` correspondentes foram removidos do `ui.css`.
`verify` + e2e 8/8 verdes.

## Consequências
- **+** Componentes mais rápidos de escrever/ler, DRY via tokens, variantes por `data-[state=...]`.
- **−** Convivência temporária de dois estilos (Tailwind + CSS legado) até a migração terminar.
- **Limitação conhecida (v4):** cores mapeadas via `var()` no `@theme` não suportam o modificador
  de opacidade (`bg-accent/50`); se precisar, define-se valor real no `@theme`.
- **Invariantes mantidos:** going-gray (tokens), Radix como camada de primitivas, casca fullscreen
  manual (ADR-007). Preflight desligado = zero regressão global.

## Próximos passos (migração incremental — ordem sugerida)
Button/IconButton → Input/Textarea/Field → Select → Slider → Toggle/SegmentedControl →
Badge/Alert/EmptyState/KpiCard → Tabs/ScrollArea/Dialog/AlertDialog/Toast/Tooltip → páginas.
Ao final, avaliar remover `ui.css` e (se desejado) ligar o preflight com auditoria.
