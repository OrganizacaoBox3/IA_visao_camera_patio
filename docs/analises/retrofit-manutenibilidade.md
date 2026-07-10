# Retrofit de Manutenibilidade — plano (jul/2026)

> Segue o manifesto (`../agentes/`): **o básico bem feito, YAGNI/KISS, uma responsabilidade por unidade,
> sem código morto, anti-overengineering**; régua Akita: arquivos < ~500 linhas, baixa duplicação.
> **Regra de ouro: refactor PURO — zero perda de funcionalidade.** Rede: `verify` (lint+tsc+build+test) +
> e2e + 72 unit tests. Onda mais arriscada por último, isolada.

## Alvos (hotspots por tamanho)
| Arquivo | Linhas | Rede de teste | Onda |
|---|---|---|---|
| `server/alarmPolicy.js` | 707 | unit (alarmPolicy.test) ✅ forte | 1 |
| `src/report/mock.ts` | 787 | unit (predict) parcial | 1 |
| `src/routes/DashboardPage.tsx` | 1555 | e2e (nav/câmeras/alarmes) | 1 |
| `server/index.js` | 547 | node --check + e2e (hub) | 2 |
| `src/routes/ReportPage.tsx` | 2089 | e2e (Tabs) parcial | 2 |
| `src/routes/UsersPage.tsx` | 694 | e2e (AlertDialog) parcial | 2 |
| `src/CameraWorkspace.tsx` | 2306 | e2e (zona/fullscreen) — só | 3 (isolada) |

## Princípios do refactor (todos os agentes)
- **Extração pura:** mover blocos coesos p/ novos módulos/componentes; **mesma API pública/props/exports/comportamento**. Nada de mudar lógica, features, thresholds ou contratos.
- **Uma responsabilidade por módulo**; nomes revelam intenção; remover **código morto** encontrado; sem dependência nova.
- **Reversível/pequeno:** se um bloco for arriscado de extrair, **não extraia** (parcial correto > completo quebrado).
- **Performance:** não regredir; aproveitar ganhos óbvios (menos re-render, memo onde já cabe) sem overengineering.
- **Validação obrigatória:** `verify` + `e2e` verdes (server: `node --check` + unit). Sem os dois, não está pronto.

## Ondas (paralelas por propriedade de arquivo)
- **Onda 1:** `alarmPolicy.js` (→ `server/alarm/`) ‖ `report/mock.ts` (→ `report/calc/` por dimensão) ‖ `DashboardPage.tsx` (extrair AlarmDrawer/ViewsManager/IpCameraDialog/tiles → `routes/dashboard/`).
- **Onda 2:** `ReportPage.tsx` (painéis por modo → `routes/report/`) ‖ `index.js` (grupos de rotas → `server/routes/`) ‖ `UsersPage.tsx` (seções → `routes/users/`).
- **Onda 3 (isolada):** `CameraWorkspace.tsx` — continuar extração (conteúdo das abas, editor de zona, diálogo de config) para hooks/componentes; a mais delicada, sozinha.

## Métrica de "pronto"
Nenhum arquivo-alvo acima de ~500 linhas sem justificativa; duplicação removida; `verify`+e2e verdes a cada onda; funcionalidade idêntica (checar no smoke test de runtime onde o e2e não cobre).
