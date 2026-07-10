# Plano de redesign de UX — Visão de Pátio (SPA, sem scroll, responsiva)

> Levantamento + plano em **2026-06-09**. Foco: otimizar espaço, padronizar espaçamentos, virar uma SPA de verdade, analisar cada quadrante por importância × frequência, e avaliar uma tela dedicada a "mais informações". Meta: **sem scroll (ou mínimo) e responsiva**.

---

## 1. Princípios do redesign
1. **Feed manda.** Na operação ao vivo, o vídeo + estado das áreas é o produto — deve dominar a tela.
2. **Mostrar o que se olha sempre; esconder o que se usa raramente.** Controles de configuração e auditoria saem do caminho (drawer / tela dedicada).
3. **Sem scroll por padrão.** Cada tela é um grid de regiões fixas que cabe no viewport; scroll só dentro de contêineres designados (galeria de câmeras, lista de eventos no drawer).
4. **Escala de espaçamento única** (tokens 4/8/12/16/24) — fim do ad-hoc.
5. **SPA com shell persistente** — navegação e cabeçalho constantes; as telas trocam no conteúdo.
6. **Responsiva por breakpoints** — desktop, tablet, mobile, com a mesma hierarquia.

---

## 2. Problemas atuais (evidência no código)
- **Scroll em 5 pontos:** painel "Áreas" (cresce sem limite), "Timeline" (`maxHeight:180`), grade de câmeras (`dash-body overflow:auto`), corpo do relatório, tabela de eventos.
- **Redundância:** "pessoas agora" e "pico" aparecem em **dois** blocos (Indicadores e Presença) na câmera aberta.
- **Espaçamento inconsistente:** padding/gap em 8/6/14/12/7/10/5/4/3/16/2 px — sem sistema.
- **Sem SPA real:** `/`, `/relatorio` e `/camera` reinventam cada um seu `topbar`; não há shell/nav persistente.
- **Painel da câmera mistura** "monitorar" (KPIs, estados) com "configurar" (limite, sensibilidade, excluir) e "auditar" (timeline) — três intenções de frequências muito diferentes no mesmo espaço.

---

## 3. Análise por quadrante (importância × frequência → decisão)

### A) Câmera aberta (tela operacional densa — onde mora o problema)
| Quadrante | Importância | Frequência | Decisão |
|---|---|---|---|
| **Feed + overlays** (zonas, estado, badges, pessoas) | 🔴 Alta | 🔴 Contínua | **Dominar a tela** (maior área). Estado/contagem/alerta já vivem no overlay |
| **KPIs essenciais** (alertas · em alerta · pessoas) | 🔴 Alta | 🟠 Glance | **Faixa compacta única** (1 linha), sem duplicar |
| **Presença detalhada** (pico, permanência média) | 🟠 Média | 🟡 Baixa | **Mesclar** na faixa de KPIs ou mover p/ drawer |
| **Alerta (último/ativo)** | 🔴 Alta (no evento) | 🟡 Event-driven | **Toast/banner transitório**, não bloco fixo |
| **Config de área** (limite, sensibilidade, excluir, desenhar) | 🔴 Alta p/ setup | 🟢 **Rara** (1×) | **Mover p/ modo Config / drawer** — é a fonte do scroll |
| **Timeline de eventos** | 🟠 Média | 🟡 Auditoria | **Drawer / tela dedicada**, colapsável |
| **Ações** (pausar, desenhar) | 🟠 Média | 🟡 Baixa | Header, ícones |

➡️ **Conclusão:** a câmera aberta vira **feed-dominante + 1 faixa compacta de KPIs + alertas em toast**. **Config + timeline + presença detalhada** saem para um **drawer lateral "Detalhes & Configuração"** (abre só quando preciso). Isso elimina o scroll e maximiza o vídeo.

### B) Central (grade de câmeras)
| Quadrante | Imp | Freq | Decisão |
|---|---|---|---|
| **Grade de câmeras** (tiles: feed + estado + alertas) | 🔴 Alta | 🔴 Alta | Dominar; tiles dimensionados p/ caber ≤N **sem scroll**; scroll de galeria só p/ muitas câmeras |
| **Header** (hub, nº câmeras, demo, link relatório) | 🟠 Média | 🟢 Baixa | Vai p/ o **shell** (slim) |
| **Rodapé do tile** (nome, zonas, alertas) | 🟠 Média | 🟠 Média | Manter compacto |

### C) Relatório
É, por natureza, a **tela dedicada a "mais informações"**. Decisão: **acima da dobra** ficam KPIs + heatmap + ranking (a parte decisória, sem scroll); **abaixo** evolução + tabela de eventos (scroll aceitável **ou** em abas). A tabela é o único contêiner com scroll interno.

---

## 4. Navegação — virar SPA de verdade (app shell)

**Shell persistente** = um **rail lateral slim** (ícones + rótulo) sempre visível, e um cabeçalho fino constante. As telas trocam só no conteúdo (sem recriar topbar).

```
┌────┬──────────────────────────────────────────────────────────┐
│ ▣  │  cabeçalho fino: contexto da tela · status hub · privacidade│
│Cen │ ─────────────────────────────────────────────────────────│
│tral│                                                            │
│ 📊 │                  CONTEÚDO DA TELA ATIVA                    │
│Rel.│            (Central · Câmera · Relatório)                  │
│    │                                                            │
│ ⚙  │                                                            │
└────┴──────────────────────────────────────────────────────────┘
```
- Rail: **Central**, **Relatório**, (futuro: Config/Ajustes). Colapsa para ícones em telas médias; vira **barra inferior** no mobile.
- `/camera` (nó) **fica fora do shell** — é a visão do dispositivo, sem navegação (só feed).
- Câmera aberta = overlay/sub-rota dentro de Central, com **breadcrumb** "Central / Câmera X".

---

## 5. Layouts-alvo (sem scroll, responsivos)

### Câmera aberta — feed-dominante + drawer
```
┌─ Central / Câmera Pátio 1 ───────────── [⏸] [✎ zonas] [⚙ Detalhes] [✕] ┐
│                                                              ┌─────────┐ │
│                                                              │ DRAWER  │ │  ← abre sob demanda:
│                 FEED + OVERLAYS (domina)                     │ Config  │ │     • config de área (limite,
│            zonas coloridas · badges · pessoas                │ de área │ │       sensibilidade, excluir)
│                                                              │ Timeline│ │     • timeline de eventos
│                                                              │ Presença│ │     • presença detalhada
│                                                              └─────────┘ │
├──────────────────────────────────────────────────────────────────────────┤
│ ⚑ 2 alertas   ◉ 5 pessoas   ⏱ permanência 1m 20s        (toast de alerta) │  ← faixa KPI compacta (fixa)
└──────────────────────────────────────────────────────────────────────────┘
```
Sem painel lateral fixo gordo → feed maior. Drawer (slide-over) só quando configurar/auditar. Tudo cabe; nada rola.

### Central — grade que preenche
```
┌─ Central ──────────────────────── demo[ ] hub● 2 câmeras  + nó de câmera ┐
│  ┌───────────┐  ┌───────────┐                                            │
│  │ Câmera 1  │  │ Câmera 2  │     tiles dimensionados p/ caber sem scroll │
│  │ feed+est. │  │ feed+est. │     (galeria rola só com muitas câmeras)    │
│  └───────────┘  └───────────┘                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

### Relatório — decisão acima da dobra
```
[ filtros ]   KPIs (5)
[ heatmap hora×área ]        [ ranking de áreas ]      ← cabe sem scroll
[ evolução ] [ tabela de eventos (scroll interno) ]    ← detalhe abaixo
```

---

## 6. Sistema de espaçamento (tokens)
```
--sp-1: 4px   --sp-2: 8px   --sp-3: 12px   --sp-4: 16px   --sp-5: 24px
--radius-sm: 6px   --radius: 10px
```
Regras: padding de seção = `--sp-3`; gap de grid = `--sp-3`; padding de card = `--sp-3`; faixas/headers = `--sp-2`/`--sp-3`. Substitui todos os valores soltos. Densidade consistente.

---

## 7. Tela/área dedicada a "mais informações"
- **Drawer "Detalhes & Configuração" da câmera** (slide-over): config de área (limite, sensibilidade, excluir, renomear), timeline completa, presença detalhada. Tira o peso da tela ao vivo.
- **Relatório** já é a tela dedicada ao histórico/agregados (item separado no roadmap).
- Futuro: **tela de Ajustes globais** (no rail) p/ thresholds base, turnos, etc.

---

## 8. Responsividade (breakpoints)
| Faixa | Shell | Central | Câmera aberta | Relatório |
|---|---|---|---|---|
| **≥1200** | rail c/ rótulos | grade multi-col | feed + drawer | 2 colunas |
| **768–1199** | rail só ícones | grade 2 col | feed + drawer | empilha (já há `@media 1000`) |
| **<768** | barra inferior | 1 coluna | feed + **bottom-sheet** | empilhado, abas |

---

## 9. Plano de implementação (faseado)
- **F1 — Tokens + shell:** criar variáveis de espaçamento e o `AppShell` (rail + cabeçalho) envolvendo `/` e `/relatorio`; padronizar paddings/gaps. *(base de tudo; baixo risco)*
- **F2 — Câmera aberta sem scroll:** mover config/timeline/presença p/ **drawer**; faixa compacta de KPIs (deduplicada); alerta vira **toast**. *(maior ganho de espaço)*
- **F3 — Central responsiva:** grade que preenche o viewport; tile compacto consistente; estados no rodapé.
- **F4 — Relatório acima-da-dobra:** reorganizar p/ caber a parte decisória; scroll só na tabela; abas no mobile.
- **F5 — Responsivo fino:** breakpoints, bottom-sheet/bottom-nav no mobile, testes.

> Sugestão: começar por **F1 (tokens + shell)** e **F2 (câmera sem scroll)** — é onde está 80% do ganho de espaço e consistência.

---

## 10. Decisões em aberto
- Navegação do shell: **rail lateral slim** (recomendado, escala melhor) × abas no topo.
- Câmera aberta: **feed-dominante + drawer** (recomendado) × painel lateral slim fixo só com status.
- Relatório no mobile: **abas** (KPIs/Quando/Onde/Eventos) × scroll único.
