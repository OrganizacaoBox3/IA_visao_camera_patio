# Benchmark de Interfaces — VMS / NVR e Plataformas de Video Analytics Empresarial

> **Objetivo:** mapear como sistemas maduros de gestão de vídeo (VMS) e video-analytics gerenciam **dezenas/centenas de câmeras com analytics em tempo real**, para inspirar a interface da nossa central de visão computacional do CD (multi-câmera, zonas/máscaras, modos, overlays, alertas Andon/WhatsApp e relatórios).
>
> **Data da pesquisa:** 2026-06-28
> **Escopo:** Milestone XProtect, Genetec Security Center, Avigilon Unity/Alta, Verkada Command, Axis Camera Station, Bosch BVMS, Hikvision HikCentral, Ava/Avigilon Alta, Ambient.ai, Spot AI.
>
> **Nota de verificação:** descrições baseadas em documentação oficial e materiais de produto. Itens marcados com ⚠️ **(não verificado visualmente)** vêm de resumos de busca/documentação textual e não de inspeção direta da tela — tratar como direcionais, não como especificação literal de pixel.

---

## 1. Panorama dos Produtos

Os produtos se dividem em dois grandes grupos com filosofias de UI distintas, ambos relevantes para nós:

### Grupo A — VMS clássico "operador no controle" (centro de operações denso)
São interfaces desktop pensadas para salas de controle com muitos monitores, operador treinado e grade densa de feeds. Forte em **layouts salvos, video wall, árvore lógica de devices e fila de alarmes**.

| Produto | Cliente / UI | Posicionamento | Força de UI mais relevante p/ nós |
|---|---|---|---|
| **Milestone XProtect** | Smart Client (desktop) + Web/Mobile; Management Client (admin) | VMS aberto, líder de mercado, ecossistema enorme de plugins | "Views" salvas ilimitadas (1–100 câmeras), Smart Wall, System Monitor com tiles de saúde |
| **Genetec Security Center** | Security Desk (operador) + Config Tool | Plataforma unificada (vídeo+acesso+ALPR+intrusão) | Monitoring task com tiles, Alarm monitoring task, dashboards por widget, mapas (Plan Manager) |
| **Bosch BVMS** | Operator Client + Configuration Client | VMS corporativo/control room | Logical Tree, Alarm List → Alarm Image window, sequences, monitor wall |
| **Axis Camera Station** | App desktop + Web client | VMS de porte médio, forte em câmeras Axis | Split views por template (drag-and-drop), multi-servidor |
| **Hikvision HikCentral Professional** | Control Client + Web | Plataforma central all-in-one, control room | Smart/Video Wall 4/9/16/25, alarm pop-up no wall, e-map interativo |

### Grupo B — Plataformas cloud/AI-native "a IA filtra o que importa"
Interfaces web modernas, foco em **reduzir carga cognitiva**: a IA destaca o que merece atenção em vez de exigir vigilância passiva de grades. Mais próximas da nossa proposta de "modos" e alertas inteligentes.

| Produto | Cliente / UI | Posicionamento | Força de UI mais relevante p/ nós |
|---|---|---|---|
| **Verkada Command** | Web/cloud | Híbrido câmera+cloud, UX consumer-grade | Grids com câmera-foco maior, rotação por página, alertas com slider de sensibilidade + estimativa de volume |
| **Avigilon Unity / Alta** | Unity Video Client (desktop) / Alta (cloud) | VMS + analytics edge potentes | **Focus of Attention** (favo de mel + cores), Appearance Search, Smart Presence em mapa |
| **Ava (Avigilon Alta Aware)** | Web/cloud | Cloud-native analytics | Health monitor, Smart Presence em planta, Rules builder, image-health (câmera movida) |
| **Ambient.ai** | Web (sobrepõe VMS existente) | "Signals Intelligence" sobre VMS de terceiros | Surface das câmeras mais ativas, alerta = clipe + contexto + planta, 150+ assinaturas de ameaça |
| **Spot AI** | Web/cloud | "Video AI Agents" sobre câmeras existentes | Dashboard de agentes, Smart Zones, busca por linguagem natural, regras→ações (alerta/workflow/scorecard) |

**Leitura estratégica para o CD:** nosso produto é mais "Grupo B" no espírito (analytics que filtra e alerta), mas precisamos das ferramentas operacionais maduras do "Grupo A" (grade multi-câmera, views salvas, fila de alarmes, saúde do sistema). O melhor desenho rouba do Grupo A a **estrutura operacional** e do Grupo B a **inteligência de atenção**.

---

## 2. Catálogo de Padrões de UI / Feature

### 2.1 Layouts de visualização (grids, views, video wall, foco+contexto, mapas)

| Padrão | Descrição concreta | Quem faz bem |
|---|---|---|
| **"Views" / layouts salvos** | Operador compõe uma view escolhendo um *layout template* (1×1, 2×2, 3×3… até grades grandes), agrupados por aspect ratio e por orientação (paisagem/retrato). Views podem ser **privadas** (só do criador) ou **compartilhadas** (toda equipe vê a mesma). Number de views é ilimitado; trocar de view é a navegação primária. Uma view pode misturar câmeras + imagens + texto (ex.: instruções/SOP). | **Milestone XProtect** (views ilimitadas 1–100 câmeras, privadas/compartilhadas, view groups) |
| **Split view por drag-and-drop com template** | Seleciona-se um template de grade e arrasta-se câmeras/áreas/zonas de áudio para as células. Suporta puxar câmeras de **múltiplos servidores** para a mesma grade. | **Axis Camera Station** (split view por template, multi-servidor) |
| **Video wall / Smart Wall** | Parede física multi-monitor. Admin define **presets** (quais câmeras + arranjo por monitor). Operador controla o que aparece; **regras** trocam presets automaticamente por evento ou agenda. Wall mostra também mapas e pop-ups de alarme. | **Milestone Smart Wall**, **Bosch BVMS monitor wall**, **HikCentral** (4/9/16/25 splits; alarme cobre a tela inteira) |
| **Carrossel / sequência / rotação de páginas** | Quando há mais câmeras que células, a grade cicla por páginas. Verkada: até **12 câmeras por página**, setas inferiores + **timer de rotação custom por página** ("dwell" maior em páginas importantes) e **título por página** descrevendo o que ela mostra. Bosch/Genetec têm "sequences" análogas. | **Verkada Command** (rotação por página, título, dwell), **Bosch** (sequences) |
| **Foco + contexto (câmera-destaque maior)** | Layouts onde uma célula é maior (câmera de alta prioridade) e as demais menores ao redor — mantém contexto sem perder o feed-chave. Verkada chama "additional grid layouts" com câmera ocupando porção maior. | **Verkada** (grid layouts com foco), **Genetec** (hotspot tile ⚠️) |
| **Hotspot tile** | Uma célula "hotspot" fixa que sempre exibe a última câmera selecionada/o último alarme — clicar em qualquer câmera/evento joga o vídeo no hotspot grande enquanto a grade continua. ⚠️ | **Genetec** ⚠️, padrão comum em VMS |
| **Mapas / plantas com câmeras (focus+context geográfico)** | Planta baixa do site com ícones de câmera, portas e alarmes; status e eventos atualizam em tempo real sobre o mapa. Clicar no ícone abre o feed. Permite navegar entre andares/áreas e supervisionar muito mais devices que numa grade. "Smart Presence": mostra **onde pessoas/veículos estão se movendo** sobre a planta. | **Genetec Plan Manager / Maps task**, **HikCentral e-map**, **Ava/Alta Smart Presence**, **Ambient.ai** (planta no alerta) |

### 2.2 Gestão de muitas câmeras (árvore, busca, status, saúde)

| Padrão | Descrição concreta | Quem faz bem |
|---|---|---|
| **Árvore lógica / agrupamento (Logical Tree / Area view)** | Painel lateral em árvore hierárquica com todos os devices que o grupo de usuário pode ver, organizável por site/área/grupo. É a fonte de drag-and-drop para montar grades e walls. | **Bosch BVMS Logical Tree**, **Genetec Area view** |
| **Status por câmera no próprio tile** | Indicadores embutidos: online/offline, erro de stream, FPS abaixo do esperado, perda de sinal. Quando FPS real < esperado, dispara troubleshooting (câmera sobrecarregada / banda). | **Milestone** (FPS/erros), **Genetec** (camera loss/storage/network alerts) |
| **Dashboard de saúde do sistema (tiles semáforo)** | Painel dedicado com **tiles coloridos**: verde = rodando, amarelo = aviso, vermelho = crítico. Tiles padrão para *todos os servidores*, *servidores de gravação* e *todas as câmeras*; pode criar tiles para câmera/grupo/servidor individual. Parâmetros: CPU, memória, FPS, gravação, disco. | **Milestone System Monitor**, **Genetec System Availability Monitor**, **Ava/Alta health monitor** |
| **Image-health por IA (câmera movida/obstruída)** | Analytics compara a vista atual com 2 imagens de referência **2× ao dia**; alerta se a câmera mudou de posição ou a cena foi adulterada. | **Ava/Avigilon Alta Aware** (image health monitoring) |
| **Surface automático das câmeras mais ativas** | Em vez de o operador escolher, o dashboard **promove automaticamente as câmeras com mais atividade** no momento, com overlays de contexto gerados por IA — vigilância "always-on" sem caçar feeds. | **Ambient.ai**, **Spot AI** (surfaces "só os momentos que importam") |

### 2.3 Overlays de analytics (boxes, classes, confiança, linhas/zonas, tripwire, heatmap, contagem)

| Padrão | Descrição concreta | Quem faz bem |
|---|---|---|
| **Bounding box + ícone de classe** | Caixa ao redor do objeto detectado **com um símbolo no topo** indicando a classe (pessoa, veículo, etc.), renderizada direto no feed do cliente. | **Avigilon Unity** (box + símbolo pessoa/carro) |
| **Metadados do objeto enviados ao VMS** | O analytics da câmera/edge envia ao VMS bounding box + atributos do objeto + timestamp; o operador vê os detalhes do objeto que disparou o alerta dentro do cliente. | Padrão Axis Object Analytics, Bosch, intuVision |
| **Linha de cruzamento / tripwire** | Desenha-se uma linha sobre a cena; a regra dispara quando um objeto rastreado a cruza, **com direção configurável**. Base para contagem direcional. | Axis, Eagle Eye Networks, intuVision (padrão de mercado) |
| **Zonas / regiões poligonais (freeform)** | Operador desenha polígono livre para definir a região de interesse (ou usa frame inteiro). Verkada suporta **até 6 polígonos** por câmera p/ loitering, e zonas de inatividade freeform. | **Verkada** (polígonos freeform, até 6), **Spot AI Smart Zones** |
| **Contagem de objetos (crossline counting)** | Conta objetos que cruzam a linha em cada direção; evento dispara quando N objetos cruzaram. Exporta dados de contagem para BI. | **Eagle Eye Networks**, **Axis Object Analytics** |
| **Heatmap de movimento/permanência** | Mapa de calor colorido sobre a cena revelando padrões de movimento/dwell num período selecionado — útil para layout/fluxo. | **intuVision Heatmaps** (integra Milestone), Ultralytics |

### 2.4 Alarmes / eventos (fila, priorização, acknowledge, forense, clip/export)

| Padrão | Descrição concreta | Quem faz bem |
|---|---|---|
| **Alarm monitoring task / Alarm List dedicada** | Aba/painel dedicado com lista de alarmes ativos; **ícone de monitoramento fica vermelho** quando há alarmes ativos. Colunas customizáveis (right-click no cabeçalho → selecionar colunas), com **Group by** e ordenação. | **Genetec Alarm monitoring task**, **Bosch Alarm List** |
| **Priorização por cor** | Cada alarme tem indicador colorido refletindo **nível de prioridade**; vídeo do alarme aparece num tile **com overlay colorido contendo os detalhes do alarme**. | **Genetec** (overlay colorido c/ detalhes), **Avigilon FoA** (vermelho = alarme) |
| **Acknowledge (padrão / alternado / forçado)** | Comandos: **Acknowledge** (resposta primária que encerra o ciclo de vida e tira da lista de ativos), **Auto-forward** (encaminha a outro usuário), **Trigger** (cria alarme manual), **Force acknowledge all** (admin, em massa). Duplo-clique no alarme abre pop-up com todos os comandos + contexto. | **Genetec** (ciclo de vida completo de ack) |
| **Alarme dispara ação visual automática** | Câmera do alarme (e câmeras vizinhas) **estoura no video wall cobrindo a tela** para notificação óbvia; ou aparece no Alarm Image window. | **HikCentral** (pop-up no wall), **Bosch** (Alarm Image window) |
| **Investigação forense / timeline + linguagem natural** | Task de investigação com **busca por linguagem natural** e filtros inteligentes para achar segmentos de vídeo; relatório forense busca pessoas/veículos numa janela de tempo. | **Genetec Investigation task**, **Verkada/Spot AI** (NL search) |
| **Appearance / Motion Search** | Localiza uma pessoa/veículo **através de várias câmeras** por descrição física (cor de roupa, gênero), foto enviada, ou exemplo selecionado no vídeo gravado. Verkada: arrastar para criar grade na imagem + filtros People/Vehicle/Date. | **Avigilon Appearance Search**, **Verkada** (people/vehicle motion search) |
| **Export de evidência automatizado** | "Event-to-action": gravações ligadas a eventos são exportadas/enviadas automaticamente direto do sistema; snapshot e clip a partir do tile. | **Genetec** (event-to-action export) |
| **Alerta = clipe + contexto + planta** | Cada alerta acionável já vem com **clipe de vídeo correspondente + contexto crítico**; para eventos de acesso, preview de vídeo instantâneo + câmera ao vivo + planta para triagem imediata. | **Ambient.ai** (alerta auto-contido), **Spot AI** |

### 2.5 Configuração de regras por câmera/zona (thresholds, sensibilidade, agenda) sem virar bagunça

| Padrão | Descrição concreta | Quem faz bem |
|---|---|---|
| **Rules builder centralizado** | Tela de "Rules" onde se cria regra escolhendo: câmera(s) ou **grupo de câmeras**, evento de áudio/visual, e critérios — separando *definição da regra* da *visualização ao vivo*. | **Ava/Alta Rules**, **Spot AI** (regras→ações) |
| **Slider de sensibilidade com prévia de volume** | Em vez de campo numérico cru, **slider** entre "preciso (menos alertas)" e "amplo (mais alertas)"; a UI mostra a **estimativa de alertas/dia** com base no histórico da câmera antes de salvar. Reduz tentativa-e-erro. | **Verkada** (estimativa de volume + slider) ⭐ |
| **Sensibilidade em níveis nomeados** | Em vez de 0–100, opções discretas: *Baixa (menos eventos) / Moderada / Alta (mais eventos)* — menos paralisia de decisão. | **Verkada Tamper Alerts** |
| **Agenda de notificação** | Dias e horários em que o alerta notifica (ex.: só fora do expediente) configurados por regra. | **Verkada** (notification schedule) |
| **Regras compostas (Compound Alerts)** | Combina múltiplas condições (classe + dwell + região + horário) numa única regra para reduzir falsos positivos. | **Verkada Compound Alerts** |
| **Regra por linguagem natural** | Operador descreve em texto o que quer detectar; a IA interpreta e cria a regra/ação (alerta, dissuasão, workflow, scorecard). | **Spot AI Video AI Agents**, **Verkada AI-powered alerts** |

### 2.6 PTZ, presets e padrões de tela cheia / expandir

| Padrão | Descrição concreta | Quem faz bem |
|---|---|---|
| **Presets PTZ** | Posição salva (pan/tilt/zoom/foco) como "bookmark"; clicar leva a câmera à posição. | Padrão universal de VMS |
| **Patrol / tour / sequence** | Coleção de presets que a PTZ percorre automaticamente ao longo do dia. | Padrão universal |
| **Controle PTZ em single-channel** | PTZ controlada melhor em **visão de canal único (tela cheia)**; right-click → Quick Menu → Pan/Tilt/Zoom; +/- para zoom. | NVRs/VMS em geral |
| **Duplo-clique para expandir / fullscreen** | Duplo-clique numa célula da grade expande para tela cheia (e volta); zoom digital arrastando na imagem. | Padrão universal (Verkada, Milestone, etc.) |

---

## 3. O que Roubar para o Nosso CD

Mapeamento direto dos padrões acima para os componentes do nosso sistema (central multi-câmera, zonas/máscaras, modos, overlays, alertas Andon/WhatsApp, relatórios).

### 3.1 Para a CENTRAL MULTI-CÂMERA (grade de feeds ao vivo)
- **Views salvas (privadas/compartilhadas) como navegação primária** *(Milestone)*. Em vez de uma grade única, deixar o operador montar e salvar "views" por setor do CD (Recebimento, Expedição, Picking, Docas) e alternar entre elas. Views compartilhadas garantem que o turno todo veja o mesmo padrão.
- **Carrossel/rotação por página com título e dwell custom** *(Verkada)*. Com dezenas de câmeras, paginar a grade automaticamente, cada página titulada ("Docas 1-12") e com tempo de permanência configurável — páginas críticas ficam mais tempo.
- **Foco + contexto** *(Verkada/Genetec hotspot)*: layout com uma célula grande para a câmera/zona crítica do momento + grade menor ao redor; ou um **hotspot tile** que recebe a câmera clicada/o último alerta sem perder a grade.
- **Mapa/planta do CD com câmeras** *(Genetec/HikCentral/Ava)*. Forte candidato: planta do galpão com ícones de câmera que mudam de cor por status/alerta; clicar abre o feed. "Smart Presence" — pontos de pessoas/empilhadeiras se movendo na planta — é poderoso para visão de fluxo do CD.

### 3.2 Para ZONAS / MÁSCARAS por câmera
- **Polígonos freeform com limite sensato** *(Verkada — até 6)*. Desenho de zona por polígono livre sobre o frame, com a máscara como caso especial. Limitar o número de zonas por câmera evita bagunça visual e de regras.
- **Linha/tripwire com direção** *(Axis/EEN)* para contagem direcional em corredores e docas (entradas vs. saídas), alimentando relatórios de fluxo.
- **Zona é um objeto reutilizável ligado a regras**, separado da tela ao vivo *(Ava Rules)* — desenha-se a zona uma vez e várias regras/modos a referenciam.

### 3.3 Para MODOS (atividade/presença, fadiga, leitura de códigos, objetos)
- **Surface automático das câmeras mais ativas** *(Ambient.ai/Spot AI)*. Núcleo da nossa proposta de valor: o dashboard promove automaticamente as câmeras onde o modo ativo está disparando (presença detectada, sinal de fadiga, código lido), em vez de exigir vigilância passiva da grade inteira.
- **Overlay com box + ícone de classe + confiança** *(Avigilon)*. Renderizar caixa com símbolo da classe (pessoa/objeto/código) e % de confiança. Para leitura de códigos, mostrar o valor decodificado direto no overlay.
- **Cada modo expõe sua regra no mesmo Rules builder** *(Ava/Spot AI)*, com seletor de câmera/grupo, zona referenciada e parâmetros do modo.

### 3.4 Para ALERTAS (Andon / WhatsApp)
- **Fila de alarmes dedicada com prioridade por cor e ciclo de ack** *(Genetec/Bosch)*. Lista de alertas ativos com cor por severidade, colunas customizáveis, **Acknowledge** que encerra o ciclo e tira da fila, **encaminhar** para outro operador, e **force-ack em massa** para o supervisor. Ícone global fica vermelho com alerta ativo.
- **Alerta auto-contido = clipe + snapshot + contexto + planta** *(Ambient.ai)*. A mensagem de Andon/WhatsApp e o card na fila devem trazer já o snapshot/clip, a câmera, a zona e a posição na planta — triagem sem precisar caçar o feed. Isso casa perfeitamente com WhatsApp (manda imagem + contexto).
- **Slider de sensibilidade com estimativa de volume/dia** *(Verkada)* ⭐. Antes de ativar um modo/regra, mostrar quantos alertas/dia ele geraria com base no histórico — evita inundar o Andon/WhatsApp com falsos positivos. **Padrão de maior impacto para nós.**
- **Agenda de notificação + regras compostas** *(Verkada)*. Alertar só em janelas relevantes (turnos) e combinar condições (classe + dwell + zona + horário) para cortar ruído — essencial num CD onde movimento é constante.
- **Ação visual automática no alerta** *(HikCentral/Bosch)*: alerta crítico estoura a câmera correspondente em destaque na central (equivalente "Andon" na própria tela).

### 3.5 Para RELATÓRIOS
- **Busca forense por linguagem natural + filtros People/Vehicle/Date/Zona** *(Genetec/Verkada)*. Permitir "mostre pessoas na doca 3 entre 14h-16h ontem" e pular direto aos clipes.
- **Appearance/Motion Search entre câmeras** *(Avigilon)* para rastrear uma pessoa/empilhadeira pelo CD.
- **Export automatizado de evidência (event-to-action)** *(Genetec)*: clip/snapshot do evento gerado e anexado ao relatório automaticamente.
- **Contagem (crossline) e heatmap como saída de relatório** *(EEN/intuVision)*: relatórios de fluxo por doca/corredor e mapas de calor de permanência para análise de layout do CD.

### 3.6 Para SAÚDE / OPERAÇÃO (transversal)
- **Dashboard de saúde com tiles semáforo (verde/amarelo/vermelho)** *(Milestone System Monitor)*: por câmera e por grupo, com online/offline, FPS, erro de stream — operador sabe na hora se um modo parou porque a câmera caiu.
- **Image-health por IA (câmera movida/obstruída)** *(Ava)*: alertar quando uma câmera do CD foi deslocada/coberta, invalidando zonas e modos.
- **Status embutido no tile da grade** *(Milestone/Genetec)*: badge de online/FPS/erro no canto de cada feed.

### Top 3 para implementar primeiro (custo/benefício)
1. **Slider de sensibilidade com estimativa de alertas/dia** (Verkada) — máximo impacto na qualidade do Andon/WhatsApp, baixo custo de UI.
2. **Alerta auto-contido (clipe+snapshot+zona+planta) + fila de alarmes com ack** (Ambient.ai + Genetec) — transforma o alerta em algo acionável de verdade.
3. **Views salvas por setor + surface automático das câmeras ativas** (Milestone + Ambient.ai) — resolve a escala de muitas câmeras sem vigilância passiva.

---

## 4. Referências

### Milestone XProtect
- Views (configuration) — https://doc.milestonesys.com/2024R1/en-US/standard_features/sf_sc/sf_viewing/current/sc_configuringviews.htm
- XProtect Smart Wall (explained) — https://doc.milestonesys.com/latest/en-US/standard_features/sf_mc/sf_systemoverview/mc_wallexplained.htm
- Setting up XProtect Smart Wall — https://doc.milestonesys.com/latest/en-US/feature_flags/ff_wall/wall_setupinxpsc.htm
- System Monitor (explained) — https://doc.milestonesys.com/latest/en-US/standard_features/sf_mc/sf_mcnodes/sf_7systemdashboard/mc_systemmonitorexplai.htm ⚠️ (página JS; conteúdo via resumo de busca)
- Views & View Groups (terceiros) — https://theboringlab.com/milestones-xprotect-views-and-views-groups/

### Genetec Security Center
- Overview of the Monitoring task (5.13) — https://techdocs.genetec.com/r/en-US/Security-Center-User-Guide-5.13/Overview-of-the-Monitoring-task
- Overview of the Alarm monitoring task (5.11) — https://techdocs.genetec.com/r/en-US/Security-Center-User-Guide-5.11/Overview-of-the-Alarm-monitoring-task-in-Security-Center
- Investigating current and past alarms (5.12) — https://techdocs.genetec.com/r/en-US/Security-Center-User-Guide-5.12/Investigating-current-and-past-alarms
- Acknowledging alarms (SaaS) — https://help.securitycentersaas.genetec.cloud/EN/AcknowledgingAlarms.html
- Plan Manager (mapas) — https://www.genetec.com/solutions/all-products/security-center/plan-manager
- Custom dashboards (tiles/widgets) — https://www.genetec.com/blog/products/optimize-security-and-operations-with-custom-dashboards
- 10 ways to enhance monitoring tasks — https://www.genetec.com/blog/products/10-ways-to-enhance-your-monitoring-tasks-in-security-center ⚠️ (página JS)
- System Availability Monitor — https://resources.genetec.com/en-feature-notes/system-availability-monitor
- Forensic search — https://resources.genetec.com/security-center-unified-security-platform/forensic-search-in-genetec-security-center

### Avigilon (Unity / Alta / Ava)
- Focus of Attention (Unity Video Client 8.7) — https://docs.avigilon.com/bundle/unity-video-client-8-7/page/using/focus-of-attention.htm ⚠️ (página JS; cores via resumo: movimento=azul, evento analítico=teal, face watchlist=amarelo, alarme=vermelho; layout em favo de mel)
- Avigilon Unity Video 8 (terceiros) — https://ecl-ips.com/blog/avigilon-unity-8-step-into-the-future-with-advanced-surveillance/
- Alta Aware — https://docs.video.avasecurity.com/en/Products/aware/aware.htm
- Camera image health monitoring — https://beta-aware.docs.alta.avigilon.com/Products/aware/devices/imagehealth.htm
- Ava/Alta Video (terceiros) — https://ecl-ips.com/ava-aware-video-management/

### Verkada Command
- Command UI Enhancements & Public Grids — https://www.verkada.com/blog/command-ui-enhancements-public-grids/
- Grids (Help Center) — https://help.verkada.com/verkada-cameras/live-streaming/grids
- People and Vehicle Motion Search — https://help.verkada.com/verkada-cameras/analytics/people-and-vehicle-motion-search
- Introducing AI-Powered Alerts (slider + estimativa) — https://www.verkada.com/blog/introducing-ai-powered-alerts/
- Compound Alerts — https://help.verkada.com/verkada-cameras/analytics/create-camera-event-alerts/compound-alerts
- Tamper / Inactivity / Activity Alerts — https://help.verkada.com/verkada-cameras/analytics/create-camera-event-alerts/

### Axis Camera Station
- ACS 5 User manual — https://help.axis.com/en-us/axis-camera-station-5
- ACS Pro Feature guide — https://help.axis.com/en-us/axis-camera-station-pro-feature-guide
- AXIS Object Analytics counting data — https://www.axis.com/developer-community/axis-object-analytics-counting-data

### Bosch BVMS
- BVMS Operation Manual (12.2 PDF) — https://cdn.commerce.boschsecurity.com/public/documents/BVMS_12.2_Operation_Manual_enUS_122217598091.pdf
- BVMS Operator Client Tutorials — https://www.midches.com/bvms-operator-client-tutorials

### Hikvision HikCentral Professional
- Control Room Solution — https://www.hikvision.com/uk/products/software/hikcentral-professional-series/hikcentral-professional-control-room-solution/
- How to configure alarm display on Smart Wall — https://www.hikvision.com/en/support/how-to/how-to-video/how-to-configure-alarm-display-on-smart-wall-on-hikcentral-pro/
- Control Client User Manual (PDF) — https://www.hikvisioneurope.com/uk/portal/portal/Software/Video%20Management%20Software/HikCentral%20Professional/

### Ambient.ai
- Platform overview — https://www.ambient.ai/platform-overview
- AI-Native VMS — https://www.ambient.ai/ai-native-video-management
- VMS Guide 2026 — https://www.ambient.ai/blog/video-management-system-vms
- AI video analytics in physical security — https://www.ambient.ai/blog/ai-video-analytics-in-physical-security

### Spot AI
- AI Agent Dashboard — https://www.spot.ai/product/dashboard
- Dashboard redesign 2025 — https://www.spot.ai/blog/spot-ai-dashboard-redesign-2025
- Video intelligence software — https://www.spot.ai/blog/video-intelligence-software-what-it-is-how-it-works-and-why-you-need-it

### Padrões de analytics (transversal)
- Object Counting (Eagle Eye Networks) — https://www.een.com/video-analytics-object-counting/
- Heatmap Video Analytics (intuVision) — https://www.intuvisiontech.com/events/heatmaps
- Behavioral analytics: loitering & intrusion zones (Fora Soft) — https://www.forasoft.com/learn/video-surveillance/articles-vms/behavioral-analytics-loitering-intrusion-zones
- PTZ presets/tours (referência) — https://help.c5k.info/176991-specialty-camera-guides/ptz-presets-tours-scans-patterns-and-pans

---

*Documento gerado por pesquisa de UX comparativa. Itens ⚠️ não foram verificados por inspeção visual direta da interface (páginas com renderização JS ou baseados em resumo textual de documentação) — recomenda-se validar com trials/screenshots antes de decisões de design definitivas.*
