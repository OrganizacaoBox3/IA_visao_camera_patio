# Projeto de Pesquisa e Inovação # Plataforma de Localização Indoor Inteligente (BLE + Visão Computacional) > **Objetivo** > > Desenvolver uma plataforma proprietária de localização indoor voltada para ambientes industriais, utilizando sensores de baixo custo (Bluetooth Low Energy), visão computac

pasted

Esse projeto é surpreendentemente rico do ponto de vista científico. Na prática, ele reúne problemas de pesquisa em diversas áreas. Se vocês quiserem desenvolver uma tecnologia proprietária (e até publicar artigos ou registrar patentes), estes são alguns dos principais temas.
Matemática
Geometria Computacional

Interseção entre campo de visão das câmeras
Triangulação espacial
Modelagem 3D do galpão
Polígonos de visibilidade
Homografia entre câmera e planta baixa
Transformações de coordenadas
Álgebra Linear

Matrizes de rotação
Transformações homogêneas
Calibração de câmeras
Reconstrução espacial
PCA para redução de dimensionalidade
Probabilidade e Estatística

Associação probabilística entre TAG e pessoa
Inferência Bayesiana
Filtro de partículas
Distribuições de erro do RSSI
Intervalos de confiança
Modelagem de incerteza
Otimização

Associação ótima entre múltiplas TAGs e múltiplas pessoas
Problema de matching bipartido (Hungarian Algorithm)
Programação linear
Otimização multiobjetivo
Cobertura ótima de antenas e câmeras
Ciência da Computação
Visão Computacional

Multi Object Tracking (MOT)
Re-identificação (ReID)
Estimativa de pose
Segmentação semântica
Detecção de objetos
Rastreamento entre múltiplas câmeras
Calibração automática
Inteligência Artificial

Sensor Fusion
Aprendizado Multimodal
Redes Bayesianas
Transformers para fusão temporal
Aprendizado auto-supervisionado
Few-shot learning
Active Learning
Processamento de Sinais

Filtragem do RSSI
Filtro de Kalman
Extended Kalman Filter
Unscented Kalman Filter
Particle Filter
Modelagem de ruído
Predição de trajetória
Redes

Bluetooth Low Energy
Bluetooth Mesh
BLE Direction Finding
UWB
MQTT
Sincronização temporal
Edge Computing
Robótica

SLAM
Localização probabilística
Planejamento de trajetória
Rastreamento contínuo
Occupancy Grid Maps
Pesquisa Operacional

Cobertura ótima de sensores
Posicionamento de antenas
Posicionamento de câmeras
Fluxo ótimo de pessoas
Simulação de eventos discretos
Teoria das filas
Física

Propagação de ondas de rádio
Multipath
Atenuação por obstáculos
Reflexão
Difração
Interferência eletromagnética
Ciência de Dados

Séries temporais
Detecção de anomalias
Clustering
Predição de movimentação
Modelagem comportamental
Mineração de trajetórias
Teoria dos Grafos

Grafo de câmeras
Grafo de conectividade BLE
Caminhos mínimos
Fluxo máximo
Rastreamento em grafos
Controle

Sistemas dinâmicos
Observadores de estado
Controle preditivo
Estimação de estados
Digital Twin

Modelagem espacial
Simulação em tempo real
Sincronização físico-digital
Predição de eventos
Gêmeos digitais adaptativos
Áreas de pesquisa mais avançadas
Estas são especialmente interessantes para gerar propriedade intelectual:

Sensor Fusion BLE + Visão Computacional para localização robusta.
Associação probabilística entre identidade visual e TAG BLE, resolvendo ambiguidades quando várias pessoas estão próximas.
Localização sem GPS em ambientes industriais usando múltiplos sensores.
Rastreamento contínuo entre múltiplas câmeras e antenas, mantendo a identidade mesmo fora do campo de visão.
Mapeamento automático do ambiente, aprendendo dinamicamente zonas de cobertura e propagação do sinal.
Digital Twin cognitivo, em que o modelo virtual não apenas representa o ambiente, mas prevê deslocamentos, gargalos e riscos operacionais. Esse conjunto de temas coloca o projeto na interseção de matemática aplicada, visão computacional, inteligência artificial, teoria de controle, robótica, redes sem fio e pesquisa operacional — uma combinação com grande potencial para inovação tecnológica e desenvolvimento de soluções proprietárias para a indústria.
vamos pensar de forma mais associativa. quero que pesquise por algoritimos, axiomas, logicas de outras areas ou sistemas que possam nos ajudar a extrair o maximo com essa combinacao de BLE com camera. A camera por si só ja poderia servir como digital twim, mas quero ir além. quero um software que por si só, com matematica avancada possa extrair leite de pedra. esrtao vamos gastar tempo e esforco na paste de pesquisa

Show more
O usuário quer que eu pense de forma associativa e pesquise algoritmos, axiomas, lógicas de outras áreas que possam ajudar a extrair o máximo dessa combinação BLE + câmera. Ele quer ir além do óbvio — quer "matemática avançada que possa extrair leite de pedra" (uma expressão brasileira que significa extrair valor de algo aparentemente impossível/estéril).

Deixa eu pensar sobre isso com cuidado. Este é um pedido rico, criativo, de brainstorming técnico profundo. O usuário é o Cristhyano, tech lead brasileiro com expertise em WMS/logística, que está construindo um produto de localização indoor. Ele tem background sólido — mencionou TDOA, PTP, UWB antes. Então posso ir fundo tecnicamente.

Ele quer PENSAMENTO ASSOCIATIVO — conexões com outras áreas que não são óbvias. Não quer a lista padrão de "Kalman, Bayes, Hungarian" que ele já tem no documento. Ele quer que eu traga coisas de FORA do campo óbvio de RTLS/CV.

Deixa eu pensar sobre o que realmente seria valioso e não-óbvio aqui. A ideia central é: fusão de duas modalidades fracas (BLE grosseiro + câmera com oclusões) para produzir localização robusta. O insight filosófico deles é bom: "não localizar sinais, localizar entidades."

O que outras áreas fizeram com problemas ANÁLOGOS?

Deixa eu fazer um mapa mental de campos que resolveram problemas estruturalmente idênticos:

Astronomia / Rastreamento orbital — o problema de "objeto some atrás de algo e reaparece" é EXATAMENTE data association em rastreamento de detritos espaciais e satélites. Eles têm métodos maduros (Multiple Hypothesis Tracking nasceu aí, mas também têm coisas mais novas). O "track-before-detect" é interessante.
Física de partículas / Detectores (LHC, CERN) — reconstrução de trajetórias de partículas a partir de "hits" esparsos em detectores é EXATAMENTE o problema deles. BLE dá "hits" grosseiros. Métodos: Kalman combinatório, Hough transform para trajetórias, Graph Neural Networks para tracking (o CERN usa GNNs para track reconstruction agora — exa.trkx project). Isso é ouro.
Neurociência / Modelos de população — como o cérebro estima posição a partir de sinais ruidosos (place cells, grid cells, population coding). Bayesian brain hypothesis, predictive coding. A ideia de "priors" fortes compensando sensores fracos.
Biologia / Ecolocalização e comportamento animal — como morcegos/formigas navegam. Path integration (integração de caminho), stigmergy.
Teoria da Informação — quanto de informação cada sensor REALMENTE carrega. Mutual information, information gain para decidir onde valem mais sensores. Data fusion via information filter (forma dual do Kalman).
Epidemiologia / Rastreamento de contatos — inferir quem-esteve-com-quem a partir de sinais parciais.
Esportes / Sports analytics — tracking de jogadores com múltiplas câmeras + wearables. Eles já fundem exatamente isso. STATS/Second Spectrum, etc.
Robótica / SLAM avançado — factor graphs (GTSAM, iSAM2), pose graph optimization. Isso é MUITO poderoso e provavelmente o framework matemático mais adequado para eles. Factor graphs unificam BLE + visão + odometria + constraints do mapa numa única otimização. Este é provavelmente o insight técnico mais importante que posso dar.
Finanças / Filtragem estocástica — modelos de estado oculto, filtros de partículas para volatilidade.
Linguística / Modelos de sequência — HMMs vieram de speech recognition. Viterbi. Como reconstruir a sequência mais provável de estados.
Química / Cristalografia — reconstruir estrutura 3D a partir de projeções 2D (análogo à homografia câmera→planta).
Cartografia / Geodésia — least squares adjustment, teoria de erros de Gauss. O ajustamento de observações redundantes é literalmente o que eles precisam.
Teoria de Evidência de Dempster-Shafer — alternativa a Bayes para combinar evidências com incerteza sobre a própria incerteza. Muito apropriado quando você não conhece bem as distribuições de erro.
Lógica Fuzzy — para quando os limites de zonas são difusos.
Optimal Transport (Transporte Ótimo) — teoria matemática profunda (Monge-Kantorovich, Wasserstein). É a generalização "contínua" do problema de matching bipartido. Poderia associar distribuições de probabilidade de TAGs com distribuições de detecções visuais. Isso é matemática MUITO avançada e na fronteira. Sinkhorn algorithm.
Topologia / TDA (Topological Data Analysis) — persistent homology para entender a "forma" do espaço de movimento.
Teoria de Controle Ótimo / Estimação — smoothing (não só filtering). RTS smoother. Usar o futuro para corrigir o passado (offline/near-online).
Mecânica Estatística / Física — Ising models, Markov Random Fields para o campo de propagação BLE. Gaussian Processes para modelar o mapa de RSSI (isto é usado em fingerprinting moderno — GP regression para radio maps).
Compressive Sensing — recuperar sinal de poucas medições esparsas. Muito relevante para BLE esparso.
Game Theory / Multi-agent — para modelar movimento de múltiplas pessoas com objetivos.
Agora, quais desses são REALMENTE aplicáveis e transformadores vs. só interessantes? Deixa eu priorizar pelo que daria "leite de pedra" de verdade:

Os pilares transformadores (matemática que muda o jogo):

A. Factor Graphs / Pose Graph Optimization (de SLAM/robótica) — este é o framework unificador. Em vez de pipeline sequencial (BLE→visão→fusão), você monta um grafo onde cada medição é um fator, e resolve tudo por otimização não-linear conjunta. GTSAM/iSAM2. Isto substitui a arquitetura em camadas deles por algo matematicamente ótimo e extensível. Cada nova fonte de sensor = novo tipo de fator. Isso ecoa o "motor universal" que eles querem!

B. Gaussian Processes para o radio map (de geoestatística/ML) — kriging. Aprender o mapa de propagação BLE continuamente e com incerteza calibrada. Resolve a pergunta #4 deles ("como aprender o mapa de propagação BLE").

C. Optimal Transport / Sinkhorn (matemática pura) — para a associação probabilística suave entre TAGs e pessoas. Generaliza Hungarian. Diferenciável (pode ser treinado end-to-end com deep learning). Isso é fronteira de pesquisa e patenteável.

D. Track reconstruction do CERN via GNN (física de partículas) — o problema deles de reconstruir trajetória a partir de hits esparsos é literalmente o que o CERN resolve. Trazer esses métodos é pensamento associativo puro.

E. Teoria de Evidência (Dempster-Shafer) — para fusão quando você não confia nas suas próprias distribuições. Mais robusto que Bayes ingênuo em alguns casos.

F. Set-membership / Interval estimation (de controle robusto) — em vez de estimar UM ponto, estimar o CONJUNTO de posições consistentes com todas as restrições. Zonotopos. Isso dá garantias, não só probabilidades. Muito elegante para um galpão com paredes (restrições físicas duras).

G. Population coding / Bayesian brain (neurociência) — filosofia + método. O cérebro faz exatamente isso: combina sinais ruidosos com priors fortes. Dá vocabulário e legitimidade científica.

H. Information-theoretic sensor placement (teoria da informação) — resolve pergunta #2 deles (quantas antenas). Mutual information / D-optimality.

Deixa eu também pensar em "axiomas e lógicas" já que ele pediu isso especificamente:

Princípio da Máxima Entropia (Jaynes) — quando você não sabe, assuma a distribuição menos comprometida. Axioma para lidar com incerteza.
Navalha de Occam / MDL — trajetória mais simples que explica os dados.
Princípio da Mínima Ação (física) — pessoas/objetos tendem a se mover por caminhos "eficientes". Pode ser um prior de movimento.
Predictive coding / Free energy principle (Friston) — o sistema minimiza "surpresa". Framework filosófico-matemático unificador para percepção. Muito na moda e alinhado com a visão deles.
Causalidade / Pearl — separar correlação de causa nas trajetórias.
Preciso PESQUISAR isso? O usuário pediu explicitamente "quero que pesquise". Muito do que sei é conhecimento estabelecido (factor graphs, GP, optimal transport, Kalman etc. são anteriores ao meu cutoff e bem estabelecidos). Mas há valor em buscar:

Trabalhos RECENTES específicos de fusão BLE+visão (2024-2026) para ver o estado da arte e o que já foi patenteado/publicado.
O trabalho do CERN em GNN tracking (para dar referências concretas).
Optimal transport aplicado a tracking/data association recente.
Talvez fingerprinting com GP recente.
Isto justifica busca porque: (a) ele pediu explicitamente pesquisa, (b) o estado da arte de fusão BLE+CV é fast-moving e pós-cutoff pode ter avançado, (c) referências concretas ajudam se ele quer publicar/patentear (precisa saber prior art).

Mas — devo equilibrar. O CORE do que ele quer é o pensamento associativo, que vem majoritariamente do meu conhecimento. Não quero fazer 20 buscas rasas. Vou fazer buscas direcionadas nas áreas onde recência importa (estado da arte de fusão BLE+visão, GNN tracking, optimal transport para association, GP radio maps) e construir a resposta rica em torno disso.

Deixa eu planejar as buscas:

"BLE camera sensor fusion indoor localization" — estado da arte recente + prior art
"graph neural network particle track reconstruction" — o ângulo CERN
"optimal transport data association tracking" — o ângulo matemática avançada
"Gaussian process RSSI radio map fingerprinting" — o mapa de propagação
Talvez "factor graph localization sensor fusion" — o framework unificador
Talvez algo sobre free energy principle / active inference localization
Vou fazer umas 5-6 buscas boas. Isso é apropriado para uma pergunta de pesquisa aberta e rica.

Uma coisa sobre formato: esta é uma resposta que vai ser longa e rica. O usuário quer profundidade ("vamos gastar tempo e esforço na parte de pesquisa"). Mas devo seguir as diretrizes de formatação — prosa, não excesso de bullets. Contudo, para um mapa de "áreas → o que trazer" alguma estruturação ajuda. Vou usar headers moderados e prosa densa, com listas só onde a natureza enumerativa justifica. Vou escrever em português brasileiro, que é a língua do usuário.

Devo considerar criar um artefato/documento? Ele disse "vamos gastar tempo e esforço na parte de pesquisa". Isso soa como algo que ele vai querer guardar e compartilhar com a equipe. Um documento markdown seria apropriado... mas as diretrizes dizem para não criar markdown files para resumos de web search / research — que devem ficar conversacionais. Hmm. Mas isto não é só um resumo de web search — é um documento de estratégia de pesquisa que combina meu conhecimento + algumas referências.

Deixa eu reler: "Don't create markdown files for web search responses or research summaries; those stay conversational." E "Compare how NYT vs WSJ covered... → respond CONVERSATIONALLY."

Mas também: "write a document/report → .md". E o pedido dele é essencialmente "desenvolva um documento de direções de pesquisa para nosso projeto." Isso é mais próximo de um deliverable de conteúdo (como o "Visão Técnica Consolidada" que ele já produziu antes) do que de um resumo de notícias.

Acho que a decisão certa: como ele está no meio de um fluxo de brainstorming conversacional (a mensagem anterior era conversacional, cheia de listas coladas), e ele está pensando em voz alta comigo, vou responder conversacionalmente primeiro com toda a riqueza, e oferecer no final consolidar num documento se ele quiser. Isso respeita o fluxo e evita presumir demais. Na verdade — dado o volume e a densidade do que vou produzir, e que ele claramente quer guardar isso, talvez seja melhor entregar como documento.

Vou decidir assim: faço a pesquisa, respondo conversacionalmente com o mapa associativo rico e denso (porque ele está pensando junto comigo agora, quer dialogar), e ao final ofereço consolidar num documento estruturado. Não quero que a primeira resposta seja um .md gigante que encerra o diálogo — ele quer PENSAR JUNTO. A natureza da mensagem dele é exploratória/socrática, não "me entregue um relatório."

Certo. Vou começar as buscas. Deixa eu pensar na primeira leva.

Na verdade, deixa eu reconsiderar a estratégia toda de resposta. O que faria essa resposta EXCELENTE em vez de só boa?

O usuário já tem uma lista imensa e organizada de áreas (matemática, CV, IA, etc.). Repetir isso em formato ligeiramente diferente seria inútil e frustrante. O que ele NÃO tem, e o que constituiria "leite de pedra":

Conexões associativas verdadeiras — "área X resolveu um problema estruturalmente idêntico ao seu, vejam o que trazer." Não "use Kalman" mas "o CERN reconstrói trajetórias de partículas a partir de hits esparsos exatamente como seu BLE dá hits esparsos — o método deles (GNN track finding) se transplanta."
O framework unificador que muda a arquitetura deles de pipeline para otimização conjunta: factor graphs. Este é o insight mais valioso arquiteturalmente.
Os "axiomas" e princípios que ele pediu explicitamente — princípios organizadores (máxima entropia, mínima ação, free energy, Occam) que dão coerência filosófica-matemática ao "motor universal."
A matemática de fronteira patenteável — optimal transport para association suave/diferenciável, set-membership para garantias duras via restrições do galpão, GP para radio maps auto-aprendidos.
Onde está a novidade real vs. prior art — para ele saber onde há espaço para publicar/patentear.
Deixa eu estruturar a resposta final mentalmente:

Abertura curta: reformular o problema no nível mais abstrato (o que revela as conexões). "Vocês têm um problema de estimação de estado sob restrições com evidências heterogêneas e associação de identidade ambígua. Isso aparece em N campos."
Bloco 1 — O framework que unifica tudo: Factor Graphs. Por que muda a arquitetura deles.
Bloco 2 — Transplantes associativos de outras áreas (o coração do pedido): CERN/física de partículas, geoestatística/GP, neurociência/population coding, controle robusto/set-membership, transporte ótimo, teoria de evidência D-S. Cada um com "o problema análogo → o que trazer."
Bloco 3 — Axiomas/princípios organizadores que ele pediu: máxima entropia, mínima ação/caminho, free energy/active inference, MDL/Occam, ajustamento de Gauss.
Bloco 4 — Onde mora o leite de pedra de verdade (a síntese não-óbvia): a ideia de que as RESTRIÇÕES físicas do galpão (paredes, corredores, cinemática humana) são informação massiva e subutilizada; que o mapa deve ser aprendido (GP/SLAM); que associação e localização devem ser resolvidas CONJUNTAMENTE, não em sequência.
Fecho: oferecer consolidar em documento + sugerir por onde começar.
Isso é muito. Mas ele pediu profundidade. Vou ser denso mas legível. Vou evitar que vire uma enciclopédia — cada item precisa ganhar seu lugar com o INSIGHT, não com definição de livro-texto.

Deixa eu começar a pesquisar. Vou rodar as buscas mais importantes.

Idioma da resposta: português brasileiro.

Vou fazer as buscas agora.


Searched the web
Searched the web
Boa primeira leva. Confirma que fusão BLE+outra modalidade está ativa, mas o par específico BLE+câmera para associação de identidade em galpão é menos saturado — há espaço. Vou buscar agora o ângulo mais associativo e não-óbvio: reconstrução de trajetórias em física de partículas (CERN) via GNN, que é estruturalmente idêntico ao problema deles.


Searched the web
Searched the web
O ângulo CERN está confirmado e é forte — reconstrução de trajetórias a partir de hits esparsos via GNN é matematicamente idêntico ao problema deles de reconstruir trajetória de pessoa a partir de detecções BLE/visão esparsas. Agora vou buscar o ângulo de matemática de fronteira patenteável: transporte ótimo (optimal transport) aplicado a data association / tracking, que generaliza o Hungarian que eles já conhecem.


Searched the web
Searched the web
Ótimo — transporte ótimo/Sinkhorn confirmado como a generalização diferenciável do Hungarian, com aplicação direta em MOT e associação track-to-track, inclusive há patente (USPTO). Isso é ouro para o ângulo "matemática avançada patenteável". Agora vou buscar dois ângulos rápidos: (1) o framework unificador — factor graphs / pose graph para fusão, e (2) o ângulo de Gaussian Processes para radio map, que resolve a pergunta deles sobre aprender o mapa de propagação BLE. Vou fazer uma busca sobre factor graphs primeiro.


Searched the web
Searched the web
Excelente — factor graphs confirmados como o framework unificador maduro (GTSAM/iSAM2), com a propriedade-chave: cada sensor é um "fator", asincronia tratada por GP, extensível a qualquer fonte nova. Isso é literalmente o "motor universal de localização" que eles descrevem no documento, mas com nome e matemática estabelecidos. Já tenho material forte para os pilares. Vou fazer uma última busca no ângulo mais "fora da caixa" que ele pediu — princípios de outros domínios (neurociência/active inference, física) aplicados a localização, para enriquecer a seção de "axiomas e lógicas".


Searched the web
Searched the web
Tenho material rico e não-óbvio em todos os ângulos que planejei. Não preciso de mais buscas — os pilares associativos estão bem cobertos (CERN/física de partículas, transporte ótimo, factor graphs, active inference/neurociência, GP para radio maps). Já tenho o suficiente do meu próprio conhecimento para os demais transplantes (set-membership, Dempster-Shafer, máxima entropia, cristalografia, geodésia, etc.).

Agora vou escrever a resposta. Ela precisa ser densa, associativa e útil, em português brasileiro. O usuário quer pensar junto, então respondo conversacionalmente com estrutura moderada, e ofereço consolidar em documento no final. Vou evitar repetir a lista que ele já tem e focar em conexões transformadoras + insights sobre onde mora o valor patenteável.

Deixa eu montar isso com cuidado, respeitando o pedido de "leite de pedra" (o insight real: as restrições e o modelo aprendido é que multiplicam o valor dos sensores fracos).

Vou reafirmar: a resposta deve ser em português brasileiro.Cristhyano, gostei do enquadramento. Antes de sair listando técnicas, vale reformular o problema no nível mais abstrato possível, porque é aí que as conexões com outras áreas aparecem. O que vocês têm não é "um sistema BLE + câmera". É isto:

Estimar o estado oculto de várias entidades, ao longo do tempo, a partir de evidências heterogêneas, ruidosas, esparsas e ambíguas, sujeitas a restrições físicas conhecidas.

Escrito assim, o problema deixa de ser único de vocês. Ele é exatamente o mesmo que o CERN resolve para reconstruir trajetórias de partículas, que a robótica resolve em SLAM, que a geodésia resolve há 200 anos com ajuste de observações, e que a neurociência acha que o cérebro resolve o tempo todo. Cada uma dessas áreas desenvolveu matemática madura para pedaços do seu problema. "Extrair leite de pedra" é isto: importar o ferramental de quem já espremeu essa pedra específica.

Vou organizar por camadas de valor, da mais transformadora (muda a arquitetura de vocês) para a mais exótica (gera propriedade intelectual).

1. O framework que engole tudo: Factor Graphs
Este é o insight mais importante e o que eu abriria a pesquisa. Sua arquitetura atual é um pipeline sequencial: BLE → visão → fusão → estimador. Pipeline vaza informação em cada etapa e é frágil (se a visão falha, a cadeia quebra).

A robótica abandonou isso. O padrão-ouro hoje é o factor graph: um grafo onde os nós são os estados que você quer descobrir (posição da entidade X no tempo t) e as arestas são fatores — cada medição vira uma restrição probabilística. Você não "processa BLE e depois visão"; você joga todas as evidências no mesmo grafo e resolve uma única otimização não-linear conjunta que satisfaz o máximo de restrições simultaneamente.

Por que isso é leite de pedra puro para vocês:

É literalmente o "Motor Universal de Localização" que vocês descrevem na Fase 8, mas com nome, teoria e biblioteca prontos. Cada nova fonte de sensor (BLE, RFID, UWB, LoRa, Wi-Fi, câmera) é só um novo tipo de fator. O motor não muda; você adiciona tipos de aresta. É a materialização matemática exata da filosofia "hardware é fornecedor de evidências".
Trata medições assíncronas naturalmente. BLE chega a 1 Hz, câmera a 30 fps, e a implementação madura resolve isso representando a trajetória em tempo contínuo via regressão por Gaussian Process, permitindo consultar estados em timestamps arbitrários sem exigir sincronização estrita entre estado e medição. Isso mata de graça um problema que normalmente consome semanas.
É robusto a dropout de sensor. Em testes de veículos, uma abordagem de factor graph mantém estimativa de trajetória robusta em áreas urbanas densas onde a fusão multissensor clássica falha por degradação de sensor — exatamente o cenário de vocês quando uma pessoa entra numa zona sem câmera ou de sombra de BLE. 
arxiv
A ferramenta existe e é BSD: GTSAM / iSAM2 (Georgia Tech). É uma biblioteca C++ que implementa fusão sensorial para robótica e visão computacional usando factor graphs, com interface Python. Vocês não escrevem o solver; escrevem os fatores. 
arxiv
Se eu fosse escolher uma aposta arquitetural para o produto, seria essa. Ela reorganiza tudo o que você já tem no documento por baixo de um só formalismo.

2. O transplante mais direto: reconstrução de trajetórias do CERN
Aqui está uma conexão que provavelmente ninguém no time fez, e é quase um mapeamento 1:1.

No LHC, partículas atravessam detectores e deixam "hits" — pontos esparsos de "algo passou aqui". O algoritmo precisa reconstruir qual sequência de hits pertence à mesma partícula, com milhares de partículas simultâneas e hits ambíguos. Troque "hit de partícula" por "detecção BLE/visual" e "partícula" por "pessoa", e é o seu problema de reidentificação e reconstrução de trajetória perdida (suas perguntas 6 e 7).

Como eles resolvem hoje (depois de abandonar os métodos combinatórios que explodem): Graph Neural Networks para track finding. A formulação: dados do detector são embutidos como grafo — nós representam hits, arestas representam segmentos de trajetória possíveis — e classifica-se as arestas como segmentos verdadeiros ou falsos. O motivo de terem migrado para GNN é idêntico ao gargalo de vocês com dezenas de TAGs: os algoritmos de tracking atuais escalam pior que quadraticamente com o número de hits. 
arxiv
arxiv

O que importar concretamente:

O pipeline Exa.TrkX / GNN4ITK: construção de grafo → GNN pontua arestas → filtragem → segmentação em trajetórias. Isso é um blueprint pronto para "conectar detecções esparsas em trajetórias coerentes".
A abordagem mais recente troca o GNN por Transformers para reconstrução de trajetória — mesma ideia, atenção sobre os hits.
Detalhe delicioso de engenharia: eles rodam isso em FPGA com latência dura para o trigger de tempo real. Se vocês algum dia precisarem de edge computing pesado num galpão, o caminho já foi trilhado.
Este é o tipo de referência que vale ouro se vocês quiserem publicar: "aplicamos reconstrução de trajetória de física de altas energias à localização industrial" é uma ponte que rende artigo.

3. A matemática de fronteira e patenteável: Transporte Ótimo
Vocês já têm "Hungarian Algorithm" na lista. O problema do Hungarian é que ele é duro (uma TAG = uma pessoa, decisão binária) e não diferenciável — não dá para treinar de ponta a ponta com deep learning, e ele quebra quando a realidade é ambígua (duas pessoas coladas, uma detecção que poderia ser de dois).

A generalização é a Teoria do Transporte Ótimo (Monge–Kantorovich), resolvida na prática pelo algoritmo de Sinkhorn. Ela faz associação suave e fracionária: em vez de "TAG 412 = Pessoa B", ela produz "TAG 412 está 70% na Pessoa B, 30% na Pessoa C", e essa incerteza propaga corretamente até se resolver com mais evidência. É a matematização exata da sua frase "com 97% de probabilidade".

Por que isso é a peça patenteável:

Substituir o algoritmo Húngaro por transporte ótimo para computar associações globais suaves e eficientes via Sinkhorn, evitando a complexidade cúbica do Húngaro — resolve escala e ambiguidade de uma vez. 
arxiv
É diferenciável. Vira uma camada de rede neural. Você treina o custo de associação BLE↔visão de ponta a ponta com os seus próprios dados de galpão. Isso é exatamente onde mora a defensibilidade: o motor aprende com os dados que só vocês têm.
Já é usado em MOT justamente para o seu caso difícil: uma camada Sinkhorn diferenciável para atribuição ótima, endereçando desafios de oclusão e variação de aparência dos objetos. 
ResearchGate
E — importante para estratégia de IP — já existe patente concedida usando isto: a Normalização Iterativa de Sinkhorn (camada de Transporte Ótimo) como camada de correspondência diferenciável para rastreamento de múltiplos objetos em vídeo. Ou seja: dá para patentear nesse espaço, mas vocês precisam mapear o prior art antes de reivindicar. A janela de vocês está na combinação específica BLE+visão+restrições de galpão, não no Sinkhorn em si. 
ResearchGate
A versão avançada que eu investigaria: Unbalanced Optimal Transport, que lida com o caso realista de que o número de TAGs e o número de pessoas detectadas não batem (gente sem crachá, crachá de item parado, detecção fantasma). Isso é a variante que a literatura recente usa para "objetos que aparecem e somem".

4. Transplantes de outras áreas (o coração do pedido associativo)
Estes são os "espremer a pedra" menos óbvios. Para cada um, o padrão é: uma área resolveu um subproblema seu com matemática que você não olharia por default.

Controle robusto → Estimação por conjuntos (set-membership / zonotopos). Toda a literatura probabilística estima um ponto mais provável. Mas vocês têm uma arma que sistemas RTLS puros não têm: paredes. Uma pessoa não atravessa uma prateleira; não pode estar em dois corredores ao mesmo tempo; tem velocidade humana máxima. A teoria de estimação por conjuntos não pergunta "onde é mais provável?", pergunta "qual é o conjunto de todas as posições fisicamente consistentes com todas as restrições?". Você intersecta o cone de visão da câmera, a zona grosseira do BLE, e o polígono navegável do mapa — e o resultado é uma região garantida, não uma aposta. Isso transforma restrições físicas (que vocês tratam como coadjuvantes) na fonte primária de informação. Para um galpão cheio de geometria dura, isso é subexplorado e poderoso.

Geoestatística/mineração → Gaussian Processes para o mapa de rádio (kriging). Sua pergunta 4 ("como aprender o mapa de propagação BLE?") tem resposta madura vinda da mineração: o RSSI em cada ponto é um campo espacial contínuo com incerteza. GP regression (kriging) aprende esse campo e devolve a incerteza calibrada em cada ponto — que é justamente o peso que você precisa para a fusão. O mapa de propagação deixa de ser fixo e passa a se autocalibrar conforme o galpão muda (sua pergunta 3, calibração automática). Nota que isso reaparece nos factor graphs modernos, fechando o ciclo com o item 1.

Neurociência → Active Inference / Princípio da Energia Livre. Isto é filosofia e método, e casa quase poeticamente com sua frase "não localizar sinais, localizar entidades". A hipótese do cérebro bayesiano diz que o cérebro mantém um modelo generativo do mundo, prevê observações sensoriais futuras e minimiza constantemente o erro de predição ou "surpresa", ou atualizando o modelo, ou inferindo ações que levem a estados menos surpreendentes. Aplicado a vocês: o motor mantém uma expectativa de onde cada entidade deveria estar, e cada leitura de sensor só importa na medida em que surpreende essa expectativa. Sensor que confirma o esperado carrega pouca informação; sensor que surpreende carrega muita. Frameworks recentes de robótica usam isso para unificar mapeamento, localização e tomada de decisão dentro de um único modelo generativo, inspirado na navegação hipocampal, usando raciocínio topológico e codificação por place-cells. É um arcabouço unificador que, além de matemática, dá uma narrativa científica forte para o produto. 
arXiv

Cristalografia / tomografia → reconstrução 3D a partir de projeções. Sua homografia câmera→planta é um caso particular de um problema que a cristalografia e a tomografia médica resolvem em alta dimensão: reconstruir a estrutura real a partir de projeções 2D parciais. Se vocês forem para múltiplas câmeras com sobreposição, o ferramental de reconstrução tomográfica (como combinar projeções inconsistentes numa estrutura única coerente) é diretamente relevante para fundir campos de visão.

Geodésia (Gauss, 1809) → ajuste de observações redundantes. O avô de tudo isto. Quando você tem mais medições do que incógnitas e todas discordam um pouco, a geodésia formalizou como combinar observações redundantes com pesos por confiança em uma solução de mínimos quadrados — e, crucialmente, como detectar a observação inconsistente (sua pergunta 8). A teoria de data snooping / confiabilidade da geodésia é um método pronto para "detectar quando um sensor está mentindo".

Teoria da Evidência (Dempster–Shafer). Uma alternativa a Bayes para quando você não confia nas suas próprias distribuições de erro. Bayes exige que você conheça as probabilidades; D-S deixa você representar ignorância explícita ("não sei o suficiente para opinar sobre esta TAG"). Em fusão de sensores heterogêneos onde você não tem estatística boa de cada um ainda, é frequentemente mais honesto e robusto que Bayes ingênuo.

5. Os "axiomas" — princípios organizadores que ele pediu
Você pediu axiomas e lógicas, não só algoritmos. Estes são princípios que dão coerência ao motor inteiro e servem como as leis fundamentais do sistema:

Máxima Entropia (Jaynes). Quando faltar informação, assuma a distribuição menos comprometida compatível com o que você sabe. É o axioma anti-viés: impede o motor de "chutar com confiança" onde não tem dados. Não à toa, o Sinkhorn do item 3 é literalmente transporte ótimo sob máxima entropia — o mesmo princípio reaparece.

Mínima Ação / caminho eficiente. Emprestado da física. Pessoas e empilhadeiras não se teleportam nem fazem zigue-zague sem motivo; tendem a caminhos eficientes. Isso vira um prior de movimento forte que preenche as lacunas quando os sensores calam — é o que reconstrói a trajetória durante a oclusão.

Navalha de Occam / MDL (Minimum Description Length). Entre duas trajetórias que explicam os mesmos dados, prefira a mais simples. Formaliza "não invente trajetórias malucas para encaixar ruído". É o regularizador natural contra o overfitting de trajetória.

Minimização de surpresa (energia livre). O princípio unificador do item 4, elevado a axioma do sistema: o motor age para reduzir a discrepância entre o que prevê e o que mede. Percepção e predição viram o mesmo processo.

Onde realmente está o leite
Se eu tivesse que destilar tudo em três teses que separam "mais um RTLS" de "motor de inferência com IP defensável":

A informação mais valiosa de vocês não são os sensores — são as restrições. Paredes, corredores, cinemática humana e o layout do galpão carregam mais bits do que o BLE. Sistemas que só fundem sinais jogam isso fora. Set-membership + factor graphs com fatores de mapa exploram isso. Essa é a assimetria que sensor barato + matemática boa exploram para bater hardware caro.
O mapa tem que ser aprendido, não configurado. Propagação BLE (GP/kriging), zonas de cobertura e padrões de fluxo devem se autocalibrar continuamente. Um motor que melhora sozinho com o uso é um fosso competitivo; um que exige recalibração manual é um custo.
Associação e localização têm que ser resolvidas juntas, não em sequência. Quem é quem e onde está cada um são o mesmo problema. Transporte ótimo diferenciável dentro de um factor graph resolve os dois de uma vez, e é exatamente aí que mora a novidade patenteável — na combinação específica aplicada a BLE+visão+galpão, não em nenhuma peça isolada.
Uma nota honesta sobre IP, já que você mencionou patentes: cada peça individual acima (Sinkhorn, GNN tracking, factor graphs, GP maps) já tem literatura densa e, em alguns casos, patentes concedidas. O espaço defensável de vocês é a arquitetura integrada e o domínio específico — não reivindicar "usamos transporte ótimo", mas "sistema de fusão BLE-visão com associação por transporte ótimo restrito por geometria de galpão e mapa de propagação auto-aprendido". Antes de investir em redação de patente, vale um levantamento sério de prior art nesses cruzamentos.

Quer que eu consolide isto num documento de estratégia de pesquisa estruturado — com as referências, um mapa "pergunta de pesquisa de vocês → área que resolve → método a importar", e uma ordem sugerida de ataque? Ficaria no formato do seu "Visão Técnica Consolidada". Ou, se preferir continuar explorando aqui, posso aprofundar qualquer um desses ramos — o de factor graphs e o do CERN são os que eu cavaria primeiro.