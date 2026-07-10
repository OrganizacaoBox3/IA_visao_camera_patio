# Benchmark de Interfaces — Ultrassom e Imagem Médica em Tempo Real

> **Domínio:** Aparelhos de ultrassom (GE, Philips, Siemens, Canon, Mindray, Butterfly iQ, Clarius) e correlatos.
> **Objetivo:** Inspirar a UI do nosso sistema de visão computacional para CD — câmera ao vivo + overlays de detecção + zonas/ROIs + thresholds/sensibilidade + modos de análise + medições/indicadores.
> **Data:** 2026-06-28
> **Foco:** COMO o operador interage com a imagem ao vivo enquanto ajusta parâmetros e faz medições/anotações.

---

## Por que o ultrassom é o melhor análogo

O ultrassom é o caso de uso clássico de "imagem ao vivo + análise em tempo real + medição quantitativa sobre a imagem". O operador (sonografista) passa horas olhando para uma tela, ajustando parâmetros continuamente com uma mão enquanto a outra opera o transdutor, congelando para revisar quadros e colocando medições/anotações sobre a imagem — exatamente o loop de interação que queremos para a tela de câmera ao vivo do CD. As décadas de refinamento ergonômico desses aparelhos (uso intenso e prolongado, ambientes de baixa luz) são diretamente aproveitáveis.

> **Nota de verificação:** As descrições abaixo vêm de páginas de fabricantes, manuais de usuário e artigos. Detalhes de gestos/layout dos apps handheld (Butterfly, Clarius, Lumify) são bem documentados; já as telas internas dos sistemas de carrinho (LOGIQ E10, EPIQ, ACUSON, Vivid) são descritas a partir de material de marketing e specs — **não inspecionei as telas reais quadro a quadro**. Itens marcados com ⚠️ são inferências razoáveis não confirmadas pixel a pixel.

---

## 1) Panorama dos aparelhos

| Aparelho | Classe | Forma da UI | Diferencial de UI relevante para nós |
|---|---|---|---|
| **GE LOGIQ E10 / E / P9** | Carrinho premium (geral) | Monitor de imagem + **touchscreen dedicado** de controles + teclado flutuante | Separação clara "imagem" vs "controles"; touchscreen muda conforme o modo; automação por IA reduz cliques (~50%) |
| **GE Vivid (E95/S70/T9/iQ)** | Cardio (eco) | Igual LOGIQ + ECG | **Freeze → Measure → Auto**: 1 clique gera conjunto completo de medições; Easy AutoEF |
| **Philips EPIQ Elite / Affiniti** | Carrinho premium | Monitor + touchscreen configurável | **Anatomical Intelligence**: aparelho "adaptativo"; Auto Measure coloca calipers sozinho |
| **Philips Lumify** | Handheld (app Android) | Tablet/celular, imagem dominante + ícones nas bordas | **Autoscan/Auto-gain** em tempo real; gestos simples; "select preset and start scanning" |
| **Siemens ACUSON (S, NX3, Juniper, Maple, P500)** | Carrinho | Monitor + touchscreen | **eSieScan workflow protocols** guiam passo a passo; backlighting dinâmico mostra só o que está disponível |
| **Canon Aplio** | Carrinho premium | Monitor + touchscreen | Foco em qualidade de imagem + automação (não detalhado aqui) ⚠️ |
| **Mindray (DC-80, MX8, TE7, TE Air)** | Carrinho + handheld | Touchscreen multitoque | **iWorks**: protocolo automatiza o fluxo passo a passo; auto-detecção de anatomia troca preset sozinho |
| **Butterfly iQ / iQ+ / iQ3** | Handheld (app) | Celular/tablet, imagem dominante + toolbar inferior | Toolbar inferior de presets; gain por arraste; freeze + cine; calipers por toque |
| **Clarius** | Handheld (app) | Celular/tablet, imagem quase tela cheia | **Gestos**: arraste lateral = gain, vertical = depth, pinça = zoom; Auto Preset AI; TGC em 3 sliders |

**Dois arquétipos de layout:**
1. **Carrinho (dois planos):** uma tela só para a IMAGEM (limpa, máxima) + uma tela/painel só para os CONTROLES. O operador quase não polui a imagem com UI.
2. **Handheld/app (um plano):** imagem ocupa quase tudo; controles são ícones discretos nas bordas + **gestos sobre a própria imagem**. É o arquétipo mais próximo do que rodamos no navegador.

---

## 2) Catálogo de padrões de UI / feature (descrição concreta)

### 2.1 Layout da tela — imagem dominante + faixa de controles

- **Imagem é soberana.** Em todos os aparelhos a imagem ao vivo ocupa o maior espaço possível, fundo preto, centralizada. Controles ficam em **faixas/barras nas bordas** ou em **tela separada**.
- **Régua/escala sempre visível.** O Butterfly e o Lumify mostram uma **régua de profundidade em cm na lateral** permanentemente — referência espacial sem poluir o centro. (Análogo p/ nós: escala/grid de referência opcional sobre a cena.)
- **Barra de status leve no topo.** Preset ativo, modo, parâmetros-chave (profundidade, ganho, frame rate) exibidos como texto pequeno num canto, não como widgets grandes.
- **Toolbar inferior (handheld).** No Butterfly, a barra inferior concentra: seleção de preset, modos, medição, captura de imagem, captura de cine. Acesso com o polegar.
- **Backlighting/visibilidade dinâmica (Siemens):** o painel só ilumina/exibe os controles **relevantes ao modo atual** — reduz carga cognitiva e ruído visual. Padrão forte: *mostrar só o que faz sentido agora*.

### 2.2 Ferramentas sobre a imagem ao vivo

- **Calipers / medição por toque (todos).** O operador toca um ponto inicial e um final; o sistema desenha a linha e mostra a distância. Butterfly/Lumify medem distância, circunferência, área e até frequência cardíaca. Calipers são **arrastáveis com alça (handle)** para ajuste fino.
- **ROI / caixas de região.** No Color Doppler o operador desenha/move uma **caixa de ROI** sobre a imagem para limitar a análise àquela região (análogo direto às nossas zonas/máscaras). A caixa é redimensionável por alças.
- **Anotações/labels.** Lumify usa teclado e reconhecimento de voz; ícone (floco de neve) abre rotulagem + medição + salvar. Anotações ficam ancoradas a pontos da imagem.
- **Freeze (congelar).** Botão único e proeminente. Congelar **transforma o modo de interação**: aparecem o slider de cine, ferramentas de medição e salvar/compartilhar. É o "modo edição" da imagem.
- **Cine-loop (revisar quadros recentes).** Ao congelar, o aparelho mantém um buffer dos últimos N segundos. Surge um **slider/scrubber de cine** para varrer quadro a quadro e escolher o melhor frame para medir/salvar. Clarius grava clipes de 1–30 s.

### 2.3 Presets / modos por exame (≈ nossos modos atividade/fadiga/leitura/objetos)

- **Preset = conjunto pré-configurado de parâmetros.** Selecionar "Abdômen", "Cardíaco", "Vascular" etc. ajusta automaticamente ganho, profundidade, foco, mapa de cor e algoritmos. **Analogia direta:** nossos modos (atividade/fadiga/leitura/objetos) devem ser presets que recarregam thresholds, ROIs default, overlays e métricas de uma vez.
- **Troca rápida de modo.** Butterfly: lista de presets na toolbar inferior; Mindray coloca **os presets mais usados no topo da lista**. Lumify: "select preset and start scanning" como passo de entrada.
- **Presets customizáveis (Clarius).** O usuário salva seus próprios defaults de ganho/profundidade por preset. Padrão forte: *cada modo guarda as preferências do operador*.
- **Ajuste de ganho/profundidade/foco (≈ sensibilidade/threshold):**
  - **Ganho** = brilho global ≈ nossa **sensibilidade global de detecção**. Butterfly/Clarius: **arrastar o dedo na horizontal sobre a imagem** aumenta/diminui ganho. Sem abrir menu.
  - **Profundidade** = quão fundo enxergar ≈ **escopo/zoom da análise**. Clarius: **arrastar na vertical**.
  - **TGC (Time-Gain Compensation)** = ganho por faixa de profundidade. Clarius simplificou de ~8 sliders para **3 sliders (topo/meio/base)**, e o slider do meio move todos juntos. Padrão forte: *ofereça ajuste fino por região, mas com um controle "mestre" simples por cima*.
  - **Autoscan/Auto-gain (Philips):** ajusta o ganho de cada linha em tempo real para manter brilho uniforme — elimina ajuste manual. ≈ **auto-threshold/auto-sensibilidade adaptativa** no nosso caso.

### 2.4 Resultados quantitativos sem poluir a imagem

- **Painel de medições lateral/inferior.** As medidas numéricas aparecem em uma **lista/tabela fora da imagem** (canto ou faixa), enquanto sobre a imagem fica apenas a marcação geométrica (linha, caixa, traço). Separa "o desenho" do "o número".
- **Resultados aparecem só quando relevantes.** Índices (EF, strain, volume) surgem após a ação de medir, não o tempo todo.
- **Auto-medição com números prontos (GE Vivid):** **Freeze → Measure → Auto** = em 3 cliques aparece um conjunto completo e reprodutível de medições. Easy AutoEF dá fração de ejeção em <5 s, 1 clique. Os números aparecem ancorados perto da estrutura + resumidos no painel.

### 2.5 Ergonomia de uso intenso e prolongado

- **Monitor ~20° abaixo do nível dos olhos**, sem inclinar para frente nem olhar para cima; braço articulado para reposicionar.
- **Ambiente de baixa luz / tema escuro.** Salas são mantidas em penumbra; a UI usa **fundo preto e texto/controles claros** para reduzir glare e fadiga ocular. Dimmer é recomendado. → Forte argumento para um **dark theme** padrão na nossa tela ao vivo do CD.
- **Causas de fadiga ocular documentadas:** imagem de baixa resolução, excesso de luz ambiente, monitor distante → causam visão embaçada, olhos secos, dor de cabeça. Mitigação: alto contraste, imagem nítida, distância adequada.
- **Menos toques = menos esforço.** GE: "20% menos tempo, 50% menos toques"; Siemens eSieScan: até 44% menos teclas. Automação serve tanto à velocidade quanto à **redução de carga física/cognitiva** em jornada longa.
- **Affordances táteis e feedback:** Siemens "Instant Response" + backlighting dinâmico dá feedback imediato de qual controle está ativo; só ilumina o que é usável no modo atual.

### 2.6 IA assistida e como é apresentada

- **Auto-preset por reconhecimento de anatomia (Clarius, Mindray):** a IA detecta o que está sob o transdutor e **troca o preset / otimiza ganho e profundidade sozinha**. ≈ nosso sistema poderia sugerir/trocar o modo conforme o que aparece na cena.
- **Auto-colocação de calipers (Philips Auto Measure, GE AI Auto Measure 2D, Siemens eSie Measure):** a IA reconhece bordas/estruturas e **coloca as medidas automaticamente**; reduz ~55% (Philips) / ~80% de cliques (GE) e a variabilidade entre operadores. Detectabilidade 98%, reprodutibilidade 100% (GE).
- **Apresentação "humano confirma":** os resultados de IA aparecem como **propostas editáveis** — calipers automáticos que o operador pode arrastar/corrigir, ROIs auto-detectadas ajustáveis. A IA acelera, o operador valida. Esse é o modelo de confiança certo.
- **Resultados em segundos, ancorados + resumidos:** EF/strain em 15 s (GE Easy AFI), exibidos sobre a estrutura e consolidados num painel.

---

## 3) O que roubar para o nosso CD

### 3.1 Tela de câmera ao vivo
- **Imagem soberana, fundo escuro, UI nas bordas.** Maximizar o vídeo; controles em barras laterais/inferior, nunca cobrindo o centro. Adotar **dark theme** por padrão (ergonomia de jornada longa + contraste dos overlays).
- **Barra de status enxuta no topo:** modo ativo, FPS, contagem de detecções, sensibilidade atual — como texto pequeno, não widgets.
- **"Mostrar só o que importa agora" (Siemens):** os controles visíveis mudam conforme o modo ativo; esconder o que não se aplica.
- **Régua/grid de referência opcional** sempre disponível na lateral (análogo à régua de profundidade), para dar noção espacial da cena sem poluir.
- **Overlays como camadas toggláveis:** caixas de detecção, zonas, máscaras e rótulos devem poder ser ligados/desligados individualmente (o operador escolhe o quão "cheia" fica a imagem).

### 3.2 Editor de zonas (ROI / máscaras)
- **Caixas/polígonos com alças de redimensionamento e arraste** sobre a imagem ao vivo, exatamente como a ROI box do Color Doppler.
- **Zona como objeto nomeado** com label ancorado e cor própria; lista de zonas em painel lateral (separar "desenho na imagem" de "metadados/lista").
- **Edição com a imagem congelada:** permitir congelar (ver 3.4) para desenhar zonas com precisão sobre um quadro estático, depois aplicar ao vivo.
- **Defaults por modo:** cada modo traz ROIs/zonas padrão que o operador ajusta (presets customizáveis estilo Clarius).

### 3.3 Ajuste de sensibilidade / threshold
- **Controle "mestre" simples + ajuste fino por região.** Espelhar o TGC do Clarius: um slider global de sensibilidade + (opcional) 3 zonas de ajuste fino. Evitar expor dezenas de sliders.
- **Ajuste por gesto/arraste direto sobre a imagem** (como gain por arraste horizontal no Butterfly/Clarius): rápido, sem abrir menu, com feedback visual imediato dos overlays mudando ao vivo.
- **Auto-sensibilidade adaptativa (Autoscan/Auto-gain):** oferecer um modo automático que ajusta thresholds para manter taxa de detecção estável sob mudança de iluminação — com opção de assumir manualmente.
- **Mostrar o valor atual** discretamente (ex.: "Sensibilidade 0.62") e o efeito refletido nos overlays em tempo real.

### 3.4 Congelar / revisar (o padrão mais subestimado)
- **Botão Freeze proeminente + buffer dos últimos N segundos.** Congelar deve abrir um **scrubber/cine de quadros recentes** para o operador voltar e analisar o momento exato de um evento (ex.: quase-acidente, queda, objeto fora da zona).
- **Freeze = "modo edição":** ao congelar, habilitar medição, desenho de zona e salvar/exportar o clipe — como os aparelhos fazem.
- **Salvar clipe/imagem do evento** direto do buffer, com o preset/modo e métricas embutidos.

### 3.5 Modos (atividade / fadiga / leitura / objetos)
- **Modo = preset completo.** Trocar de modo recarrega de uma vez: thresholds/sensibilidade, zonas default, quais overlays mostrar e quais métricas/indicadores exibir.
- **Troca rápida em barra dedicada**, com os modos mais usados em destaque (Mindray); 1 toque para alternar.
- **Presets do operador:** salvar customizações por modo/estação.
- **Sugestão automática de modo** (estilo Auto Preset AI): o sistema pode sugerir trocar de modo conforme o que detecta na cena — sempre como sugestão confirmável, não troca silenciosa.

### 3.6 Resultados quantitativos / IA
- **Separar marcação de número:** sobre a imagem só a geometria (caixa/linha/zona); os números/indicadores num **painel lateral compacto**.
- **Métricas sob demanda + resumo persistente:** indicadores-chave (ex.: ocupação de zona, contagem, tempo de permanência) num painel fixo discreto; detalhes só quando solicitados.
- **IA como proposta editável:** detecções/medições automáticas aparecem como sugestões que o operador confirma/corrige (modelo "humano valida"), reforçando confiança e auditabilidade.

---

## 4) Referências

**GE Healthcare (LOGIQ / Vivid)**
- LOGIQ E10 Series — https://gehealthcare-ultrasound.com/en/logiq-family/logiq-e10-series/
- LOGIQ family — https://gehealthcare-ultrasound.com/en/logiq-family/
- "Touchscreen enhances GE compact ultrasound" (Diagnostic Imaging) — https://www.diagnosticimaging.com/view/touchscreen-enhances-ge-compact-ultrasound
- Vivid AI and Automation (Freeze-Measure-Auto, Easy AutoEF, AI Auto Measure 2D) — https://gehealthcare-ultrasound.com/en/vivid-family/vivid-ai-and-automation/
- Vivid E95 — https://gehealthcare-ultrasound.com/en/vivid-family/vivid-e95/

**Philips (EPIQ / Lumify)**
- EPIQ Elite — https://www.usa.philips.com/healthcare/product/HC795098/epiq-elite-a-new-class-of-premium-ultrasound-has-arrived
- Philips AI-assisted workflow & quantitative measurement (Auto Measure Abdomen, Auto ElastQ) — https://www.philips.com/a-w/about/news/archive/standard/news/articles/2025/philips-new-ai-assisted-workflow-and-quantitative-measurement-functions-in-the-epiq-elite-and-affiniti-ultrasound-systems-speed-up-exams-and-increase-clinical-confidence.html
- Anatomical Intelligence (HeartModel) — https://www.philips.com/a-w/about/news/archive/standard/news/press/2018/20180822-philips-launches-new-cardiac-ultrasound-solutions-with-anatomical-intelligence.html
- Lumify app — https://www.usa.philips.com/healthcare/sites/lumify-handheld-ultrasound/products/lumify-app
- Lumify SMUG review (Autoscan/auto-gain, calipers de toque) — https://www.ultrasoundtraining.co.uk/phillips-lumify-smug-product-review/

**Siemens Healthineers (ACUSON)**
- ACUSON S Family — Improved Workflow (HELX, touch control) — https://www.origin.healthcare.siemens.com/ultrasound/news-and-innovations/acuson-s-family-helx/improved-workflow
- ACUSON S Family — Workflow Automation (eSieScan, eSie Measure) — https://www.siemens-healthineers.com/en-us/ultrasound/acuson-s-family-ultrasound-systems-workflow
- ACUSON Juniper — https://www.siemens-healthineers.com/ultrasound/new-era-ultrasound/acuson-juniper

**Mindray**
- TE Air e5M (20+ presets, mais usados no topo) — https://www.mindray.com/na/products/ultrasound/portable-ultrasound-machines/handheld-ultrasound/te-air-e5m-handheld-ultrasound/
- DC-80 Operator's Manual (iWorks) — https://www.mindray.com/content/dam/xpace/en_us/service-and-support/training-and-education/resource--library/technical--documents/operators-manuals-3/legacy-products/H-046-011355-01-DC-80-instruction-manual-basic-volume-FDA.pdf
- TE7 Max — https://www.mindray.com/na/products/ultrasound/point-of-care/te-series/te-7-max-portable-ultrasound-machine/

**Butterfly iQ**
- Butterfly iQ App Interface (suporte) — https://support.butterflynetwork.com/hc/en-us/articles/16907018495771-Butterfly-iQ-App-Interface  *(página carregou com erro de CSS; conteúdo extraído de manual + busca)* ⚠️
- Butterfly iQ User Manual (PDF) — https://manual.butterflynetwork.com/butterfly-iq-user-manual_rev-bf-en.pdf

**Clarius**
- Beginner's Video Guide (gestos: gain horizontal, depth vertical, pinça zoom; freeze/snowflake; cine 1–30 s; calipers) — https://clarius.com/blog/a-beginners-video-guide-to-clarius-handheld-ultrasound/
- Clarius Intelligence (AI) — https://clarius.com/ultrasound-ai/
- Auto Preset AI — https://clarius.com/blog/ultrasound-ai-breakthrough-clarius-is-first-to-detect-anatomy-and-auto-select-preset-for-an-instant-window-into-the-body/
- Advanced Controls (TGC em 3 sliders) — https://support.clarius.com/hc/en-us/articles/360019549232-Advanced-Controls  *(403 Forbidden ao acessar; conteúdo de busca)* ⚠️

**Ergonomia**
- Baker, "Importance of an Ergonomic Workstation" (JUM 2013) — https://onlinelibrary.wiley.com/doi/full/10.7863/ultra.32.8.1363
- OSHA — Sonography eTool — https://www.osha.gov/etools/hospitals/clinical-services/sonography
- Gulfcoast Ultrasound — Ergonomics in Sonography — https://www.gcus.com/blog/Ergonomics-in-Sonography-and-Why-It-Matters-More-Than-You-Think

---

### Marcações de verificação
- ✅ Verificado em fonte primária/manual: gestos do Clarius e Butterfly; presets; freeze/cine; auto-medição GE/Philips/Siemens; ergonomia (OSHA/JUM).
- ⚠️ Não inspecionado pixel a pixel / extraído de marketing ou busca (página não carregou): telas internas de LOGIQ E10/EPIQ/ACUSON/Vivid; layout exato da toolbar do Butterfly; Advanced Controls do Clarius. Canon Aplio não foi pesquisado em profundidade.
