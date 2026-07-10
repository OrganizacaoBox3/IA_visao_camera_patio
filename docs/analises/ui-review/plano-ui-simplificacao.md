# Plano — Simplificação da UI (apresentação ao cliente)

> Síntese de `01-referencias-mercado.md` (Frigate/UniFi/Verkada/Genetec/Grafana/NN-g) +
> `02-doutrina-casa.md` (going-gray/tokens/Lucide/Radix + invariantes e2e) +
> `03-auditoria-telas.md` (TOP-15 com screenshots em `shots/`). Execução em ondas paralelas
> por propriedade exclusiva (ADR-001), validação por verify+e2e+mobile+**screenshot after**.

## Regra de ouro (dos 3 artefatos)
Promover o padrão do shell a TODAS as superfícies: **Lucide** (18px/1.75/currentColor) no lugar
de emoji/glifo; **toda prosa >1 linha vira tooltip/help** (hierarquia: label → placeholder →
tooltip `?` → nada de parágrafo no meio da UI); **cor saturada só para anormalidade** (status =
cor+forma+texto, WCAG 1.4.1); **jargão de engenharia nunca renderiza** (env vars, chaves, libs);
progressive disclosure com máx. 2 níveis; vídeo protagonista (controles na borda, mínimos).

## Metas mensuráveis
| Métrica | Before (auditoria) | Alvo |
|---|---|---|
| Emoji/glifo funcional em botões | ~15 ocorrências (❄⏸✎⇄🖌🧽⤓▦📍🎲💡🔔📦🔒) | **0** (Lucide+Tooltip; aria-label preserva e2e) |
| Prosa nas telas (palavras de instrução permanente) | /cameras ~140p; abas da câmera ~130p; notificações jargão | **-70%** (tooltip/`?`/placeholder) |
| Bug visual | colisão `.alarm-card` (cards quebrados) · header duplo na câmera · aba cortada | **0** |
| Going-gray | verde decorativo em `.insight`/`.privacy` | tokens neutros |
| Gates | verify 476+ · e2e 8/8 · mobile 6/6 | iguais ou melhores + shots after |

## Ondas (propriedade exclusiva)

**ONDA A (agora — 4 frentes paralelas, sem conflito com o fix de tracking em voo):**
- **U1 Central + Alarmes**: fix da colisão CSS `.alarm-card` (#1 — o pior bug visual), `▦ Alarmes`→Lucide Bell (#8), 📍 e emojis do AlarmDrawer (#9), tile mínimo/hover. Arquivos: `routes/dashboard/**`, `routes/alarms.css`, `report/alarms.css`.
- **U3 /cameras**: wall-of-text ~140p→tooltips (#4), UUID cru + Select com rótulo-no-valor (#15), LocalNode enxuto. Arquivos: `routes/cameras/**`, `routes/CamerasPage.tsx`.
- **U4 Relatório + Saúde**: verde decorativo→neutro (#12), "limpar histórico" vira ação visível+confirmada (#13), shelve por chave crua→builder amigável (#6), emojis dos painéis (#9). Arquivos: `routes/report/**`, `routes/AlarmHealthPage.tsx`, `routes/report/chrome.tsx`, `report/*.css` (exceto alarms.css=U1).
- **U5 Usuários + Shell**: jargão `WHATSAPP_ENABLED=1`/Baileys→linguagem de produto (#5), 🎲→Lucide (#9), bottom-nav 7 itens truncados (#10). Arquivos: `routes/users/**`, `components/**`, `index.css` (seções shell/bottom-nav SOMENTE), `appshell.css`.

**ONDA B (após o fix de tracking aterrissar — CameraWorkspace fica livre):**
- **U2 Câmera aberta** (a tela-hero do demo): header duplo (#2), toolbar emoji→Lucide+Tooltip (#3), jargão `APP_CONFIG.overlay` (#7), parágrafos-manual das 5 abas→tooltips (#11), aba Presença cortada (#14), controles na borda estilo Verkada. Arquivos: `CameraWorkspace.tsx`, `camera/tabs/**`, `camera/cine.css`, `index.css` (seção câmera-full), + e2e/app.spec.ts (textos que mudarem, no MESMO commit).

## Invariantes (do 02-doutrina-casa)
Nome ACESSÍVEL preservado onde o e2e casa por role/name; textos visíveis load-bearing atualizados
no mesmo commit COM o spec; ADR-007 (casca/canvas) intocado; RBAC; contratos socket; classes
load-bearing (.cam-stage, .tile[title=…], .ui-overlay). Mobile não regride (gate 390px).
