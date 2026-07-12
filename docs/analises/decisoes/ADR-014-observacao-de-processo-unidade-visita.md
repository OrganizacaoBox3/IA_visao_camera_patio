# ADR-014 — O produto é observação de processo com identidade probabilística; a unidade é a VISITA, não o tick

Data: 2026-07-11 · Status: aceito · Origem: parecer final consolidado do especialista (após a
revelação do objetivo do cliente). Supera, na direção principal, o ADR-012 (abordagem científica)
e recontextualiza o ADR-013 (motor universal) — que continua válido como fundação de fusão.

## Contexto

O cliente não quer coordenadas. Quer saber se **o operador está na mesa fazendo o trabalho ou
ocioso**, sabendo que ele circula e precisa ir a pontos específicos. Todo o sofrimento do arco veio
de tratar isto como problema de LOCALIZAÇÃO (estado contínuo x,y, erro em metros, precisão por
frame) quando é problema de **CONFORMIDADE OPERACIONAL** (estado discreto: zona/etapa; erro em
eventos e durações; precisão por VISITA).

O parecer é inequívoco e sustentado por evidência medida neste próprio repositório:
- **RSSI absoluto está morto para decisão** — prova de campo: 4 âncoras equidistantes leem 15 dB
  diferentes; uma âncora a 0,78 m lê o mesmo que outra a 2,05 m. Se tags fixas equidistantes não
  se separam, tags no corpo jamais se separam. (Mata: v4, trilateração, proximidade por RSSI médio.)
  **Precisão de escopo (2º revisor)**: RSSI absoluto está refutado para DECISÕES DE IDENTIDADE,
  PROXIMIDADE E DISTÂNCIA MÉTRICA — não para tudo. Ainda serve como AUDITORIA (receptor desligado,
  variação extrema, saúde de tag de referência, degradação do ambiente) e como feature auxiliar
  que não decide sozinha. "Morto para decidir", não "morto".
- **A identidade se decide no MOVIMENTO (gradiente diferencial, cancela o viés) e se conserva na
  TOPOLOGIA (zona = contêiner), nunca no rádio parado.**
- **A câmera deve fornecer a MAIOR PARTE da informação operacional útil** (avaliação arquitetural,
  proporção ainda não medida — o "70-90%" é expectativa, não medição); o BLE é identidade nos
  momentos informativos; o **workflow é a PRINCIPAL fonte contextual independente do rádio ainda
  NÃO explorada** — não a única (ReID visual, eventos de fronteira, escala, ordem, PLC, scanner
  também são independentes). É a peça de maior valor ainda não construída.
- **O maior ativo é o aparato de medição** (matou 5+ teses, a maioria do próprio especialista) —
  proteger acima de qualquer algoritmo. "O que sobreviveu não sobreviveu por ser bem defendido —
  sobreviveu por resistir ao aparato." A única recomendação com força absoluta.

Maturidade honesta: **TRL 3-4** — princípio físico provado em campo (−0,91), produto industrial
NÃO provado. Não vender como pronto. **Se H1 e H2 passarem, a arquitetura terá fundamento
suficiente para avançar ao MVP multioperador — NÃO "fecha"**: ainda faltam vários operadores,
cruzamentos, dias distintos, posições de tag/corpo/vestimenta, galpão real com metal/máquinas,
estabilidade prolongada e taxa de falso-alerta operacional.

## Decisão

1. **A unidade do produto é a VISITA operacional** (aproximação + entrada + permanência + saída +
   consolidação), não o tick de 500 ms. Toda métrica migra para a unidade da decisão do cliente
   (regra institucionalizada nº 7).
2. **Arquitetura de 5 camadas** (o ciclo de vida de uma visita):
   - (1) Observação visual — trajetória/zonas/fronteira/permanência/postura (homografia+tracker,
     existe).
   - (2) Identidade probabilística — associar tag↔track↔zona por correlação Fisher-z **na
     aproximação** + prior de workflow; distribuição, não fato.
   - (3) Conservação de identidade — **rede de Petri** (zonas=places, operadores=tokens,
     cruzamentos=transições): mantém identidade na permanência e através de mortes de track por
     BALANÇO de entradas/saídas, não pelo tracker. **Precisão (2º revisor)**: a conservação
     preserva o CONJUNTO de identidades presentes na zona, não o vínculo individual track↔pessoa.
     Com UMA pessoa, o conjunto determina a identidade; com N, a topologia conserva {A,B,C} mas
     não decide qual novo track é qual. **Delta do especialista — a granularidade da zona é o
     parâmetro de projeto que controla essa ambiguidade, e o problema do cliente tem a estrutura
     de presente**: ele pergunta sobre a MESA (posto), não sobre o corredor. Desenhar zonas na
     granularidade do POSTO de trabalho (uma pessoa) → conservação forte exatamente onde a
     pergunta comercial vive; no corredor a conservação é fraca, e não importa (ninguém trabalha
     no corredor). Regra de projeto de zona: granularidade do posto, não da área.
   - (4) Estado operacional — **HSMM com duração explícita** (deslocando/na-mesa/aguardando/
     inatividade-possível/não-observado): o detector de anormalidade por duração.
   - (5) Conformidade + evidência — **conformance com eventos incertos** (saída em LIMITES
     superior/inferior, não ponto) + **evento objetivo de processo** (PLC/scanner/ordem) para
     afirmar produtividade, não só presença.
3. **A agregação por episódio NÃO é ingênua**: janela deslizante de 8 s a 500 ms/tick compartilha
   15/16 dos dados entre decisões consecutivas — não são 9 evidências, é ~1 repetida. O ganho real
   vem de: (a) UMA decisão sobre a janela do episódio INTEIRO; (b) span radial maior (receptor no
   destino); (c) prior de workflow. **Isto corrige o event-metrics.ts atual** (que agrega falas
   por tick — Fase 1 abaixo refaz com janela única).
4. **A 2ª antena é amplificador de gradiente NO DESTINO** (não trilateração, não dimensão de
   assinatura no centro): a inclinação da log-distância é máxima perto do receptor; caminhar 8→1 m
   de um receptor NA MESA dá ~0,9 década de span (vs 0,42 medido hoje) — mais que dobra a
   informação, e o episódio termina onde o cliente quer registrar.
5. **Persistência de rótulo v1 é substituída, em grande parte, por conservação de zona** — não
   retomar antes de medir quanto do problema (identidade na permanência) sobra depois da topologia.
6. **A tese "restrições carregam mais bits que o BLE" ressuscita CORRIGIDA**: não são paredes
   (geometria) — são **topologia de zonas e sequência de processo**.
7. **PRÉ-REQUISITOS DE INSTALAÇÃO (deltas do especialista — matam o piloto em silêncio se ignorados)**:
   - **Δ3 GEOMETRIA — o mais perigoso**: todo o mecanismo depende de variação RADIAL. Receptor
     instalado AO LADO da mesa → caminhada tangencial → variação radial ≈ 0 → identidade nunca
     fecha, e a equipe passa semanas investigando o algoritmo enquanto o bug está no suporte da
     parede. **Regra dura: o receptor vai NO DESTINO ou ATRÁS dele, sobre o eixo do caminho
     dominante de aproximação** (caminhar até a mesa = caminhar em direção ao receptor = gradiente
     máximo). Otimizável no simulador ANTES de furar parede (simular os caminhos reais contra
     posições candidatas e maximizar o span radial esperado em décadas — uso legítimo da bancada,
     sem circularidade, é geometria pura).
   - **Δ4 CADÊNCIA — pré-requisito, já resolvido**: inter-arrival de ~2s → n_eff magro (3-5) limita
     TODO mecanismo da arquitetura simultaneamente. Diagnosticado (POST do app, não a tag/scanner)
     e CORRIGIDO (2000→500ms, validado: 543ms medido). Nunca interpolar RSSI (infla n, enviesa r).
8. **Δ5 — a SAÍDA não é evidência simétrica à chegada; a contradição é DIAGNÓSTICO**: se chegada e
   saída discordam AMBAS com força, não é "visita inconclusiva" — é a assinatura de um ID-SWITCH
   durante a permanência. Deve levantar BANDEIRA na camada de conservação (saúde do tracker), não
   só marcar a visita. É exatamente o sinal para calibrar H2.
9. **Δ2 — a regressão RSSI = β + θ·(−log₁₀ d) + ε libera um 2º discriminador GRÁTIS: a inclinação θ**.
   O ranking por Pearson é invariante a β/θ (afim), mas θ tem significado físico (≈10n ~22dB/década)
   para o par VERDADEIRO e não tem motivo pra cair perto disso num par espúrio de |r| alto por
   acaso. RESSALVA anti-v4: NÃO fixar θ≈22 por teoria (o viés corporal direcional infla a inclinação
   aparente — foi o que a curva não-monotônica mostrou); MEDIR a distribuição empírica de θ dos
   pares verdadeiros na caminhada ANOTADA e usá-la como filtro. Se sair larga/instável, descartar —
   falseável, barato, não-circular.
10. **Δ1/gate — o gate NÃO é "precisão de visita ≥ 95%"** (número de NEGÓCIO, não de física: acusar
    ociosidade exige 99%, relatório de fluxo vive com 85%). **O gate é CALIBRAÇÃO** (o reliability
    diagram, que já existe): se o sistema diz 90% e acerta 90%, a precisão vira um DIAL — escolhe-se
    o limiar por caso de uso e a cobertura segue. Se diz 90% e acerta 60%, nenhum limiar salva.
    Precisão é consequência; calibração é o gate.
11. **Controle negativo CORRETO (não repetir o erro do shuffle-baseline)**: para provar que r alto =
    sinal físico, o surrogate é o DESLOCAMENTO TEMPORAL CIRCULAR por tag (preserva valores/marginais/
    autocorrelação, destrói o alinhamento), com controle positivo embutido (precisão sob shift
    DESABA para chute). Embaralhar nomes de tag é estruturalmente cego (permutação de coluna —
    provado em shuffle-baseline.ts).

## Consequências

- **Lista de parada** (economiza meses, não fazer): RSSI→metros para decidir; retomar v4;
  factor graph/GTSAM (estado é discreto — Petri+HSMM é o formalismo); GNN/Sinkhorn/GP completo/
  transformer antes das Ondas 0-2 fecharem; prometer posição métrica por BLE; vender "AoA barato"/
  "universal" (exige cobertura visual); deixar o sistema concluir "ocioso".
- **Factor graph (ADR-013 T1) reclassificado — arquivado por ROI/maturidade, NÃO por
  impossibilidade formal** (correção do 2º revisor): factor graphs representam variáveis discretas
  e modelos híbridos também, então "o estado é discreto, logo não serve" é exagero. A formulação
  correta: é tecnicamente possível mas desnecessariamente complexo para o próximo estágio; rede de
  Petri + inferência probabilística + HSMM representam melhor o problema atual com MENOR custo de
  implementação e validação. Só volta se o cliente exigir posição métrica contínua (não exige).
- **Ondas com gate** (ver PENDENCIAS.md): Onda 0 (hoje, sem hardware — re-scoring por visita +
  tracks estáticos + fronteira, decide H1/H2) → Onda 1 (receptor de zona) → Onda 2 (zonas+Petri+
  workflow) → Onda 3 (HSMM+conformance) → Onda 4 (evidência objetiva).
- **Duas regras institucionalizadas novas**: nº 6 (RSSI absoluto para decidir → a tabela das 4
  âncoras vai à mesa ANTES da discussão) e nº 7 (toda métrica na unidade da decisão do cliente).
- **Posicionamento/IP/jurídico**: produto = inteligência operacional/conformidade de processo, não
  vigilância; o mecanismo de associação é patenteado (US 9772395/…) mas a novidade migrou para
  cima (troca de regime, workflow como identidade, incerteza→conformidade com limites); a
  invariante "rótulo errado é pior que nenhum" é o escudo LGPD/trabalhista (o humano decide, o
  sistema nunca conclui "ocioso").
- **Critério de pivô honesto**: se a Onda 0 refutar H1 E H2, ou a Onda 1 não der ganho por visita,
  abandonar identidade contínua por rádio → câmera como twin principal + BLE só em portais +
  evidência local forte (NFC/scanner/botão) + UWB só onde o cliente pagar.
