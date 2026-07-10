# Benchmark de Interfaces 01 — Centros de Controle de Missão (NASA / Aeroespacial / Defesa)

> Pesquisa de UX para a central multi-câmera de visão computacional do CD.
> Domínio analisado: **Situational Awareness em salas de controle de missão e Common Operating Picture (COP) militar.**
> Data: 2026-06-28. Autor: agente de pesquisa de UX.
> Convenção: trechos marcados **[VERIFICADO]** vêm de fontes citadas; **[INFERÊNCIA]** é interpretação/derivação minha; **[NÃO VERIFICADO]** é afirmação plausível que não consegui confirmar diretamente.

---

## 1. Panorama dos sistemas analisados

Foram analisados cinco "universos" de interface, todos com o mesmo problema central que temos: **um ou poucos humanos precisam manter consciência situacional sobre muitas fontes simultâneas (vídeo + telemetria + alertas) em ambiente de alta consequência.**

| Sistema | O que é | Relevância para nós |
|---|---|---|
| **NASA Mission Control Center (MCC/JSC Houston)** | Sala de controle de missões tripuladas. Linhas de consoles especializados (FLIGHT, CAPCOM, EECOM, GUIDANCE, etc.) + grande "front wall" de telas compartilhadas. Cada controlador opera 4–6 monitores. **[VERIFICADO]** | Modelo de "muitos operadores especializados + parede compartilhada"; formatos visuais sóbrios e padronizados. |
| **NASA Open MCT** | Framework open-source de visualização de telemetria usado pela NASA (Ames). Web, desktop+mobile. Compõe objetos (plots, tabelas, imagens, timelines) em layouts arrastando-e-soltando. **[VERIFICADO]** | É literalmente um construtor de dashboards de monitoramento — referência direta de UI montável por papel/missão. |
| **COP — Common Operational Picture (defesa)** | Visão única e canônica compartilhada por vários comandos: posição de tropas/ativos/infra, status. Fonte única de verdade ("track database"), displays são views read-only. **[VERIFICADO]** | Princípio de "uma verdade compartilhada" entre operadores, supervisores e Andon/WhatsApp. |
| **Salas de controle modernas (video wall + workstation)** | Combinação de parede de vídeo (visão coletiva agregada) + monitores de mesa (análise individual focada), mantidos sincronizados. **[VERIFICADO]** | Mapeia direto para "grade de feeds ao vivo (overview)" + "câmera em foco (detalhe)". |
| **High-Performance HMI / ISA-101 / EEMUA 191 / ISO 11064** | Corpo de normas e boas práticas de salas de controle industriais: hierarquia de displays em níveis, filosofia de alarme, codificação de cor sóbria, ergonomia de sala. **[VERIFICADO]** | Fornece as regras concretas de cor, alarme e hierarquia que faltam num MVP. |

Fio condutor entre todos: **sobriedade visual, cor reservada para o anormal, valor sempre com contexto, e hierarquia overview→detalhe.**

---

## 2. Catálogo de padrões de UI/feature observados

### P1 — Parede compartilhada (overview) + estações de detalhe, sincronizadas
- Video walls dão "uma visão ampla e centralizada, ideal para dados agregados"; displays de mesa dão "visão focada e detalhada para análise individual". A boa prática é mantê-los **sincronizados**, para que a equipe transite entre visão-geral e ação "sem perder o contexto". **[VERIFICADO]**
- No MCC, a "front wall" de telas grandes coexiste com consoles individuais; o operador mantém consciência periférica na parede e trabalha o detalhe no console. **[VERIFICADO]**
- No MCC Apollo/Gemini, os displays frontais somavam ~18,3 m (60 pés) de largura combinada — a "big picture" é fisicamente dominante. **[VERIFICADO]**

### P2 — Consoles modulares / displays compostos por papel
- Consoles do MCC eram **modulares**: painéis em múltiplos de uma grade fixa, recolocáveis "em minutos". **[VERIFICADO]**
- Open MCT: "telemetry points can be composed into plots, tables, and other views… layouts of multiple display elements that are sized and placed by the user", via **drag-and-drop**, com "composições únicas… definidas para cada papel de operações". **[VERIFICADO]**
- Resultado: o mesmo dado base, múltiplas montagens por função (ex.: quem cuida de fadiga vê um layout; quem cuida de leitura de códigos vê outro).

### P3 — Dois modos de atenção: monitoramento passivo vs. varredura ativa
- Controladores usam dois modos: **monitoramento passivo** (consciência ampla, atenção disparada por "pistas salientes como mudança de cor ou ruptura de limite") e **varredura ativa** ("sweeps rítmicas e rotineiras pelos displays para detectar desvios sutis"). **[VERIFICADO]**
- Implica: a UI tem de ser **glanceable** (o anormal "salta") no modo passivo, e **escaneável de forma previsível** (layout estável) no modo ativo.

### P4 — Vocabulário visual sóbrio e padronizado
- Formatos predominantes no MCC: "tabelas, gráficos de linha de duas variáveis, indicadores de status codificados por cor, e logs em texto", projetados para "clareza, consistência e velocidade de interpretação". A **simplicidade é intencional** (estabilidade, redundância, fluência interpretativa). **[VERIFICADO]**

### P5 — Hierarquia de displays em níveis (High-Performance HMI / ISA-101)
- Hierarquia recomendada **Nível 1 → Nível 4**: **[VERIFICADO]**
  - **N1 — Overview da área**: a "big picture" de toda a área de responsabilidade do operador; KPIs e síntese de alarmes.
  - **N2 — Unidade**: diagrama da unidade com valores-chave e pistas causais.
  - **N3 — Loop/dispositivo**: detalhe, diagnóstico, "faceplate".
  - (N0 executivo / N4 detalhe fino conforme a variante).
- Regra de navegação: **displays N2 críticos alcançáveis em ≤3 cliques** a partir de qualquer N1; drill-down raso e previsível evita o pico de erro de árvores de navegação profundas. **[VERIFICADO]**

### P6 — Cor reservada ao anormal ("color discipline")
- Princípio central: "**reserve cor saturada só para alarmes e mudanças de estado**; use paleta cinza neutra para fundo e equipamento". **[VERIFICADO]**
- Paleta de exemplo citada: fundo `#2f2f2f`, painéis `#3b3b3b`, texto `#e6e6e6`. **[VERIFICADO]**
- Codificação de prioridade de alarme (ASM/EEMUA): **Advisory** azul-claro `#7ac7ff`, **High** amarelo `#FFD966`, **Critical** vermelho `#FF2E2E`. **[VERIFICADO]**
- Equipamento em escala de cinza para "eliminar ruído decorativo de cor". **[VERIFICADO]**

### P7 — Valor sempre com contexto (não número cru)
- "**Mostre valores com contexto** (janela operacional, mini-sparkline de tendência, faixa-alvo) em vez de números crus." **[VERIFICADO]**
- HPHMI mostra "não só o valor de processo, mas onde ele está em relação ao que é bom"; o anormal é projetado para "se destacar claramente". **[VERIFICADO]**
- Táticas: sparkline embutido ao lado do número; bandas-alvo/janelas operacionais como qualificadores visuais. **[VERIFICADO]**

### P8 — Síntese de alarme + ação sugerida em toda tela de overview
- "**Alarm synopsis** (compacta, ordenável) em toda tela de overview" e "banner de alarme com contagens priorizadas + uma linha única de ação sugerida". **[VERIFICADO]**

### P9 — Filosofia de alarme (limitar a carga, não só pintar de vermelho)
- EEMUA 191: meta de **≤ ~6 alarmes / 10 min** em operação normal; o maior fator para ficar na meta é um sistema **bem racionalizado**. **[VERIFICADO]**
- Métricas de aceitação citadas: exposição ≤12 alarmes/hora (longo prazo); ≤1% das janelas de 10 min com >10 alarmes simultâneos. **[VERIFICADO]**
- Três estágios de gestão de alarme: **Filosofia → Racionalização → Monitoramento**. **[VERIFICADO]**

### P10 — Fonte única de verdade / picture canônica compartilhada (COP)
- Propriedade crítica do COP: **autoritatividade** — "há uma versão canônica, mantida pelo sistema, e todos veem a mesma coisa", com displays como **views read-only** sobre o banco de tracks (single source of truth). **[VERIFICADO]**
- COP deve ser "tão claro e completo quanto possível", **confiável e preciso**, e a informação **reconhecível e acessível** a quem precisa de consciência situacional. **[VERIFICADO]**

### P11 — Telemetria + vídeo + procedimentos no mesmo lugar
- Open MCT exibe "dados em streaming e históricos, imagens, timelines, procedimentos e outras visualizações, tudo em um lugar", com **time conductor** (navegação no tempo — histórico vs. tempo real). **[VERIFICADO — exibição integrada; "time conductor" como nome do recurso é NÃO VERIFICADO nesta fonte específica, mas é recurso conhecido do Open MCT]**
- MCC moderno recebe "feeds de vídeo em alta definição, vitais fisiológicos instantâneos da tripulação, e diagnósticos detalhados" para "consciência situacional contínua e confiável". **[VERIFICADO]**

### P12 — Ergonomia de sala e colaboração/turnos (ISO 11064)
- ISO 11064: princípios de design ergonômico de centros de controle — layout do espaço, arranjo de consoles e ambiente para **reduzir fadiga e erro do operador**. **[VERIFICADO]**
- Posicionar a parede de vídeo em ângulos de visão ideais reduz fadiga visual e acelera a absorção da informação crítica. **[VERIFICADO]**
- Estrutura por papéis especializados (FLIGHT/CAPCOM/EECOM…) implica **divisão de responsabilidade + escalonamento** (ex.: CAPCOM como ponto único de comunicação). **[VERIFICADO — estrutura de papéis; mecânica fina de handover de turno é NÃO VERIFICADO]**

---

## 3. O que roubar para o nosso CD

Mapeamento direto de cada padrão para a central multi-câmera / zonas / modos / alertas / relatórios.

### 3.1 Layout & navegação
- **[P1+P5] Adotar hierarquia explícita de 3 níveis na central:**
  - **N1 — Mural (overview):** a grade de feeds ao vivo de todas as câmeras = nossa "front wall". Cada tile deve ser glanceable: borda/realce de estado, contador de alertas, indicador de zona ativa, "última detecção há X". Sem cor decorativa.
  - **N2 — Câmera em foco:** clicar num tile abre a câmera com overlays de detecção, máscaras/zonas e telemetria lateral (P11).
  - **N3 — Evento/detalhe:** clicar num alerta/detecção abre o recorte (frame/clip), histórico e ação sugerida.
  - Regra de ouro: **qualquer câmera em foco alcançável em ≤2–3 cliques** a partir do mural (P5).
- **[P1] Sincronizar overview↔foco:** ao focar uma câmera, o mural permanece visível (mini-grid lateral ou faixa), para não perder contexto periférico — exatamente o "video wall + workstation sincronizados".
- **[P2] Layouts por modo/papel:** permitir que o mesmo conjunto de câmeras tenha "presets" de layout por finalidade — preset Fadiga, preset Leitura de Códigos, preset Atividade/Presença, preset Objetos. Inspirado no drag-and-drop por papel do Open MCT. Começar com presets fixos; evoluir para arrastar-e-soltar.

### 3.2 Consciência situacional & glanceability
- **[P3] Projetar para os dois modos de atenção:** no mural (passivo), o anormal tem de "saltar" sozinho (mudança de cor/realce). No foco (ativo), manter **layout estável e previsível** entre câmeras para o operador escanear sempre nos mesmos lugares. Não mover elementos de posição entre câmeras.
- **[P7] Toda métrica com contexto, nunca número cru:** ao lado do vídeo, mostrar não "12 pessoas" mas "12 / faixa esperada 8–15", com **sparkline** das últimas N janelas (ocupação da zona, taxa de leitura de códigos, índice de fadiga, throughput). Banda-alvo visual = operador entende "isto está bom?" sem pensar.
- **[P4] Vocabulário visual sóbrio e consistente:** padronizar tabelas, mini-gráficos de linha, chips de status e logs de evento. Mesma forma para a mesma coisa em todas as telas. Resistir à tentação de "enfeitar".

### 3.3 Alertas (Andon / WhatsApp)
- **[P6] Disciplina de cor:** UI base em cinza-escuro (sugestão de partida: fundo `#2f2f2f`, painéis `#3b3b3b`, texto `#e6e6e6`). Cor saturada **só** para estado/alerta. Padronizar 3 níveis: **Advisory** azul `#7ac7ff`, **High** amarelo `#FFD966`, **Critical** vermelho `#FF2E2E`. Isso dá semântica imediata ao Andon e às mensagens de WhatsApp (mesma cor/ícone na tela e na notificação).
- **[P8] Painel "Alarm synopsis" sempre visível:** uma lista compacta e ordenável de alertas ativos (por prioridade/câmera/zona/modo) + banner com contagem priorizada + **uma linha de ação sugerida** por alerta ("Conferir doca 3 — pessoa em zona restrita há 40s"). Isto vira o conteúdo natural da mensagem de WhatsApp.
- **[P9] Filosofia de alarme — ANTES de adicionar mais alertas:** definir um pequeno documento de filosofia (Filosofia→Racionalização→Monitoramento). Metas concretas roubadas das normas: manter a taxa de alertas baixa o suficiente para serem acionáveis (referência: ordem de poucos por 10 min por operador; alertar quando >X simultâneos). **Deduplicar e agrupar** detecções (ex.: a mesma pessoa fora de zona não dispara 30 alertas/30 frames). Crucial num sistema de visão computacional, que tende a gerar ruído por frame.
- **[P9] Escalonamento:** Advisory fica só na tela; High vira Andon; Critical vira Andon + WhatsApp. Evita fadiga de notificação no WhatsApp.

### 3.4 Dados, integração e colaboração
- **[P10] Fonte única de verdade:** o backend mantém o estado canônico de detecções/alertas; mural, tela de foco, Andon, WhatsApp e relatórios são todos **views read-only** do mesmo estado. Garante que supervisor e operador "veem a mesma coisa" e que o relatório bate com o que apareceu ao vivo.
- **[P11] Telemetria + vídeo + linha do tempo juntos, com navegação no tempo:** ao lado do feed, um "time conductor" simples — alternar **ao vivo ↔ histórico** e arrastar para revisar a janela de um alerta (ver o clipe que disparou). Une vídeo, overlays e métricas no mesmo eixo de tempo.
- **[P12] Ergonomia e turnos:** se houver mural físico no CD, aplicar ISO 11064 (ângulos de visão, reduzir fadiga). Em software: prever **handover de turno** (quem está de plantão, alertas reconhecidos/pendentes, "passar bastão" com notas) e papéis (operador vs. supervisor), inspirado na divisão de funções do MCC.

### 3.5 Construção incremental (Open MCT como modelo mental)
- **[P2+P11]** Tratar nossa central como um **composer de painéis**: blocos reutilizáveis (tile de câmera, plot de métrica, tabela de eventos, synopsis de alarme, recorte/clip) que se combinam em layouts por modo. Não precisamos do Open MCT em si, mas o modelo "objetos componíveis + layouts por papel" é o alvo arquitetural de UI. *(Avaliar Open MCT como referência de código/UX — licença open source, NASA Ames.)*

### Prioridade sugerida (esforço × impacto)
1. **P6 disciplina de cor + P8 alarm synopsis** — barato, transforma a percepção de maturidade imediatamente.
2. **P9 filosofia de alarme/dedupe** — essencial para visão computacional não virar spam; alto impacto.
3. **P5/P1 hierarquia overview→foco→evento sincronizada** — estrutura a navegação toda.

---

## 4. Referências

### NASA Mission Control / consoles
- The display/control complex of the Manned Space Mission Control Center (Hendrickson, 1967), Wiley/SID — https://sid.onlinelibrary.wiley.com/doi/full/10.1002/j.2637-496X.1967.tb01263.x
- JSC Mission Control Center — NASA — https://www.nasa.gov/johnson/jsc-mission-control-center/
- Building on a Mission: The Houston Mission Control Center — NASA — https://www.nasa.gov/history/building-on-a-mission-the-houston-mission-control-center/
- Mission Control Center — Houston Display and Control System (PDF, Academia) — https://www.academia.edu/70586705/Mission_Control_Center_Houston_Display_and_Control_System
- Diagram of NASA Mission Control — Smithsonian National Air and Space Museum — https://airandspace.si.edu/multimedia-gallery/image/nasa-consolesjpg
- "NASA's high-tech nerve center" — Artemis 2 Mission Control (WION) — https://www.wionews.com/photos/-nasa-s-high-tech-nerve-center-understanding-the-tech-behind-artemis-2-mission-control-room-1774942910386
- Visualization Was Here (Parsons, arXiv 2510.00266) — fonte das citações sobre modos passivo/ativo e formatos de display — https://arxiv.org/pdf/2510.00266

### NASA Open MCT
- Open MCT — GitHub — https://github.com/nasa/openmct
- About Open MCT — https://nasa.github.io/openmct/about-open-mct/
- Open MCT — site oficial — https://www.openmct.com/
- Open MCT — NASA Software Catalog (ARC-15256-1D) — https://software.nasa.gov/software/ARC-15256-1D
- Open Source Next Generation Visualization Software (NTRS PDF) — https://ntrs.nasa.gov/api/citations/20160006385/downloads/20160006385.pdf

### Common Operating Picture (defesa)
- Common operational picture — Wikipedia — https://en.wikipedia.org/wiki/Common_operational_picture
- Common Operating Picture in Military Situational Awareness (Robertson, Semantic Scholar) — https://www.semanticscholar.org/paper/Common-Operating-Picture-in-Military-Situational-Robertson/b1ec0edd4557aaaff8e4b8e705f9e690719a486a
- COP: How It's Built in Modern Defense Software (Corvus Intelligence) — https://corvusintell.com/blog/c2-systems/cop-common-operational-picture/
- Integrity of a common operating picture (IEEE Xplore) — https://ieeexplore.ieee.org/document/6950514/

### Video walls / salas de controle
- Video Wall vs Desktop Displays for Modern Control Rooms (Primate) — https://www.primate-tech.com/resources/video-wall-vs-desktop-displays-for-modern-control-rooms
- Understanding the big picture for modern control room design (Samsung Insights) — https://insights.samsung.com/2019/08/29/understanding-the-big-picture-on-control-room-display-technology
- Best Monitor Layouts For Control Room Ergonomics (Tresco) — https://www.trescoconsoles.com/blog/the-best-monitor-layout-for-your-control-room/

### High-Performance HMI / ISA-101 / EEMUA 191 / ISO 11064
- How to Maximize Operator Effectiveness with a High-Performance HMI (ISA blog, Hollifield) — https://blog.isa.org/the-high-performance-hmi
- The High Performance HMI — Process graphics (IDC PDF) — https://www.idc-online.com/technical_references/pdfs/electronic_engineering/The_high_performance.pdf
- Apply ISA-101: HMI Standards for Safer Operations — https://beefed.ai/en/isa-101-hmi-standards-guide
- HMI Design Best Practices: ISA-101 Guide (EDWartens) — https://edwartens.co.uk/blog/hmi-design-best-practices-ISA-101-guide
- EEMUA Pub No 191 — Alarm Systems (GlobalSpec) — https://standards.globalspec.com/std/1639343/eemua-pub-no-191
- Effective HMI Design and Alarm Management (EEMUA 191) — Koyer — https://koyertraining.com/coursedetail?courseid=1031
- Building an HMI that Works (Opto22 white paper, PDF) — https://documents.opto22.com/2061_High_Performance_HMI_white_paper.pdf

---

### Notas de confiança
- As paletas de cor hex (`#2f2f2f`, `#FF2E2E`, etc.) e a hierarquia N0–N4 vêm de um guia interpretativo de ISA-101 (beefed.ai). São **valores de exemplo coerentes com ASM/EEMUA**, não números normativos literais — tratar como ponto de partida, não como norma citável. **[PARCIALMENTE VERIFICADO]**
- "Time conductor" do Open MCT: recurso real e conhecido do produto, mas o nome não apareceu literalmente nas páginas que consultei nesta sessão. **[NÃO VERIFICADO nesta sessão]**
- Mecânica fina de handover de turno do MCC (procedimentos exatos) não foi confirmada em fonte primária aqui. **[NÃO VERIFICADO]**
