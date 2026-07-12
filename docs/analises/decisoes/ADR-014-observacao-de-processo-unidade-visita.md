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
- **A identidade se decide no MOVIMENTO (gradiente diferencial, cancela o viés) e se conserva na
  TOPOLOGIA (zona = contêiner), nunca no rádio parado.**
- **A câmera faz 70-90% do trabalho útil**; o BLE é identidade nos momentos informativos; o
  **workflow é a única evidência independente do rádio** — a peça mais valiosa ainda não construída.
- **O maior ativo é o aparato de medição** (matou 5 teses, 3 do próprio especialista) — proteger
  acima de tudo.

Maturidade honesta: **TRL 3-4** — princípio físico provado em campo (−0,91), produto industrial
NÃO provado. Não vender como pronto.

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
     BALANÇO de entradas/saídas, não pelo tracker. Degrada com elegância (ambiguidade fica local
     à zona, não global à fábrica).
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

## Consequências

- **Lista de parada** (economiza meses, não fazer): RSSI→metros para decidir; retomar v4;
  factor graph/GTSAM (estado é discreto — Petri+HSMM é o formalismo); GNN/Sinkhorn/GP completo/
  transformer antes das Ondas 0-2 fecharem; prometer posição métrica por BLE; vender "AoA barato"/
  "universal" (exige cobertura visual); deixar o sistema concluir "ocioso".
- **Factor graph (ADR-013 T1) reclassificado**: era a resposta certa para a pergunta errada
  (estado contínuo). Só volta se o cliente exigir posição métrica contínua — o que ele NÃO exige.
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
