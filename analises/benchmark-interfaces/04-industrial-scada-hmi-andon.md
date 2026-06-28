# Benchmark de Interfaces — Visão de Máquina Industrial + SCADA/HMI de Sala de Controle + Andon

**Domínio:** Visão de máquina (Cognex/Keyence) · HMI High-Performance / ISA-101 · Alarm Management (ISA-18.2 / EEMUA 191) · Andon / OEE
**Data:** 2026-06-28
**Aplicação:** Central de monitoramento de visão computacional no navegador para Centro de Distribuição (CD) — feeds, zonas por câmera, estados (ATIVA/LENTA/OCIOSA/VAZIA/ALERTA), thresholds, alertas (Andon/WhatsApp), KPIs.

> **Nota de verificação:** Os princípios de design (cor contida, hierarquia overview→detalhe, indicadores analógicos, racionalização de alarmes) e os números de referência da EEMUA 191 (ex.: pico ≤10 alarmes/10 min) são repetidamente confirmados em múltiplas fontes públicas e citados abaixo. Os detalhes específicos de telas de produtos comerciais (Cognex VisionPro/In-Sight, Keyence CV-X/XG-X, Ignition) vêm de páginas de marketing/documentação dos fabricantes; **eu não testei os softwares ao vivo** — onde a descrição depende de captura de tela específica do produto, marquei como `[não verificado em uso real]`.

---

## 1. Panorama

Há quatro tradições de interface industrial maduras das quais o nosso sistema pode roubar diretamente, porque todos elas resolvem o mesmo problema central que temos: **um operador precisa monitorar muitas fontes simultâneas, perceber anormalidades em segundos e agir sem ser soterrado por ruído.**

1. **High-Performance HMI / ISA-101 (sala de controle de processo).** Filosofia originada no ASM Consortium e codificada pela ISA-101. A ideia-chave é contraintuitiva para quem vem de dashboards "bonitos": **a tela normal deve ser cinza e monótona; cor e movimento são um recurso escasso reservado para anormalidade.** Quando tudo está cinza, o olho humano detecta instantaneamente o único elemento que ficou amarelo/vermelho. Telas coloridas ("árvore de natal de luzes") destroem essa capacidade.

2. **Alarm Management (ISA-18.2 / EEMUA 191 / IEC 62682).** Disciplina dedicada a impedir que sistemas de alarme se tornem inúteis por excesso. Cobre priorização, racionalização (cada alarme precisa ser acionável), supressão de inundação (alarm flood), shelving (silenciar temporariamente com expiração), e métricas de saúde do sistema de alarmes. **Diretamente aplicável ao nosso Andon/WhatsApp** — é o antídoto contra "alerta falso em massa".

3. **Visão de máquina (Cognex / Keyence).** Sistemas de inspeção definem ROI (região de interesse) sobre a imagem, encadeiam ferramentas (presença/ausência, pattern match, medição, OCR), configuram tolerâncias e produzem uma decisão pass/fail por peça mais estatísticas agregadas. Separam claramente o modo **setup/configuração** do modo **run/live**. Modelo mental quase idêntico ao nosso "desenhar zonas sobre o feed + configurar thresholds + ver estado ao vivo".

4. **Andon / OEE (chão de fábrica).** Sinalização glanceable de status de linha/área com semáforo verde-amarelo-vermelho, baseada na filosofia Jidoka da Toyota (parar e tratar o problema na hora). Define escalonamento em níveis com gatilhos de tempo e registra todo evento para análise de causa-raiz. É exatamente o paradigma do nosso painel de zonas + Andon.

A convergência entre as quatro é forte: **estado normal discreto, anormalidade que salta aos olhos, hierarquia de telas do geral ao detalhe, e gestão rigorosa do que vira alerta.**

---

## 2. Catálogo de padrões de UI/feature

### 2.1 High-Performance HMI / ISA-101

| Padrão | Descrição concreta | Por que funciona |
|---|---|---|
| **Fundo cinza médio, "going gray"** | Background cinza médio (≈ RGB 192,192,192), não preto nem branco. Reduz ofuscamento (glare) e fadiga ocular, e dá contraste para que cores de anormalidade saltem. | Cor só significa algo se for rara. Fundo neutro transforma cor em sinal. |
| **Cor contida / paleta restrita** | Equipamento em operação normal = tons de cinza. Cor (amarelo, vermelho) usada **apenas** para condição anormal, alarme e ação do operador. Manter cores de foreground ao mínimo. | Evita dessensibilização ("árvore de natal"). O olho acha o único item colorido em ms. |
| **Consistência de cor obrigatória** | A mesma cor significa a mesma coisa em todas as telas. Erro clássico citado: usar vermelho para "rodando" numa tela e "parado" em outra. Padronizar e impor. | Cor inconsistente é apontada como perigosa — gera confusão e erro de operação. |
| **Hierarquia de telas (Levels 1-4)** | **Nível 1 – Area Overview:** visão de 30.000 pés, situacional, mostra imediatamente se há problema. **Nível 2 – Unit Control:** operador clica para agir no que viu no Nível 1. Níveis 3-4: detalhe/diagnóstico. Big-picture no topo, drill-down progressivo (progressive disclosure). | Operador navega do geral ao específico; overview também serve de navegação. |
| **Moving Analog Indicator (indicador analógico em contexto)** | Valor mostrado como seta apontando para uma barra segmentada que exibe faixa normal de operação, faixas de alarme baixo/alto e faixas de interlock. O operador vê em um relance se o valor está dentro ou fora da faixa — sem precisar ler o número. | Número cru ("87") não diz se é bom; a barra contextualizada diz na hora. Análogo > digital para julgamento rápido. |
| **Sparklines / mini-trends embutidos** | Mini gráfico de linha (histórico recente de um único ponto) embutido no gráfico de processo. Mostra direção e comportamento recente em espaço mínimo. | Valor estático não revela tendência. "Está subindo rápido?" é respondido visualmente. |
| **Foco em situational awareness (prever, não reagir)** | Combinar valor + faixa + tendência recente para o operador antecipar o problema antes do alarme disparar. | Reduz operação puramente reativa. |

Fontes: control.com "Going Gray"; Rockwell Process HMI Style Guide (proces-wp023); Ignition High-Performance HMI Techniques / Moving Analog Indicator; RealPars; Adroit ISA-101; Industrial Monitor Direct (ver §4).

---

### 2.2 Alarm Management (ISA-18.2 / EEMUA 191)

| Padrão | Descrição concreta | Aplicação no Andon/WhatsApp |
|---|---|---|
| **Racionalização: todo alarme é acionável** | Cada alarme tem de exigir uma ação humana definida e ter consequência se ignorado. Se não há ação a tomar, **não é alarme** (é, no máximo, informação/log). | Filtro de entrada brutal: estados de zona que não exigem ação humana NÃO devem virar push de WhatsApp. |
| **Priorização (matriz severidade × tempo)** | Prioridade derivada de gravidade da consequência e tempo disponível para reagir. EEMUA recomenda **distribuição com no máximo ~5% de alarmes de alta prioridade** (a maioria deve ser baixa/média). | Definir 3 níveis: Crítico (poucos, vão p/ WhatsApp+Andon), Médio (Andon na tela), Baixo (só log/relatório). |
| **Supressão de inundação (alarm flood)** | Quando muitos alarmes disparam juntos (ex.: falha de câmera/rede derruba 12 zonas), suprimir os secundários e mostrar a causa-raiz. Técnicas: first-out alarming, state-based suppression, flood suppression. | Se um feed cai, NÃO disparar 12 alertas "VAZIA"; disparar 1 alerta "Câmera X offline". |
| **Shelving (prateleira)** | Operador silencia temporariamente um alarme conhecido/nuisance, **com expiração automática** (re-aparece depois de X tempo) e registro de quem prateleirou. Diferente de desabilitar permanentemente. | Botão "silenciar zona por 30 min" durante manutenção/limpeza, com retorno automático. |
| **Acknowledge (reconhecimento)** | Operador reconhece que viu o alarme; muda o estado visual (ex.: para de piscar) mas mantém ativo até a condição normalizar. | Distinguir "ninguém viu ainda" (pisca) de "alguém assumiu" (sólido) no painel de zonas. |
| **Métricas de saúde do sistema de alarmes (EEMUA 191)** | Alvos de referência: **pico ≤ 10 alarmes / 10 min** por operador; ~**1 alarme / 10 min** em regime estacionário (média ~6/h); **standing alarms < 10** por console; **alta prioridade ≤ 5%** do total. | KPIs do nosso próprio sistema de alertas: se passarmos disso, estamos gerando ruído e perdendo credibilidade. |
| **Estado-base de supressão (state-based)** | Alarmes irrelevantes para o modo atual são suprimidos (ex.: zona "VAZIA" não é alarme fora do turno / fora de janela de operação). | Calendário/turno do CD suprime alertas de zonas inativas no período. |

Fontes: exida (SILalarm, recursos ISA-18.2/EEMUA 191); ProcessVue ISA-18.2; empoweredautomation (EEMUA); Yokogawa/Control Engineering; ANSI/ISA-18.2-2016 (ver §4).

---

### 2.3 Visão de máquina (Cognex / Keyence) `[detalhes de produto: não verificados em uso real]`

| Padrão | Descrição concreta | 
|---|---|
| **Separação Setup vs. Run/Live** | Ambiente gráfico (QuickBuild da VisionPro / phases de setup do CV-X/XG-X) para configurar; modo live/run para inspeção contínua. Dois modos com UIs distintas. |
| **ROI desenhado sobre a imagem** | Região de interesse definida graficamente sobre a imagem; ferramentas só processam dentro do ROI (acelera e foca). CogAcqROI na VisionPro ajusta largura/altura — janela menor = mais FPS. |
| **Encadeamento de ferramentas (tool blocks)** | Blocos modulares arrastáveis (pattern match, blob, caliper/medição, line location, OCR/OCV, leitura de código, AI). Reutilizáveis e adaptáveis. Keyence usa catálogo de ferramentas guiado por ícones ("o que você quer inspecionar?"). |
| **Tolerâncias e decisão pass/fail por ferramenta** | Cada ferramenta tem parâmetros/limiares (ex.: threshold de binarização para presença/ausência contando pixels; RGB/HSB para cor; faixa de medida). A combinação gera **judgement** pass/fail por peça. |
| **Teach por amostras boas (master image)** | Setup automático "ensinando" peças boas — ex.: Keyence faz setup automático com ≥30 peças boas. Estabelece o baseline do que é "normal". |
| **Estatísticas agregadas + validação de job** | Além do pass/fail instantâneo, acumula estatísticas (taxa de aprovação, histograma de scores) e tem validação de job antes de colocar em produção. |
| **Pattern para reposicionar (fixturing)** | Ferramenta de localização de padrão detecta posição da peça em movimento e reposiciona as demais ferramentas/ROIs relativamente — robustez a variação de posição. |

Fontes: Cognex VisionPro (cognex.com); Cognex In-Sight EasyBuilder docs; Keyence CV-X / XG-X (keyence.com) (ver §4).

**Tradução para o nosso CD:** o fluxo "desenhar zona no feed → escolher tipo de detecção → ajustar limiares → ver estado ao vivo + estatísticas" é estruturalmente o mesmo de configurar um job de inspeção. Vale copiar a separação clara setup/live, ROI gráfico, e o conceito de teach por baseline.

---

### 2.4 Andon / OEE

| Padrão | Descrição concreta |
|---|---|
| **Semáforo verde-amarelo-vermelho glanceable** | Verde = normal/no alvo; amarelo = atenção/derivando; vermelho = parar/intervenção. Legível à distância, alto contraste, poucos elementos. |
| **Filosofia Jidoka / line-stop** | Evento Andon não é "falha" e sim **dado valioso**: surge para tratar a causa-raiz enquanto a evidência está fresca. Cultura de escalar sem medo. |
| **Escalonamento em níveis por tempo** | Modelo típico: Nível 1 (amarelo) operador identifica; persistindo além de um 2º limiar (ex.: 10 min) → Nível 3 escala automaticamente p/ manutenção/engenharia/gestão (paging). Líder chega em ≤60s. |
| **Dashboards em camadas (tiered)** | **Operador:** nível estação, turno atual, 3-5 métricas máx (OEE atual, downtime última hora c/ causa, SKU/cycle time, meta×real), update sub-minuto, formato grande e glanceable. **Supervisor:** nível zona, multi-turno, 5-8 métricas (OEE da zona, top-3 causas de parada em Pareto, aderência ao plano, FPY, comparação turno-a-turno), update 5-15 min. |
| **Alerta com contexto** | Cada alerta ativo mostra nome da estação/zona, **tempo decorrido** e tipo de alerta. |
| **Log automático para causa-raiz** | Todo alerta, resposta e resolução é registrado → análise de padrões por turno, estações que falham repetidamente, relatórios factuais de causa-raiz. |
| **Tendências e metas dinâmicas** | Trend charts melhoram tempo de resposta (citado: ~35%). Meta deve ajustar dinamicamente para pausas/changeovers, senão o operador ignora. |

Fontes: Peakboard (Andon/OEE templates); Pickcel; Fabrico; Evocon; Guidewheel; GBMP; 6sigma.us; Signalo (ver §4).

---

### 2.5 Configuração de regras/limiares e perfis de usuário

| Padrão | Descrição concreta |
|---|---|
| **RBAC em 3 níveis** | **Operador:** roda, reconhece alarmes, vê todas as telas. **Supervisor:** altera setpoints dentro de faixas definidas, troca receitas, acessa diagnósticos. **Engenheiro/Manutenção:** acesso total — configuração, calibração, **mudança de limites de alarme**. |
| **Validação de entrada contra faixas** | Ao alterar um setpoint, a HMI valida o valor contra faixa permitida E contra o privilégio do usuário antes de aplicar. |
| **Controle por navegação** | Forma mais comum de aplicar acesso: segurar a navegação — cada papel só enxerga/acessa as telas permitidas; botões aparecem/somem por nível de acesso (visibilidade condicional). |
| **Config separada do runtime** | Limiares e regras moram em telas de engenharia, fora da tela operacional do dia-a-dia, evitando bagunça e alteração acidental. |

Fontes: AMD Machines; Advantech; Industrial Monitor Direct (Wonderware lockdown, button visibility); Rockwell Style Guide (ver §4).

---

## 3. O que roubar para o nosso CD

### 3.1 Filosofia de cor/estado das zonas (PRIORIDADE MÁXIMA)

Hoje a tentação é colorir tudo. Inverter: **adotar "going gray".**

- **Tela da central em cinza médio por padrão.** Feeds e cartões de zona em tons neutros quando o estado é "saudável".
- **Mapear os 5 estados ao princípio de cor contida:**
  - `ATIVA` → **cinza/neutro** (é o normal — não merece cor; talvez um discreto indicador "ok").
  - `LENTA` → **amarelo** (atenção/derivando).
  - `OCIOSA` → **amarelo** (atenção) — distinguir de LENTA por ícone/texto, não por uma 6ª cor.
  - `VAZIA` → depende do contexto: se for esperado, **neutro**; se for anormal no turno, **amarelo**.
  - `ALERTA` → **vermelho** (intervenção).
- **Consistência absoluta:** a mesma cor = o mesmo significado em todas as telas e relatórios. Documentar num style guide interno e impor.
- **Adicionar contexto, não só estado:** em cada zona, um **mini-trend/sparkline** (atividade na última hora) e/ou um **moving analog indicator** (ex.: nível de atividade vs. faixa normal vs. faixa de alerta). Isso transforma "está vermelho" em "está vermelho e piorando rápido".
- **Hierarquia overview→detalhe:** tela 1 = grid de todas as zonas/feeds (achar o problema em 1 olhada); clique → detalhe da zona (feed grande, histórico, thresholds, ações). Não tentar mostrar tudo numa tela só.

### 3.2 Gestão de alarmes do Andon/WhatsApp (PRIORIDADE MÁXIMA — antídoto contra spam)

Tratar o WhatsApp/Andon como um **sistema de alarme regido pela ISA-18.2/EEMUA 191**, não como um stream de eventos.

1. **Racionalizar:** só vira alerta o que **exige ação humana**. Estado de zona que ninguém precisa agir = log/relatório, nunca push.
2. **Priorizar em 3 níveis:** Crítico (WhatsApp + Andon vermelho) · Médio (Andon na tela, sem WhatsApp) · Baixo (só relatório). Mirar a regra EEMUA: **≤5% dos alertas como críticos.**
3. **Supressão de inundação (o ganho mais imediato):** se uma câmera/feed cai e derruba N zonas, disparar **1 alerta de causa-raiz** ("Câmera X offline") e suprimir os N alertas "VAZIA" secundários.
4. **Shelving com expiração:** botão "silenciar zona por 30/60 min" para limpeza/manutenção, com retorno automático e registro de quem silenciou e por quê.
5. **Acknowledge:** estado visual distinto entre "ninguém viu" (piscando) e "assumido por fulano" (sólido). Reduz alertas duplicados e ronda às cegas.
6. **Supressão por estado/turno:** fora da janela de operação do CD, zonas inativas não geram alerta.
7. **Escalonamento por tempo (Andon clássico):** Médio → se persistir além de X min → escala para Crítico/supervisor automaticamente.
8. **Monitorar a saúde do PRÓPRIO sistema de alertas** com as métricas EEMUA como KPI interno: pico ≤10/10min, média baixa, poucos alarmes "de pé" (standing). Se estourar, é sinal de que estamos virando ruído.

### 3.3 Config de thresholds sem virar bagunça

- **Perfis Operador × Engenheiro (RBAC).** Operador: vê, reconhece, silencia (shelve) temporariamente. Engenheiro: edita thresholds, regras e limites de alarme. Botões de config invisíveis para operador.
- **Config fora da tela operacional.** Limiares vivem numa tela de engenharia dedicada (por zona / por câmera / global com herança), não poluindo o monitor do dia-a-dia.
- **Modelo "job de inspeção" (Cognex/Keyence):** por zona → desenhar ROI no feed → escolher tipo de detecção → ajustar limiares → **validar/preview antes de ativar** → ver ao vivo + estatísticas. Separar nitidamente **Setup vs. Live**.
- **Teach por baseline:** permitir calibrar thresholds a partir de um período "normal" observado (análogo ao teach por peças boas do Keyence), em vez de o usuário chutar números.
- **Validação de faixa na edição:** impedir thresholds incoerentes (ex.: LENTA > OCIOSA) com validação no formulário.
- **Preview do impacto:** ao mudar um threshold, mostrar quantos alertas teriam disparado no histórico recente — evita configurar um gerador de spam sem perceber.

---

## 4. Referências

### High-Performance HMI / ISA-101
- "Going Gray: A New HMI Standard" — control.com — https://control.com/technical-articles/going-gray/
- Rockwell Automation Process HMI Style Guide (proces-wp023) — https://literature.rockwellautomation.com/idc/groups/literature/documents/wp/proces-wp023_-en-p.pdf
- Ignition User Manual — High Performance HMI Techniques — https://www.docs.inductiveautomation.com/docs/7.9/visualization-and-dashboards/understanding-components/high-performance-hmi-techniques
- Ignition User Manual — Moving Analog Indicator — https://www.docs.inductiveautomation.com/docs/7.9/appendix/components/display/moving-analog-indicator
- RealPars — Detailed Design Principles of High-Performance HMI Display — https://www.realpars.com/blog/hmi-display
- Adroit — ISA-101 High Performance HMI — https://adroit-europe.com/hphmi
- Industrial Monitor Direct — High Performance HMI Design Principles — https://industrialmonitordirect.com/blogs/knowledgebase/high-performance-hmi-design-principles-for-industrial-control
- Tatsoft FrameworX — ISA-101 HMI Compliance How-to — https://docs.tatsoft.com/display/FX/ISA-101+HMI+Compliance+How-to+Guide
- plcprogramming.io — HMI Design Best Practices 2026 — https://plcprogramming.io/blog/hmi-design-best-practices-complete-guide

### Alarm Management (ISA-18.2 / EEMUA 191 / IEC 62682)
- ANSI/ISA-18.2-2016 Management of Alarm Systems (PDF) — https://18817087.s21i.faiusr.com/61/ABUIABA9GAAgyZfj5AUozIu7wwI.pdf
- exida — Alarm Management Resources (ISA-18.2 / EEMUA 191) — https://www.exida.com/Alarm-Management/Resources
- exida — SILalarm (Alarm Rationalization Tool) — https://www.exida.com/silalarm
- ProcessVue — ISA 18.2 Alarm Management Guidelines — https://www.processvue.com/resources/alarm-management-guidelines/
- empoweredautomation — EEMUA Alarm Management — https://www.empoweredautomation.com/eemua-alarm-management
- empoweredautomation — Standards for Alarm Management — https://www.empoweredautomation.com/which-are-the-standards-for-alarm-management
- Yokogawa / Control Engineering — Implementing Alarm Management per ANSI/ISA-18.2 — https://www.yokogawa.com/us/library/resources/media-publications/implementing-alarm-management-per-the-ansi-isa-182-standard-control-engineering/
- EEMUA Publication 191 Edition 4 (contents) — https://www.eemua.org/getattachment/9d3f8071-55c3-49bf-a74a-3bf6ad4a2e0f/Contents-EEMUA-Publication-191-Edition4-November-2024.pdf

### Visão de máquina (Cognex / Keyence) `[detalhes de produto não verificados em uso real]`
- Cognex VisionPro Software — https://www.cognex.com/en/products/machine-vision-software/visionpro-software
- Cognex In-Sight EasyBuilder — Pattern Presence/Absence parameters — https://support.cognex.com/docs/is_574/web/EN/ezb/Content/EasyBuilder/EasyBuilderLite/Inspect_PA_Pattern_Parameters.htm
- Cognex — Frame Grabber ROI and Acquisition Frame Rate — http://help.cognex.com/Content/KB_Topics/VisionPro/Acquisition/2902.htm
- Keyence CV-X series — https://www.keyence.com/products/vision/vision-sys/cv-x100/
- Keyence XG-X series — https://www.keyence.com/products/vision/vision-sys/xg-x/
- Keyence CV-X Setup Guide (phases) — https://www.keyence.com/support/user/vision/cv-x/phase/

### Andon / OEE
- Peakboard — Digital Andon + OEE multiple lines — https://www.peakboard.com/en/solutions/oee-dashboard-multiple-lines
- Pickcel — Andon Board Explained / Digital Signage — https://www.pickcel.com/blog/andon-board-digital-signage/
- Fabrico — Best OEE Dashboard Examples 2026 — https://www.fabrico.io/blog/best-oee-dashboard-examples-manufacturing/
- Evocon — OEE Dashboard — https://evocon.com/feature/oee-dashboard/
- Guidewheel — Design an OEE dashboard that drives action — https://www.guidewheel.com/blog/oee-dashboard
- GBMP — Andon Systems: How Visual Signals Stop Problems — https://www.gbmp.org/bettereverydayleannews/andon-systems-in-manufacturing-how-visual-signals-stop-problems-before-they-spread
- SixSigma.us — Andon Cord / Toyota Production System — https://www.6sigma.us/six-sigma-in-focus/andon-cord-lean-manufacturing-tps/
- Signalo — How an Andon Alert System Works — https://signalo.us/andon-alert-system/

### RBAC / Configuração / Telas de operador vs. engenheiro
- AMD Machines — HMI Design Best Practices for Operators — https://amdmachines.com/blog/hmi-design-best-practices-for-operators/
- Advantech — What is HMI (Ultimate Guide) — https://www.advantech.com/en-us/resources/industry-focus/what-is-hmi-the-ultimate-guide-to-human-machine-interface
- Industrial Monitor Direct — Wonderware HMI security lockdown — https://industrialmonitordirect.com/blogs/knowledgebase/wonderware-hmi-security-lockdown-configuration-guide
- Industrial Monitor Direct — HMI Button Visibility by User Access Level — https://industrialmonitordirect.com/blogs/knowledgebase/configuring-hmi-button-visibility-by-user-access-level
