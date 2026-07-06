# 01 — Referências de mercado: como softwares técnicos resolvem UI densa de monitoramento

> Pesquisa de mercado (jul/2026) para o redesign semântico do `visao_computacional_mvp`.
> Queixa a resolver: interface confusa, muito texto, controles legados, desalinhamentos.
> Norte: app **semântico** (ícone+cor com significado), texto mínimo, layout simples **sem perder função**.
> Compatível com a doutrina da casa: "going gray" (base neutra, cor saturada só para anormalidade) e Radix como camada de UI.

---

## 1. VMS / plataformas de câmeras — o que cada produto ensina

### 1.1 Frigate (0.14+) — desenhar em torno de 3 perguntas do operador

O rebuild da UI do Frigate 0.14 foi explicitamente projetado em torno de **três objetivos de usuário**, não de features:

1. *"O que está acontecendo agora / o que acabou de acontecer?"*
2. *"O que aconteceu nas últimas 24h?"*
3. *"Perdi alguma coisa?"*

Decisões concretas que valem copiar:

- **Home = grade ao vivo + filmstrip de alertas** no topo (thumbnails animados dos eventos recentes acima dos feeds). O operador vê "o que há de novo" sem abrir nada.
- **Economia visual e de banda**: tiles mostram imagem estática (atualizada ~1×/min) em inatividade e **transicionam sozinhos para live** quando há movimento — o movimento é que chama atenção, não texto.
- **Review como grade de previews**: itens de revisão (períodos de atividade, não detecções soltas) em grade de vídeos leves; **hover dá play e marca como revisto**; clique abre a gravação completa. Dois níveis de severidade (*alerts* vs *detections*) filtram o que merece atenção por default.
- **Configuração saiu do YAML e virou UI** (máscaras de movimento, grupos de câmera) — a config avançada existe, mas não polui o fluxo principal.

Fontes: [Discussão oficial do rebuild 0.14](https://github.com/blakeblackshear/frigate/discussions/11136) · [Docs — Review](https://docs.frigate.video/configuration/review/) · [frigate.video](https://frigate.video/) · [Review 2026 (cctvinfo)](https://cctvinfo.com/blog/frigate-nvr-review-2026)

**O que copiar:** design por pergunta do operador; strip de eventos recentes acima da grade; hover-play; severidade em 2 níveis com filtro por default; config avançada fora do caminho.

### 1.2 UniFi Protect (6.0) — timeline com resumo, "novidades" ao abrir

- **Timeline com resumos por objeto** ("object-counting charts"): a timeline não é uma faixa muda — mostra mini-resumos do que foi detectado por câmera, e **qualquer evento é clicável para playback instantâneo**.
- **"Find Anything"**: todos os filtros e ferramentas de busca **num único painel**, em vez de espalhados.
- **"Spotlights"**: ao abrir o app, ele **mostra o que há de novo** sem exigir varredura manual da timeline (empty-state produtivo).
- Produto explicitamente **liderado por product design** (UX Lead dedicado desde o início) — é citado em reviews como "uma das soluções mais rápidas e bem desenhadas" do segmento.

Fontes: [Introducing Protect 6.0 (blog oficial)](https://blog.ui.com/article/introducing-protect-6-0) · [Shane Miller — UX Lead UniFi Protect](https://www.shanecmiller.com/unifi-protect) · [Guia Live View/Playback](https://www.sistrunktech.com/blog/unifi-protect-guide) · [Review The Hook Up](https://www.thesmarthomehookup.com/unifi-protect-got-amazing/)

**O que copiar:** eventos clicáveis na timeline para pular direto; busca/filtros consolidados num painel só; tela inicial que responde "o que há de novo" sozinha.

### 1.3 Verkada Command — vídeo máximo, controles na borda, grids por usuário

- **Redesign da página da câmera**: controles do player movidos **para a lateral direita do vídeo**, "para dar uma visão maior e mais limpa do feed" — o vídeo é o protagonista, os controles são moldura. Ícones redesenhados com "visual mais limpo" para simplificar navegação.
- **Grids**: até 12 câmeras/página, criados **por usuário** e compartilháveis; seletor de layout + rotação automática.
- **Navegação em dois níveis**: product switcher no topo-esquerda + sidebar com as páginas essenciais do produto ativo (Grids, Archives, Analytics, Settings) — nunca tudo ao mesmo tempo.
- **Alert Management centralizado**: quem recebe o quê, sobre quais câmeras/horários, num lugar só — não espalhado por tela.

Fontes: [Command UI Enhancements & Public Grids (blog oficial)](https://www.verkada.com/blog/command-ui-enhancements-public-grids/) · [Nova navegação do Command](https://www.verkada.com/blog/introducing-a-intuitive-new-navigation-experience-in-command/) · [Camera Grids (help)](https://help.verkada.com/verkada-cameras/video-streaming-and-sharing/live-streaming/grids) · [Alert Management](https://www.verkada.com/blog/alert-management-for-cameras-command/)

**O que copiar:** player com controles empilhados na borda (vídeo ocupa o máximo); navegação lateral curta por contexto; configuração de notificação centralizada.

### 1.4 Milestone XProtect Smart Client — tabs por tarefa, timeline de 2 trilhas

Referência do mercado enterprise (operador profissional, telas densas):

- **Tabs por tarefa** no topo-esquerda: Views, Exports, Search, Alarm Manager, System Monitor — o operador troca de *tarefa*, não de menu. Global toolbar mínima no topo-direita (perfil, settings, evidence lock).
- **Timeline principal fixa embaixo** com apenas **duas trilhas**: a de cima = gravações da câmera selecionada; a de baixo = todas as câmeras da view. O usuário escolhe o que aparece nas trilhas (bookmarks, áudio) — densidade é opt-in.
- **Views** como unidade de trabalho: layouts escolhidos por aspect ratio, salvos e nomeados; painéis laterais de setup **colapsáveis** (só aparecem em modo de edição).

Fontes: [UI overview (docs oficiais)](https://doc.milestonesys.com/latest/en-us/standard_features/sf_sc/sf_funda/sc_uioverview.htm) · [The main timeline](https://doc.milestonesys.com/latest/en-US/standard_features/sf_sc/sf_funda/scfunda_ui_timelinemain.htm) · [Managing views](https://doc.milestonesys.com/2024R1/en-US/standard_features/sf_sc/sf_viewing/current/sc_workingwithviews.htm)

**O que copiar:** separação clara "modo operar" vs "modo configurar" (setup colapsado); timeline com ≤2 trilhas; tabs nomeadas por tarefa em 1 palavra.

### 1.5 Genetec (Web App / Security Center SaaS) — o tile revela no hover

- **Tiles de monitoramento**: o tile mostra só o essencial (vídeo + identidade + estado). **Hover exibe o estado completo e os controles da câmera; right-click abre controles da entidade.** Nada disso ocupa espaço permanente.
- **Task-based design**: cada tarefa (Tiles, Monitoring, Maps) é um espaço próprio; padrões de tile **persistem entre sessões**.

Fontes: [Monitoring entities in tiles (docs oficiais)](https://sc-webapp-help.genetec.com/en/EN/GWA/MonitoringEntitiesInTiles.html) · [Tiles task overview](https://sc-webapp-help.genetec.com/en/EN/GWA/R_GWA_TilesProcessOverview.html) · [Tiles (techdocs)](https://techdocs.genetec.com/r/en-US/GenetecTM-Web-App-User-Guide/Tiles)

**O que copiar:** controles do tile só no hover; estado detalhado sob demanda; persistência do layout escolhido.

### 1.6 Rhombus — menos cliques na config, dashboard "limpável"

- Console em **4 seções semânticas**: Dashboard (visão geral: câmeras, sensores, alertas, saúde), Devices, Locations, Investigations.
- Melhoria de 2026 reveladora do padrão: alternar entre configurações de "Camera" e "Image" **dentro do mesmo side panel**, sem sair e voltar — "menos cliques, fluxo mais suave".
- **"Ignore health status"**: o usuário pode silenciar um aviso de saúde de dispositivo **sem removê-lo** — "mantém o dashboard limpo sem perder visibilidade" (anormalidade reconhecida vira neutra: exatamente "going gray").

Fontes: [Everything Rhombus Shipped in 2026 (blog oficial)](https://www.rhombus.com/blog/everything-rhombus-has-shipped-in-2026-so-far/) · [App Walkthrough](https://support.rhombussystems.com/hc/en-us/articles/360037131732-Rhombus-App-Walkthrough) · [Reviews G2](https://www.g2.com/products/rhombus-systems/reviews)

**O que copiar:** side panel de config que troca de seção sem navegar; mecanismo de "reconhecer" anormalidade para devolvê-la ao cinza.

---

## 2. Dashboards técnicos — Grafana e Datadog

### 2.1 Grafana — "dashboards devem reduzir carga cognitiva, não aumentá-la"

Regras documentadas oficialmente:

- **Hierarquia por tamanho e posição**: métrica-chave em stat panel grande, dados de suporte em painéis menores; conteúdo crítico no **topo-esquerda** (usuários escaneiam em "Z").
- **Progressão lógica**: "do grande para o pequeno, do geral para o específico"; drill-down hierárquico em vez de uma tela com tudo.
- **Cor semântica com thresholds** ("azul = bom, vermelho = ruim"), eixos normalizados (%, não valores crus) para reduzir esforço mental.
- **Anti-padrões nomeados**: sprawl de dashboards, gráficos empilhados que escondem dados, excesso de painéis ("se está difícil focar, tem métrica demais na tela").
- Espaçamento consistente entre painéis/linhas para leitura limpa.

Fontes: [Best practices (docs oficiais)](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/) · [Getting started — best practices (blog oficial)](https://grafana.com/blog/getting-started-with-grafana-best-practices-to-design-your-first-dashboard/) · [7 Best Practices (MetricFire)](https://www.metricfire.com/blog/7-best-practices-for-grafana-dashboard-design/)

### 2.2 Datadog — agrupamento obrigatório, cor com significado automático

- **Grid de 12 colunas** com tamanhos mínimos por tipo de widget (timeseries ≥ 4 colunas; streams de texto ≥ 6) — largura mínima é regra, não gosto.
- **"Sempre agrupe widgets relacionados, mesmo sem header"** — grupos com headers color-coded; a cor do header ecoa nas notas do grupo (coerência cromática por seção).
- **Paleta semântica**: quando a tag é compatível (ex.: status), a cor é mapeada automaticamente ao significado — erro = vermelho, sucesso = verde. Cor nunca é decoração.
- **Modos de cor acessíveis** para daltonismo, disponíveis globalmente.
- A ajuda mora na **descrição do dashboard** (Markdown, colapsável), não em textos espalhados entre os gráficos.

Fontes: [Widget colors (docs oficiais)](https://docs.datadoghq.com/dashboards/guide/widget_colors/) · [Dashboard guidelines (integrations-core)](https://datadoghq.dev/integrations-core/guidelines/dashboards/) · [effective-dashboards/guidelines.md (GitHub oficial)](https://github.com/DataDog/effective-dashboards/blob/main/guidelines.md) · [Consistent/semantic palette](https://docs.datadoghq.com/dashboards/guide/consistent_color_palette/)

---

## 3. Padrões concretos (o "como")

### 3.1 Ícone + label vs ícone-só vs texto

- **Todo ícone precisa de label visível** — pesquisa NN/g: fora meia dúzia de ícones universais (lupa, casa, engrenagem, play), usuários não adivinham significado. Label visível o tempo todo para navegação e ações primárias.
- **Tooltip NÃO substitui label**: aumenta custo de interação, não funciona em touch. Tooltip é para **informação extra**, não para o nome da ação.
- Onde ícone-só é aceitável: ações **secundárias** em toolbar, com ícone padrão do domínio + tooltip. Critérios de qualidade de um ícone (NN/g): encontrabilidade, reconhecimento, "information scent", estética — nessa ordem.

Fontes: [Icon Usability (NN/g)](https://www.nngroup.com/articles/icon-usability/) · [Yes, Icons Need Text Labels (NN/g)](https://www.nngroup.com/videos/icon-text-labels/) · [Bad Icons (NN/g)](https://www.nngroup.com/articles/bad-icons/) · [Usability Testing of Icons (NN/g)](https://www.nngroup.com/articles/icon-testing/)

### 3.2 Toolbar com overflow menu

- Toolbar mostra as **2–4 ações primárias**; o resto vai para um **overflow "⋯"**. Usar quando o espaço horizontal não comporta tudo — nunca espremer 8 botões.
- Em telas menores, ações migram do toolbar para o overflow automaticamente.

Fonte: [Overflow menu — design guidelines (PatternFly)](https://www.patternfly.org/components/overflow-menu/design-guidelines/)

### 3.3 Tipografia para UI densa

- **Base 14px / line-height 20px (~1.43)** é o consenso para apps data-dense (vs 16px/1.5 de texto editorial). Dados secundários podem descer a 12px; **abaixo de 12px só com fonte testada** (depende do x-height) — 10px é quase sempre ilegível.
- Escala tipográfica **pequena** (Major Second, ratio 1.125) a partir de 14px: em UI densa, hierarquia vem mais de **peso e cor** do que de tamanho.
- Headings com line-height 120–130%; fontes com x-height alto empacotam mais informação legível por linha vertical.

Fontes: [Minimum font-size para app data-dense (Stéphanie Walter)](https://stephaniewalter.design/blog/what-minimum-font-size-for-a-high-density-data-web-app-do-you-suggest/) · [UI Font Size Guidelines (b13)](https://b13.com/blog/designing-with-type-a-guide-to-ui-font-size-guidelines) · [Typography (USWDS)](https://designsystem.digital.gov/components/typography/) · [Designing for Data Density (Paul Wallas)](https://paulwallas.medium.com/designing-for-data-density-what-most-ui-tutorials-wont-teach-you-091b3e9b51f4)

### 3.4 Onde mora a ajuda (redução de texto explicativo)

Hierarquia da ajuda, do mais barato ao mais caro para o usuário:

1. **Label curto e específico** no próprio controle (1–3 palavras).
2. **Placeholder/exemplo** dentro do campo (formato esperado).
3. **Tooltip / ícone "?"** para detalhe opcional — nunca para informação crítica.
4. **Descrição colapsável** no topo do painel (padrão Datadog) para contexto da tela inteira.
5. **Documentação** linkada para o raro/complexo.

Parágrafo explicativo permanente no meio da UI = falha das camadas 1–4.

Fontes: [Icon Usability (NN/g)](https://www.nngroup.com/articles/icon-usability/) · [Dashboard guidelines (Datadog)](https://datadoghq.dev/integrations-core/guidelines/dashboards/) · [Progressive Disclosure (NN/g)](https://www.nngroup.com/articles/progressive-disclosure/)

### 3.5 Status por cor + forma (acessibilidade)

- **WCAG 1.4.1 (nível A)**: cor não pode ser o único meio de transmitir informação.
- Padrão Carbon (IBM): status usa **pelo menos 2 de {cor, forma, ícone/texto}**. Convenção de formas: **círculo = normal, quadrado/losango = atenção, triângulo = crítico** — distinguível mesmo em escala de cinza.
- Leitores de tela não anunciam cor: todo status visual precisa de texto acessível equivalente.
- Isso **reforça** o "going gray" da casa: a forma carrega o significado; a cor saturada entra só na anormalidade.

Fontes: [Status indicator pattern (Carbon)](https://carbondesignsystem.com/patterns/status-indicator-pattern/) · [WCAG 1.4.1 — Use of Color](https://wcag.dock.codes/documentation/wcag141/) · [WebAIM — Contrast and Color](https://webaim.org/articles/contrast/) · [Status indicators beyond color (accessibility.chat)](https://www.accessibility.chat/articles/when-color-coding-fails-why-status-indicators-need-more-than-pretty-colors)

### 3.6 Agrupamento e alinhamento (grid 8pt)

- **Espaçamentos em múltiplos de 8** (4 para interno apertado): resoluções comuns são divisíveis por 8; a lista curta de valores elimina desalinhamento por decisão ad hoc.
- Regra **"interno ≤ externo"**: padding dentro de um grupo nunca maior que a distância entre grupos — é a Lei da Proximidade aplicada; se violada, o olho agrupa errado.
- Material, Carbon e USWDS são todos construídos sobre 8px.

Fontes: [Spacing best practices (Cieden)](https://cieden.com/book/sub-atomic/spacing/spacing-best-practices) · [The 8pt Grid System (Rejuvenate)](https://www.rejuvenate.digital/news/designing-rhythm-power-8pt-grid-ui-design) · [8px Grid Explained (The Hangline)](https://www.thehangline.com/8px-grid-spacing-system-explained-for-web-designers/)

### 3.7 Empty states

- Nunca deixar tela totalmente vazia (usuário não sabe se carregou, falhou ou não há dados). Fórmula NN/g: **informar** (o que essa tela mostra) + **status** (por que está vazia) + **ativar** (link direto para a ação que popula).
- Dashboard com vários widgets vazios: **texto simples, sem repetir ilustração** em cada um (a repetição vira ruído).
- Busca sem resultado: dizer o que foi buscado e sugerir correção ("Nenhum evento para 'X'. Ajuste o período ou os filtros.").

Fontes: [Designing Empty States in Complex Applications (NN/g)](https://www.nngroup.com/articles/empty-state-interface-design/) · [Empty states (Carbon)](https://carbondesignsystem.com/patterns/empty-states-pattern/) · [Empty states (Cloudscape/AWS)](https://cloudscape.design/patterns/general/empty-states/)

---

## 4. Princípios de simplificação (com fonte)

1. **Progressive disclosure — mostre o frequente, esconda o raro (máx. 2 níveis).** Diferir features avançadas para uma camada secundária torna o app mais fácil de aprender e menos sujeito a erro; estudos mostram 30–50% de ganho nas tarefas iniciais. Acima de 2 níveis de disclosure, usuários se perdem — aí o problema é excesso de feature, não de disclosure. — [NN/g — Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) · [IxDF](https://ixdf.org/literature/topics/progressive-disclosure)

2. **Lei de Hick — cada opção visível a mais atrasa toda decisão.** O tempo de decisão cresce com o número de alternativas; toolbar/menus devem expor poucas ações primárias e agrupar o resto. — [Dovetail — Hick's Law](https://dovetail.com/ux/hicks-law/) · [UX Design Institute — Laws of UX](https://www.uxdesigninstitute.com/blog/laws-of-ux/)

3. **Lei de Miller — chunking: 7±2 itens por grupo.** Não é "corte features", é "agrupe": seções nomeadas de até ~5–9 itens em vez de listas planas de 20. É a regra "sempre agrupe widgets" da Datadog. — [UX Design Institute](https://www.uxdesigninstitute.com/blog/laws-of-ux/) · [Datadog guidelines](https://datadoghq.dev/integrations-core/guidelines/dashboards/)

4. **Lei da Proximidade (Gestalt) — espaço em branco é o agrupador mais barato.** O que está perto é lido como grupo; alinhar num grid 8pt e manter "interno ≤ externo" substitui bordas, caixas e títulos redundantes. — [UX Design Institute](https://www.uxdesigninstitute.com/blog/laws-of-ux/) · [Cieden — spacing](https://cieden.com/book/sub-atomic/spacing/spacing-best-practices)

5. **Hierarquia visual por tamanho/posição/cor — "reduzir carga cognitiva, não adicionar".** O importante é grande e está no topo-esquerda (leitura em Z); cor saturada reservada para significado (anormalidade) — o resto fica neutro. Converge exatamente com o "going gray" da casa. — [Grafana best practices](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/best-practices/) · [Datadog semantic palette](https://docs.datadoghq.com/dashboards/guide/consistent_color_palette/)

---

## 5. Tradução para o nosso caso

Mapeamento padrão → superfície do app (componentes reais em `src/`).

### 5.1 Grade de câmeras (`DashboardPage`, `CameraTile`, `AlarmDrawer`, `TrackOverlay`)

| Padrão de mercado | Aplicação aqui |
| --- | --- |
| Tile mínimo por default; controles no hover (Genetec) | `CameraTile` mostra só vídeo + nome + status (cor+forma). Botões/ações aparecem no hover; nada de texto permanente sobre o vídeo. |
| Strip de alertas recentes acima da grade (Frigate) | Faixa fina de thumbnails/badges dos últimos eventos de alarme no topo do `DashboardPage`, clicáveis → câmera/evento. Substitui listas textuais. |
| Status cor+forma+texto acessível (Carbon/WCAG 1.4.1) | Dot de status no tile: círculo cinza = ok, triângulo âmbar/vermelho = anormal (offline, alarme), com `aria-label`. Tokens `--state-*` já existem — adicionar a dimensão *forma*. |
| Alarme reconhecível volta ao cinza (Rhombus) | `AlarmDrawer`: badge numérico saturado só com alarme ativo; ao reconhecer, volta ao neutro sem sumir. |
| Empty state produtivo (NN/g) | Sem câmeras: 1 linha ("Nenhuma câmera conectada") + botão direto "Adicionar câmera" — não parágrafo explicativo. |

### 5.2 Câmera aberta (`CameraWorkspace`, `CameraPage`, tabs `TimelineTab`/`PresencaTab`/`ZonasTab`/`LinhasTab`/`CamadasTab`)

| Padrão de mercado | Aplicação aqui |
| --- | --- |
| Vídeo máximo, controles na borda (Verkada) | Player ocupa a área toda; controles empilhados numa coluna estreita à direita (ícones padrão + tooltip). Sem painéis permanentes sobre o vídeo. |
| Tabs por tarefa, 1 palavra (Milestone) | Manter as tabs, nomes curtos: Timeline · Presença · Zonas · Linhas · Camadas. Ícone + label visível (NN/g: label não é opcional em navegação). |
| Modo operar vs modo configurar (Milestone) | Edição de zonas/linhas entra num "modo de edição" explícito (setup colapsado por default); assistir é o estado normal. |
| Timeline ≤2 trilhas, eventos clicáveis (Milestone, UniFi) | `TimelineTab`: uma trilha da câmera com marcadores de evento clicáveis → pulo direto. Filtros avançados atrás de um botão de filtro, não expostos. |
| Toolbar com overflow (PatternFly) | Ações raras (download do cine-loop, snapshot, etc.) no menu "⋯"; só 2–4 ações primárias visíveis. |
| Progressive disclosure ≤2 níveis (NN/g) | Config de zona/linha (`ConfigZonaDialog`): primeiro desenha e nomeia; parâmetros finos (histerese, limiares) numa seção "Avançado" colapsada. |

### 5.3 Relatório (`ReportPage`, `KpiRow`, panels `Resumo`/`Atividade`/`Alarmes`/`Fadiga`/`Leitura`/`Objetos`, `Heatmap`, `TrendChart`, `EventsTable`, `EmptyHistory`)

| Padrão de mercado | Aplicação aqui |
| --- | --- |
| Z-pattern: KPI grande topo-esquerda, suporte menor (Grafana) | `KpiRow` com 3–5 stats grandes no topo; gráficos de suporte menores abaixo. Um destaque por tela. |
| Agrupar sempre, com headers (Datadog; Miller) | Cada panel é um grupo nomeado com ≤7 elementos; sem widgets soltos. Headers curtos (1–2 palavras), sem subtítulos explicativos. |
| Cor neutra por default, semântica nos estados (Datadog; going gray) | `TrendChart`/`Heatmap`/`RankingBars` em neutros; vermelho/âmbar apenas para série de anormalidade (alarmes, fadiga). |
| Ajuda na descrição, não no corpo (Datadog) | Texto explicativo dos painéis migra para tooltip "?" no header do panel ou descrição colapsável única no topo do `ReportPage`. |
| Empty state por widget: só texto (NN/g) | `EmptyHistory` e panels vazios: 1 linha de status + causa provável + ação ("Sem eventos no período — ajuste o intervalo"). Sem ilustração repetida por painel. |
| Eixos normalizados (Grafana) | Percentuais e taxas em vez de contagens cruas onde a comparação importa. |

### 5.4 Configurações (`CamerasPage`, `UsersPage`, tabs `UsersTab`/`NotificacoesTab`/`CamerasTab`, `IpCamerasSection`, `LocalNodeSection`, `AlarmHealthPage`, `ProfilePage`)

| Padrão de mercado | Aplicação aqui |
| --- | --- |
| Side panel que troca seção sem navegar (Rhombus) | Config de uma câmera: painel lateral único com seções alternáveis (Stream · Análise · Alarmes) em vez de idas e voltas entre páginas/dialogs. |
| Defaults na frente, avançado colapsado (NN/g) | `IpCamerasSection`/`LocalNodeSection`: campos essenciais (nome, URL) visíveis; parâmetros de ffmpeg/análise em "Avançado". Máximo 2 níveis. |
| Notificações centralizadas (Verkada) | `NotificacoesTab` já centraliza — reforçar o modelo "quem recebe · o quê · quando" em 3 colunas, sem texto corrido. |
| Ajuda em camadas (§3.4) | Placeholder com exemplo de formato (ex.: `rtsp://…`) no campo; tooltip "?" para o raro; zero parágrafos entre campos. |
| Grid 8pt, interno ≤ externo (Cieden) | Auditar formulários: labels em cima, espaçamentos em múltiplos de 8 via tokens `--sp-*`, grupos separados por espaço (não por bordas). |
| Ícones com label (NN/g) | Em config, ações sempre icon+label ("Remover", "Testar conexão") — nunca ícone-só: frequência de uso baixa = reconhecimento baixo. |

---

## 6. Síntese — o que o cliente final espera ver

1. **A tela inicial responde "o que há de novo?" sozinha** (Frigate filmstrip, UniFi Spotlights) — sem varrer listas.
2. **Vídeo é protagonista**; controles são moldura fina que aparece quando precisa (Verkada, Genetec).
3. **Cor é linguagem, não decoração**: neutro = normal; saturado + forma = anormal (Datadog, Carbon, WCAG) — nossa doutrina "going gray" está alinhada com o estado da arte; falta executá-la com a dimensão de *forma* e disciplina nos tokens.
4. **Texto mínimo**: label curto + tooltip para o resto; explicação longa não mora na UI (NN/g, Datadog).
5. **Complexidade existe, mas em camadas**: operar na frente, configurar atrás, avançado colapsado — nunca mais de 2 níveis (NN/g).
