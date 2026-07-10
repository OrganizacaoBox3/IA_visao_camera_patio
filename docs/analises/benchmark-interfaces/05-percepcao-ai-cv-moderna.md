# Benchmark de Interfaces — Visualização de Percepção em IA/CV Moderna

> Domínio: veículos autônomos, robótica e analytics de vídeo por IA.
> Objetivo: extrair padrões de UI para melhorar a interface do nosso sistema de monitoramento de visão computacional no navegador para um Centro de Distribuição (CD) — overlays de detecção em tempo real, rastreio/contagem, heatmaps e relatórios/insights.
> Data da pesquisa: 2026-06-28. Pesquisa via web; trechos não verificados visualmente (sem acesso aos produtos ao vivo) estão marcados com **[não verificado]**.

---

## 1. Panorama

A "visualização de percepção" — mostrar ao usuário o que a IA está enxergando — virou um campo maduro com padrões repetidos entre três ecossistemas:

1. **Veículos autônomos (Tesla, Waymo, Mobileye)** — priorizam a *representação 3D do mundo* (BEV / bird's-eye view, modelos 3D de objetos, occupancy grids/voxels). A bounding box "crua" sobre a câmera é tratada como dado intermediário; o produto final mostra um mundo reconstruído e estilizado para comunicar *compreensão*, não apenas detecção. A Tesla escala os modelos 3D de veículos para refletir o tamanho real calculado e divide o espaço em voxels de ocupação. ([notateslaapp](https://www.notateslaapp.com/tesla-reference/636/all-tesla-fsd-visualizations-and-what-they-mean), [evsmarts](https://evsmarts.com/tesla-places-unreal-engine-to-enhance-fsd-visualizations/))

2. **Ferramentas de robótica/dev (Foxglove, RViz, Roboflow Supervision)** — focam em *debug da stack de percepção*: overlay de boxes/máscaras/IDs sobre vídeo cru, sincronizado com painéis de plot, timeline e mensagens. O grande padrão aqui é **camadas plugáveis por tópico/anotação, com toggles individuais** e calibração para projetar marcadores 3D no plano 2D. ([Foxglove product](https://foxglove.dev/product), [Foxglove image panel](https://foxglove.dev/blog/introducing-foxglove-studios-new-image-panel))

3. **Analytics de vídeo / people-retail counting (NVIDIA Metropolis, Viso.ai, Vivacity, Spot AI)** — é o mais próximo do nosso CD. Foco em *contagem ao longo do tempo, zonas, tripwires (linhas de contagem), heatmaps de ocupação e ligação vídeo↔dashboard*. NVIDIA Metropolis tem inclusive uma UI de referência em React com floor-map, vídeo, heatmap, histograma e pathing. ([NVIDIA MMS UI](https://docs.nvidia.com/mms/text/MDX_Multi_Camera_Tracking_UI.html), [Viso heatmaps](https://viso.ai/applications/movement-heat-maps/), [Vivacity](https://vivacitylabs.com/products/smart-traffic-monitoring-solution/))

**Tendência transversal:** a interface "moderna/tech" não é a que mostra mais boxes — é a que (a) deixa o usuário **controlar o que vê** (camadas, filtros, limiar de confiança), (b) **conecta o pixel ao número** (clicar num evento e ir ao frame; clicar numa tendência e ver o vídeo), e (c) comunica **incerteza** de forma honesta (confiança visível, filtragem por threshold).

---

## 2. Catálogo de padrões de UI/feature

### 2.1 Estética e clareza de overlays

| Padrão | Descrição concreta | Fonte |
|---|---|---|
| **Cor por classe consistente + legenda compartilhada** | Cada classe (pessoa, empilhadeira, caixa...) tem uma cor fixa usada na box, no label, no heatmap e na legenda. Cor consistente entre elementos permite usar **uma única legenda** para tudo e remover legendas redundantes. Regra de acessibilidade: nunca usar só cor — sempre parear com ícone/texto (8% dos homens têm deficiência de visão de cores; vermelho/verde no mesmo brilho confunde). | [Shopify dataviz](https://medium.com/shopify-ux/flexible-colors-and-themes-for-data-visualizations-e4e24c761895), [Berkeley dataviz](https://guides.lib.berkeley.edu/data-visualization/design) |
| **Variações de estilo de box** | A lib Supervision (Roboflow) expõe múltiplos estilos: box cheia, **cantos apenas** (`BoxCornerAnnotator` — menos oclusão sobre vídeo), box arredondada, box orientada (rotacionada), elipse (bom para pés de pessoas), e halo/glow. Escolher estilo conforme densidade da cena. | [Supervision annotators](https://supervision.roboflow.com/annotators/) |
| **Confiança como elemento visual, não só texto** | Além do texto "classe 0.87", há `PercentageBarAnnotator` que desenha a confiança como uma **barra** dentro/junto da box. Roboflow Label Visualization tem opção "Class and Confidence" e permite configurar espessura da box e como as cores são atribuídas. | [Supervision](https://supervision.roboflow.com/annotators/), [Roboflow label viz](https://docs.roboflow.com/workflow-blocks/visualize-predictions/bounding-box-visualization) |
| **Legibilidade sobre vídeo (dark theme)** | Evitar preto puro (#000) com branco puro (#fff) — causa "halation". Usar texto #E0E0E0/#CCCCCC e leve aumento de peso da fonte. Labels com fundo semi-transparente (pill) atrás do texto melhoram leitura sobre frames variáveis. | [Dark mode dataviz](https://ananyadeka.medium.com/implementing-dark-mode-for-data-visualizations-design-considerations-66cd1ff2ab67) |
| **Mundo reconstruído vs. box crua (AV)** | Tesla/Waymo renderizam um *mundo 3D estilizado* (modelos 3D dimensionados ao tamanho real, voxels de ocupação, BEV) em vez de boxes cruas — comunica "eu entendi o objeto" e não só "achei um retângulo". **[parcialmente não verificado — UI interna proprietária]** | [Tesla viz](https://www.notateslaapp.com/tesla-reference/636/all-tesla-fsd-visualizations-and-what-they-mean), [BEVFusion](https://arxiv.org/html/2205.13542v3) |

### 2.2 Rastreamento e trajetórias

| Padrão | Descrição concreta | Fonte |
|---|---|---|
| **ID persistente + cor por track** | Cada objeto rastreado recebe um ID consistente entre frames e uma cor própria de box; trackers como ByteTrack mantêm identidade estável mesmo sob oclusão parcial, sem "ID switch". O ID é renderizado no label junto da classe. | [LearnOpenCV trackers](https://learnopencv.com/multi-object-tracking-with-roboflow-trackers-and-opencv/), [Ultralytics track](https://docs.ultralytics.com/modes/track) |
| **Trilhas / trajetórias (trace)** | `TraceAnnotator` desenha o caminho histórico do objeto com profundidade configurável (`trail_depth`, em nº de frames; 0 desliga). Ponto-âncora configurável (centro vs. base da box). Comunica direção e padrão de movimento. | [Supervision track](https://supervision.roboflow.com/0.25.0/how_to/track_objects/), [DeGirum tracker](https://docs.degirum.com/degirum-tools/analyzers/object_tracker) |
| **Linhas de contagem / tripwire** | NVIDIA Metropolis: módulo Tripwire detecta cruzamento por segmentos de linha definidos pelo usuário, **desenhados por toque (linhas verdes)** com vetor de direção (seta vermelha) distinguindo entrada/saída. Vivacity: "countlines" virtuais (amarelas) múltiplas posicionadas no campo de visão, contagem por classe (carro/bici/pedestre/e-scooter). | [NVIDIA MMS](https://docs.nvidia.com/mms/text/MDX_Introduction.html), [Vivacity](https://vivacitylabs.com/products/smart-traffic-monitoring-solution/) |
| **Zonas / ROI com ocupação e dwell time** | Detectar eventos em regiões de interesse definidas pelo usuário; calcular ocupação e tempo médio de permanência (dwell) por zona; comparar métricas entre locais. | [NVIDIA occupancy](https://docs.nvidia.com/mms/text/Occupancy_Heatmap_toc.html), [Viso people counting](https://viso.ai/applications/people-counting/) |
| **Heatmap de ocupação** | Acumula posições de detecção ao longo do tempo em mapa de calor (`HeatMapAnnotator`); NVIDIA colore em vermelho regiões com movimentação significativa. Pode ser sobre o frame (perspectiva) ou sobre floor-map (top-down). | [Supervision](https://supervision.roboflow.com/annotators/), [NVIDIA occupancy](https://docs.nvidia.com/mms/text/MDX_People_Heatmap_App.html) |
| **Trajetória no floor-map (top-down)** | UI de Multi-Camera Tracking da NVIDIA: caminhos coloridos sobre planta baixa, com **círculo preenchido sólido no início e círculo branco maior no fim**, mais seta de direção — leitura instantânea de origem→destino. | [NVIDIA MMS UI](https://docs.nvidia.com/mms/text/MDX_Multi_Camera_Tracking_UI.html) |

### 2.3 Comunicar incerteza / confiança ao usuário

| Padrão | Descrição concreta | Fonte |
|---|---|---|
| **Slider de limiar de confiança** | Elemento de UI deslizante que filtra detecções por score em tempo real. Guia de referência: >0.50 = mais detecções + mais falsos positivos; >0.70 = equilíbrio; >0.90 = só as mais confiáveis (risco de perder válidas). Deixar o operador ajustar conforme a tolerância da operação. | [Leverege](https://www.leverege.com/blogpost/computer-vision-basics-how-confidence-accuracy-and-thresholds-impact-performance), [Voxel51](https://medium.com/voxel51/finding-the-optimal-confidence-threshold-cd524f1afe92) |
| **Amostragem por baixa confiança** | Aba/visão que destaca os itens com menor score médio — leva o usuário direto ao que "desafia o modelo", útil para revisar erros e melhorar dados. | [Datature](https://datature.io/blog/introducing-class-metrics-and-low-confidence-sampling-for-deeper-model-evaluation-insights) |
| **Filtro de outlier / OOD** | ScatterUQ: slider de "Outlier Tolerance" reclassifica amostras out-of-distribution como "OTHER" — comunicar quando a IA está vendo algo fora do que conhece (ex.: objeto não treinado no CD). **[pesquisa acadêmica, não produto]** | [ScatterUQ](https://arxiv.org/pdf/2308.04588) |
| **Histograma de confiança** | Mostrar distribuição dos scores de todas as boxes do frame/período — dá noção agregada de quão "certa" a IA está e onde está o threshold em relação à massa de detecções. | [Roboflow+Streamlit](https://blog.roboflow.com/how-to-use-roboflow-and-streamlit-to-visualize-object-detection-output/) |

### 2.4 Time-series, analytics e ligação vídeo↔relatório

| Padrão | Descrição concreta | Fonte |
|---|---|---|
| **Event cards com thumbnail + box** | NVIDIA: lista rolável de cards de evento, cada um com thumbnail recortado com a box do objeto, texto do evento, ID colorido e **score de match**; filtráveis por duração e local; clicáveis para navegar entre evento global e sub-eventos por sensor. | [NVIDIA MMS UI](https://docs.nvidia.com/mms/text/MDX_Multi_Camera_Tracking_UI.html) |
| **Timeline scrubbing + zoom** | Arrastar a timeline para visão geral e achar ocorrências; zoom in/out na linha do tempo; controles de play/pause/seek/replay nos players. | [Axis Camera Station](https://help.axis.com/en-us/axis-camera-station-pro), [NVIDIA MMS UI](https://docs.nvidia.com/mms/text/MDX_Multi_Camera_Tracking_UI.html) |
| **Smart search por metadados** | Indexar tudo por objeto/atributo/local/tempo e **buscar** ("empilhadeira na doca 3 entre 14h-15h") em vez de scrubbing manual — busca em metadados, não no vídeo. | [Spot AI](https://www.spot.ai/blog/best-ai-video-analytics-companies), [Irisity](https://irisity.com/ai-video-analytics/intelligent-video-analytics-guide/) |
| **Smart chapters / clipes de evidência** | Capítulos automáticos levam direto à parte relevante mantendo contexto; agente flag momentos de interesse e empacota clipe compartilhável como evidência. | [Spot AI](https://www.spot.ai/blog/best-ai-video-analytics-companies), [Datadog](https://www.datadoghq.com/blog/ai-summaries-and-smart-chapters/) |
| **Dashboard "bird's-eye" com alertas** | Visão de status da instalação com KPIs e alertas para gargalos/perigos; comparação de métricas (picos, horários, locais). Metropolis usa Kibana integrado para monitorar/visualizar. | [Wavestore](https://www.wavestore.com/post/ai-powered-video-analytics-the-complete-roi-guide-for-business-leaders), [NVIDIA MMS](https://docs.nvidia.com/mms/text/MDX_Introduction.html) |

### 2.5 Controles modernos (camadas, filtros, live x replay)

| Padrão | Descrição concreta | Fonte |
|---|---|---|
| **Camadas plugáveis por tópico, com toggle individual** | Foxglove Image panel: usuário escolhe quais anotações 2D (texto/círculos/pontos) e quais marcadores 3D superpor; seção "Topics" e "Image annotations" com checkboxes; estado salvo em *layouts* compartilháveis pela equipe. | [Foxglove image panel](https://foxglove.dev/blog/introducing-foxglove-studios-new-image-panel), [Foxglove docs 3D](https://docs.foxglove.dev/docs/visualization/panels/3d) |
| **Toggles de camadas de overlay** | Mostrar/ocultar boxes, máscaras, heatmap, trilhas, zonas, tripwires independentemente — cada camada é um annotator separável (box/mask/trace/heatmap/label) que pode ser ligado/desligado. | [Supervision annotators](https://supervision.roboflow.com/annotators/) |
| **Calibração para projetar 3D→2D** | Tópico de calibração define o campo de visão da câmera, permitindo projetar marcadores 3D (ex.: zonas, grid do chão) sobre a imagem 2D. Relevante para desenhar zonas do CD no plano da câmera. | [Foxglove image panel](https://foxglove.dev/blog/introducing-foxglove-studios-new-image-panel) |
| **Live ↔ replay sincronizado** | Dashboard acessa dados live e históricos no mesmo lugar; cloud, login de qualquer lugar; players com replay. Permite alternar "ao vivo" e "revisão de evento" sem trocar de ferramenta. | [Vivacity dashboard](https://dashboard.vivacitylabs.com/), [NVIDIA MMS UI](https://docs.nvidia.com/mms/text/MDX_Multi_Camera_Tracking_UI.html) |
| **Privacidade como camada** | Annotators de blur/pixelate aplicáveis a regiões detectadas (ex.: rostos de funcionários) — toggle de anonimização para conformidade. | [Supervision](https://supervision.roboflow.com/annotators/) |

### 2.6 Padrões visuais "tech/moderno" que transmitem maturidade

- **BEV / top-down ao lado da câmera** — par "câmera (perspectiva) + planta baixa (top-down)" dá sensação de sistema espacialmente consciente (AV e Metropolis). **[UI interna AV não verificada]**
- **Layouts salváveis/compartilháveis** — equipe configura uma vez e padroniza a visão (Foxglove).
- **Dark theme com acento por classe** — fundo escuro neutro, cores saturadas reservadas para dados/detecções, texto suave (#E0E0E0) — visual de "console operacional".
- **Cards de evento com thumbnail recortado** — em vez de só texto de log, cada evento tem a imagem do que aconteceu com a box destacada.
- **Animação de voxels/occupancy grid** — Tesla migrando renderização para Unreal Engine para suavidade; sinaliza sofisticação. **[não verificado]**

---

## 3. O que roubar para o nosso CD

Priorizado por impacto/esforço para o MVP no navegador.

### A. Overlays de detecção (alto impacto, baixo esforço)
1. **Cor por classe fixa + legenda única clicável** que serve box, label, trilha e heatmap. Legenda dupla como **filtro de classe** (clicar oculta/mostra a classe). Pareie cor + ícone + texto (acessibilidade).
2. **Label como pill semi-transparente** com `classe · ID · confiança` — fundo escuro translúcido para legibilidade sobre o vídeo do CD (iluminação variável).
3. **Estilo de box adaptável**: usar **cantos (corner box)** em cenas densas para reduzir oclusão; box cheia em cenas esparsas.
4. **Confiança visível sempre**: texto do score + opção de **mini-barra de confiança** (estilo `PercentageBarAnnotator`) na box.

### B. Camadas e toggles (alto impacto, médio esforço)
5. **Painel de camadas com toggles independentes**: Boxes / Máscaras / Trilhas / Heatmap / Zonas / Tripwires / Labels — cada um liga/desliga (modelo Foxglove + Supervision).
6. **Layouts salváveis por perfil/turno** (operador da doca vs. supervisor) — uma config compartilhável.
7. **Toggle de anonimização** (blur de rostos) como camada para conformidade.

### C. Confiança / incerteza (alto impacto, baixo esforço)
8. **Slider global de limiar de confiança** que filtra overlays e contagens em tempo real, com preset documentado (0.5 sensível / 0.7 equilíbrio / 0.9 conservador).
9. **Histograma de confiança** no painel de insights — distribuição dos scores no período, com a linha do threshold marcada.
10. **Fila de "baixa confiança / não reconhecido"** — eventos que a IA viu com pouca certeza vão para revisão (caminho para melhorar o modelo do CD).

### D. Rastreamento e contagem (núcleo do nosso valor)
11. **ID persistente + trilha configurável** (`trail_depth`) por objeto, âncora na base da box.
12. **Tripwires/countlines desenháveis pelo usuário** com **vetor de direção** entrada/saída (modelo NVIDIA: linha + seta) — contagem de fluxo nas docas/corredores.
13. **Zonas/ROI com ocupação e dwell time** por área do CD; alerta de superlotação/ocupação por zona.
14. **Heatmap de ocupação** com toggle perspectiva (sobre vídeo) e, se houver calibração, **top-down sobre planta do CD**.

### E. Ligação vídeo ↔ relatório (o maior diferencial "produto maduro")
15. **Bidirecional**: clicar num pico do gráfico de contagem → pula para o frame/clipe; clicar num evento detectado → destaca no gráfico. (é a cola que falta na maioria dos MVPs.)
16. **Event cards com thumbnail recortado + box + ID + timestamp**, filtráveis por classe/zona/tempo (modelo NVIDIA).
17. **Timeline com scrubbing + zoom + replay de evento**; live ↔ replay no mesmo player.
18. **Smart search por metadados** ("empilhadeira na zona X entre HH-HH") em vez de varrer vídeo.
19. **Clipe de evidência exportável** (smart chapter) para anexar em relatórios/ocorrências.

### F. Estética/maturidade
20. **Dark theme operacional** (fundo neutro escuro, cor reservada para dados, texto #E0E0E0).
21. **Par câmera + mini-mapa top-down** do setor do CD, se a calibração permitir projeção 3D→2D.

---

## 4. Referências

**Veículos autônomos**
- Tesla FSD visualizations — Not a Tesla App: https://www.notateslaapp.com/tesla-reference/636/all-tesla-fsd-visualizations-and-what-they-mean
- Tesla + Unreal Engine para visualizações: https://evsmarts.com/tesla-places-unreal-engine-to-enhance-fsd-visualizations/
- Waymo Open Dataset (labels 2D/3D, sensor fusion): https://waymo.com/open/about/
- BEVFusion (BEV multi-sensor): https://arxiv.org/html/2205.13542v3

**Robótica / dev tools**
- Foxglove — Product: https://foxglove.dev/product
- Foxglove — New Image Panel (anotações, toggles, calibração): https://foxglove.dev/blog/introducing-foxglove-studios-new-image-panel
- Foxglove — Text Annotations: https://foxglove.dev/blog/introducing-text-annotations-in-foxgloves-image-panel
- Foxglove — 3D panel docs: https://docs.foxglove.dev/docs/visualization/panels/3d
- Roboflow Supervision — Annotators (box/label/mask/trace/heatmap/percentage-bar/blur): https://supervision.roboflow.com/annotators/
- Roboflow Supervision — Track objects: https://supervision.roboflow.com/0.25.0/how_to/track_objects/
- Roboflow — Bounding Box / Label Visualization: https://docs.roboflow.com/workflow-blocks/visualize-predictions/bounding-box-visualization
- LearnOpenCV — Multi-Object Tracking: https://learnopencv.com/multi-object-tracking-with-roboflow-trackers-and-opencv/
- Ultralytics — Tracking: https://docs.ultralytics.com/modes/track
- DeGirum — Object Tracker (trail_depth, âncora): https://docs.degirum.com/degirum-tools/analyzers/object_tracker

**Analytics de vídeo / people-retail counting**
- NVIDIA Metropolis Microservices — Introdução (tripwire, ROI, line-crossing): https://docs.nvidia.com/mms/text/MDX_Introduction.html
- NVIDIA — Multi-Camera Tracking UI (floor-map, event cards, pathing): https://docs.nvidia.com/mms/text/MDX_Multi_Camera_Tracking_UI.html
- NVIDIA — People Heatmap App: https://docs.nvidia.com/mms/text/MDX_People_Heatmap_App.html
- NVIDIA — Occupancy Heatmap: https://docs.nvidia.com/mms/text/Occupancy_Heatmap_toc.html
- Viso.ai — Movement Heat Maps: https://viso.ai/applications/movement-heat-maps/
- Viso.ai — People Counting: https://viso.ai/applications/people-counting/
- Vivacity — Smart Traffic Monitoring (countlines, tracks, zonas): https://vivacitylabs.com/products/smart-traffic-monitoring-solution/
- Vivacity — Dashboard: https://dashboard.vivacitylabs.com/
- Spot AI — Best AI Video Analytics 2026 (smart search, evidence clips): https://www.spot.ai/blog/best-ai-video-analytics-companies
- Axis Camera Station Pro — manual (timeline/scrubbing/bookmarks): https://help.axis.com/en-us/axis-camera-station-pro
- Irisity — Intelligent Video Analytics Guide: https://irisity.com/ai-video-analytics/intelligent-video-analytics-guide/

**Confiança / incerteza**
- Leverege — Confidence, Accuracy & Thresholds: https://www.leverege.com/blogpost/computer-vision-basics-how-confidence-accuracy-and-thresholds-impact-performance
- Voxel51 — Optimal Confidence Threshold: https://medium.com/voxel51/finding-the-optimal-confidence-threshold-cd524f1afe92
- Datature — Low Confidence Sampling: https://datature.io/blog/introducing-class-metrics-and-low-confidence-sampling-for-deeper-model-evaluation-insights
- ScatterUQ — Interactive Uncertainty Visualizations: https://arxiv.org/pdf/2308.04588

**Design visual / dataviz**
- Implementing Dark Mode for Data Visualizations: https://ananyadeka.medium.com/implementing-dark-mode-for-data-visualizations-design-considerations-66cd1ff2ab67
- Shopify — Flexible colors and themes for dataviz: https://medium.com/shopify-ux/flexible-colors-and-themes-for-data-visualizations-e4e24c761895
- UC Berkeley — Data Visualization Design Considerations: https://guides.lib.berkeley.edu/data-visualization/design

---

### Notas de verificação
- Padrões de **AV (Tesla/Waymo/Mobileye/Cruise)**: descritos a partir de docs públicos, datasets e cobertura de imprensa — as **UIs internas de produção são proprietárias e não foram inspecionadas ao vivo** (marcado **[não verificado]** no texto).
- **Cruise** e **Mobileye** não retornaram fontes de UI específicas nesta rodada; padrões atribuídos a AV são generalizações do setor.
- Padrões de **Foxglove, Roboflow/Supervision e NVIDIA Metropolis** vêm de documentação oficial do produto e são os mais confiáveis/acionáveis para nós.
