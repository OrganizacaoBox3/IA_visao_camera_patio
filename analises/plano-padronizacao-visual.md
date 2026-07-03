# Padronização visual — padrão da casa + plano de execução (jul/2026)

> Base: auditoria estática (17 tamanhos de fonte, ~110 px crus, zero h2, ~80 hexes duplicados,
> 40+ title=) + auditoria de runtime (60 screenshots 1920/1366 + métricas JS). Evidências nos
> relatórios das duas auditorias. App é SaaS de operação: tela inteira útil, sem scroll de body,
> sem cortes.

## PADRÃO DA CASA (vale para todo código novo e para as ondas abaixo)

**Tipografia — 7 papéis (tokens no @theme; text-[Npx] proibido em página):**
| Token | px | Papel |
|---|---|---|
| micro | 10 | legenda técnica (eixos/unidades; mono se numérico) |
| label | 11 | título de seção uppercase, metadado |
| sec | 12 | secundário/hint/célula densa |
| body | 13 | corpo e controles (base atual) |
| title | 14 | título de página/dialog |
| hero | 18 | destaque de conteúdo |
| kpi | 24 | número de KPI — ÚNICO tamanho (hoje há 5: 17/20/22/26/30) |
Mapeamentos: 9→10 · 12.5→12 · 15/16/17→14 ou 18 · 20/22/26→24 · 30/32→24 (exceção: display do 404) · 0.9rem→13.

**Espaçamento:** page-padding = section-gap = card-padding = `--sp-4` (16). Denso interno `--sp-2`.
Px cru proibido em CSS de rota (6/10px tolerados só em src/ui). `.panel` 14→16. `.rep-body` sp-3→sp-4.

**Headings:** 1 h1/página SEMPRE via PageHeader (Dashboard/Report migram; 404 vira h1; workspaces
ganham h1 sr-only). Título de seção = h2 com o visual do h3 atual (label 11 uppercase) via átomo
`SectionTitle` (novo, em src/ui — funde .side h3/.panel h3 e as margens divergentes 8/12→12).

**Cor:** hex proibido fora do bloco de tokens do index.css. Report/alarms/alarm-health: ~80 hexes
→ `var(--state-*)` (troca 1:1). Tokens novos: `--accent-bg`/`--accent-border` (matam os hexes dos
átomos Button/Segmented/Select). Cor em valor numérico SÓ condicional a estado (remover o verde
incondicional do KPI "% tempo ativo"). Decidir #fb923c (laranja fora da paleta).

**Layout SaaS:** lista cresce com a viewport (`flex:1 + min-height:0 + ScrollArea h-full`) —
NUNCA `max-h-[Npx]` em conteúdo (só popover). Página em largura total; texto longo limita a
LINHA (max-width no parágrafo, ~70ch), não a página. Overflow: hidden sem scroll = bug.

**Radix:** `title=` como tooltip de UI → `<Tooltip>` (exceção documentada: célula de dado).
Remover CSS morto de select/range nativos.

## ONDA A — execução paralela (propriedade exclusiva)

| Frente | Escopo | Arquivos |
|---|---|---|
| **A1 Fundação** | Tokens de tipo no @theme + --accent-bg/border; index.css: .panel 16, .rep-body sp-4, px crus da escala, hexes internos→tokens, CSS morto de controles nativos, .page-title legado, login (botão "Entrar" contraste baixo — achado runtime), regras .rep-* do LAYOUT CRÍTICO do Relatório (clipping 1366 / squeeze 1920) | tailwind.css, index.css, ui.css, src/ui (SectionTitle, KpiCard 24, Button/Segmented/Select tokens) |
| **A2 Report tsx** | AtividadePanel: seção Fluxo entra no fluxo rolável (não fixa espremendo o tabpanel), KPI órfão, tamanhos KPI→24 via átomo, Eventos com linhas visíveis; ReportPage migra p/ PageHeader; headings h2; heatmap curto/vazio dos outros modos (preencher altura) | ReportPage.tsx, routes/report/*.tsx |
| **A3 Alarmes** | report/alarms.css + routes/alarms.css + alarm-health.css: hexes→tokens (mecânico); AlarmHealthPage: max-h→flex-fill, assimetria dos painéis, texto órfão de sessão; headings h2 | os 3 css + AlarmHealthPage.tsx |
| **A4 Admin/telas** | Users (max-h→flex-fill, faixa morta da tabela, headings), Profile (larguras inconsistentes, microcopy críptica), NotFound h1, CamerasPage (texto longo com medida ~70ch), headings h2 nas áreas | UsersPage/users/*, ProfilePage, NotFoundPage, CamerasPage/cameras/* (tsx) + users/profile css próprios se houver |
| **A5 Workspace+Shell** | Drawer da câmera: 5 abas SEM quebrar em 2 linhas (fit/scroll horizontal/ícones), vídeo NÃO cortado sob o drawer (fit em vez de crop), densidade das abas vazias; AppShell: busca ENCONTRA câmeras (bug: só menu aparece); h1 sr-only no workspace | CameraWorkspace.tsx, camera/*.css, AppShell.tsx, FadigaView.tsx (h1 sr-only) |

Sequência: A1 primeiro (fundação de tokens que os outros usam)? NÃO — tokens novos são ADITIVOS;
as frentes A2-A5 usam os NOMES definidos aqui (text-kpi etc. só após A1 publicar; para evitar
dependência, A2-A5 usam var(--fs-*)/valores da tabela e A1 publica ambos). Validação: verify por
frente; e2e combinado + RE-AUDITORIA visual (mesmo método, telas críticas) ao final.

## Fora desta onda (registrado)
title=→Tooltip em massa no CameraWorkspace (junto do retrofit R2 do arquivo); tema claro;
modo apresentação do relatório; fusão users/CamerasTab×/cameras (dívida anotada).
