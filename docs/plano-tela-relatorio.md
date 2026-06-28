# Plano — Tela de Relatório Operacional / Histórico (item #1)

> Plano em **2026-06-09**, com foco em **interface (usabilidade, semântica, hierarquia visual)**. Implementação a seguir, após validação.
> Origem: gap #1 de [`cobertura-vs-documento.md`](./cobertura-vs-documento.md).

---

## 1. Necessidade registrada

O documento pede, repetidamente (págs. 3, 5, 6, 8), uma camada de **histórico e relatório operacional** — e afirma que **"o valor está nos indicadores, alertas e histórico"**. Especificamente:
- **Relatório por turno, área e horário**; **resumo diário e semanal**.
- **Horários críticos** (quando a operação mais para).
- **Áreas com maior ociosidade** (ranking) e **oportunidades de melhoria**.
- **Comparar antes/depois** e medir alertas/tempo parado (ROI do piloto).

Hoje a POC só tem resumo **ao vivo da sessão**. Esta tela transforma a POC em **material de decisão/case** — é o "resultado mensurável" que o documento exige.

**Princípio LGPD:** persistir **apenas indicadores** (estado/tempo/contagem por área), **nunca imagens**.

---

## 2. Conceito da tela

Uma tela de **leitura gerencial** (não operacional/ao vivo). Responde, de cima para baixo, a perguntas em ordem de prioridade:

> **Como foi o período? → Quando para? → Onde para mais? → Está melhorando? → Quais eventos? → O que fazer?**

Cada bloco responde **uma** pergunta. Essa é a hierarquia visual.

Rota nova: **`/relatorio`** (link no header da central). Mantém o tema dark técnico do app.

---

## 3. Wireframe (hierarquia visual)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Relatório Operacional        [Hoje ▾][Turno: Todos ▾][Área: Todas ▾]  ⬇ CSV ⎙ │  ← contexto/filtros (sticky)
│ Visão: Hoje · Todas as áreas · Turno: todos                                   │     (subtítulo = lente atual)
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
│  │ 2h 14m   │ │   37     │ │ Expedição│ │  14h–15h │ │   82%    │            │  ← KPIs (resposta em 3s)
│  │tempo     │ │ alertas  │ │ área mais│ │ horário  │ │ tempo    │            │     com Δ vs período anterior
│  │parado ▲12%│ │   ▼5%    │ │ parada   │ │ crítico  │ │ ativo    │            │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘            │
├───────────────────────────────────────────────┬───────────────────────────────┤
│  QUANDO PARA — Horários críticos                │  ONDE PARA MAIS — Ranking      │
│  heatmap hora-do-dia × área (intensidade)       │  barras horizontais por área   │
│   00 02 04 06 08 10 12 14 16 18 20 22           │  Expedição ████████ 1h02 (18)  │
│  Exped ░░░░░░░░▓▓██▓▓░░░░  ← pico 14h            │  Carga    █████ 38m (9)         │
│  Carga ░░░░▓▓░░░░░░██░░░░                        │  Estoque  ███ 21m (6)          │
│  ...                                            │  Espera   ██ 13m (4)           │
├─────────────────────────────────────────────────────────────────────────────┤
│  ESTÁ MELHORANDO? — Evolução (dia a dia / turno) │  barras empilhadas por dia    │  ← tendência / antes-depois
│   Seg ▇▇▇  Ter ▇▇  Qua ▇▇▇▇  Qui ▇▇  Sex ▇       (tempo parado por dia)         │
├─────────────────────────────────────────────────────────────────────────────┤
│  EVENTOS — Tabela de alertas (auditoria, exportável)                          │  ← detalhe / drill-down
│  hora     área       câmera     duração   turno                               │
│  14:12    Expedição  Cam-Pátio  18m       Tarde                               │
│  ...                                                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  💡 Oportunidades: "Expedição concentra 62% do tempo parado, com pico às 14h." │  ← insight textual gerado
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Blocos, semântica e usabilidade

1. **Barra de contexto/filtros (sticky):** período (Hoje · 7d · 30d · personalizado), turno, área/câmera; export (CSV, imprimir/PDF), e um **subtítulo que descreve a lente atual** em texto ("Hoje · Todas as áreas") — o usuário nunca fica em dúvida do que está vendo. *Usabilidade: estado sempre explícito.*
2. **Faixa de KPIs:** 5 números grandes (tempo parado total, nº de alertas, área mais parada, horário crítico, % tempo ativo) com **Δ vs período anterior** (seta ▲/▼ + cor) — o **comparativo antes/depois** embutido. *Hierarquia: o que importa primeiro, em fonte grande mono.*
3. **Horários críticos (heatmap):** hora-do-dia × área, intensidade clara→vermelha = concentração de ociosidade/alertas. Responde **"quando para"**. *Semântica: intensidade, não categorias.*
4. **Ranking de áreas (barras horizontais ordenadas):** tempo parado + nº de alertas por área, cor semântica (verde→âmbar→vermelho). Responde **"onde para mais"**.
5. **Evolução (barras por dia/turno):** tendência ao longo do período → **antes/depois** visual.
6. **Tabela de eventos:** alertas com hora/área/câmera/duração/turno; ordenável; é o **detalhe auditável** e a base do export.
7. **Oportunidades de melhoria:** 1–3 frases geradas das métricas (concentração %, pico de horário, área dominante). Traduz dado em **decisão** — fecha o ciclo "indicador → decisão".

**Paleta semântica (consistente com o app):** `--ok` verde = ativo/saudável · `--idle` âmbar = ocioso/atenção · `--alert` vermelho = crítico · slate = estrutura/neutro. Heatmap usa escala de intensidade até vermelho.

**Modo apresentação:** botão que oculta filtros e amplia os gráficos (limpo para projetar na reunião).

**Empty state honesto:** sem dados → mensagem + botão **"carregar dados de demonstração"** (rotulado claramente), para a tela ficar rica numa demo curta sem fingir produção.

---

## 5. Camada de dados (secundária ao desenho, mas necessária)

- **Persistência client-side (IndexedDB)** — **só indicadores**, nunca imagens (LGPD). A central grava enquanto roda.
- **Modelo (amostras agregáveis):** por `(câmera, zona, timestamp)` → `{ estado, idleMs incremental, alertas, pessoas }`. Agregação por **hora / turno / dia** sob demanda.
- **Turnos** definidos no `config.ts` (faixas horárias: ex. Manhã 06–14, Tarde 14–22, Noite 22–06).
- **Eventos de alerta** persistidos com início/fim/duração/área/câmera/turno.
- **Seed de demonstração:** gerador de dados sintéticos plausíveis (vários dias/turnos, com um pico claro) para ilustrar a tela — sempre rotulado "dados de demonstração".
- **Export:** CSV (eventos + agregados) e **imprimir/PDF** (CSS de impressão); JSON opcional.

---

## 6. Plano de implementação (incremental, tela primeiro)

**Etapa A — Tela com dados mock (foco 100% na interface):** montar `/relatorio` com layout, KPIs, heatmap, ranking, evolução, tabela e insight, alimentados por **dados de demonstração** em memória. Validar usabilidade/semântica/hierarquia. *(o "montar uma tela primeiro" que você pediu)*
**Etapa B — Persistência real (IndexedDB):** a central passa a gravar indicadores; a tela lê e agrega; filtros funcionam sobre dados reais.
**Etapa C — Export + modo apresentação + insights automáticos.**

> Começamos pela **Etapa A**: a melhor interface, com dados mock realistas, sem depender ainda da persistência. Assim iteramos o visual rápido.

---

## 7. Decisões em aberto (rápidas)
- Rota dedicada `/relatorio` (recomendado) **ou** aba dentro da central `/`?
- Heatmap **hora×área** (recomendado, denso e informativo) **ou** barras simples por hora (mais simples)?
- Export inicial: **CSV + imprimir** (recomendado) — PDF nativo fica para depois.
