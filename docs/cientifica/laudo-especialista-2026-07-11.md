# Laudo consolidado — o material original × tudo que foi testado × o que resta (2026-07-11)

> **Para o especialista.** Um arquivo só, cobrindo o arco inteiro: o que o seu material propôs, o
> que foi construído e medido, o que funcionou, o que funcionou a princípio e caiu em revisão, o
> que foi refutado, o que nunca foi tentado (e por quê), e as pendências abertas — com espaço
> explícito para novas tentativas e métodos. Realista e pragmático por regra da casa: sem
> evidência, não há "pronto"; achado negativo tem o mesmo status que positivo. Fontes primárias
> citadas ao fim; números reproduzíveis por seed/comando.

## 0. Estado em uma frase

**A física central do seu material — correlação RSSI×distância identificando quem é quem — foi
validada com corpo real em campo (2026-07-11, correlação até −0,91 entre a pista da câmera e a
tag carregada), depois de duas noites em que o funil de diagnóstico, construído sob sua
prescrição, localizou e removeu três assassinos em sequência (bug de wiring → calibração em
unidade errada → knob de movimento impassável); em volta dela, o seu roadmap de engenharia
(harness antes de algoritmo, motor puro, replay determinístico) está integralmente executado, o
seu roadmap científico pesado (GTSAM/Sinkhorn/GNN/GP) está deliberadamente adiado com gates
quantitativos, e duas das suas teses centrais foram RECALIBRADAS pela evidência — uma por você
mesmo, outra pelo harness.**

## 1. As teses centrais do material — veredito por tese

### T1. "Factor graph é o insight mais importante; a aposta arquitetural" (base.md §1)

**Status: adiado de propósito, com a fundação pronta — não refutado, não adotado.**
O ADR-012 registrou a decisão: a trilha GTSAM/Python é PESQUISA à parte; adotamos já o subconjunto
barato em JS (contrato de evidência, replay, motor puro — exatamente os "três insumos" do seu
dev.md §0). O que a evidência acumulada diz hoje: a arquitetura real que emergiu (câmera = ONDE
via homografia; BLE = QUEM via correlação) **não tem BLE votando em posição métrica** — o
pressuposto nº 1 do edifício factor-graph (fator BLE de alcance) não se sustenta com 1 estação
(anel isotrópico, spike de 2026-07-08: SNR≈1 para separar 3-6 pessoas). O factor graph volta a
ser a aposta certa **quando** houver multi-estação (aí o BLE vota em posição) — está gated por
hardware, não por descrença.

### T2. "A informação mais valiosa são as restrições — paredes carregam mais bits que o BLE" (base.md, tese E1)

**Status: RECALIBRADA por você mesmo (2026-07-10), confirmada pelo harness.**
Você assumiu: essa promessa valia para a arquitetura onde BLE também vota em posição. Na
arquitetura real, o ∩navegável não alimenta a associação (a posição de quem é visível já vem
certa da câmera; o anel de 1 estação não tem direção para vetar). Reclassificado como item de
**produto** (anéis visualmente honestos — a geometria pura está pronta em `floor-polygon.ts`,
100% testada, sem UI ainda). Volta a ser alavanca de precisão com estimador de posição não-câmera.

### T3. "Associação e localização juntas — Sinkhorn/OT é o núcleo patenteável" (base.md §3, tese E3)

**Status: RECALIBRADA por você + refinada pelo harness; o degrau correto está definido e gated.**
O harness mediu o Hungarian puro: **PIOR que o guloso** (wrong 642 vs 612) — otimalidade global
sem guarda de ambiguidade viola a invariante "rótulo errado é pior que nenhum" (maximizar soma
força pares medíocres). Sua recalibração: o degrau não é Sinkhorn standalone, é **atribuição com
abstenção dentro da otimização** (dustbin/SuperGlue, unbalanced OT — que o seu próprio material
já apontava para o caso nº tags ≠ nº pessoas). O gatilho quantitativo que você pediu existe e
está alto (conflictRate 46,9% no canônico, 90-98% em multidão), mas o experimento está
**corretamente sequenciado atrás da persistência de rótulo** (que muda a paisagem de conflito que
o custo do dustbin calibraria). Nada disso morreu — está na fila com critério de entrada.

### T4. "Contrato de evidência + harness antes de qualquer algoritmo; o investimento com maior retorno" (dev.md §3/§13)

**Status: EXECUTADO INTEGRALMENTE — e foi de fato o maior retorno.**
A prescrição foi seguida à risca e pagou em cascata: o harness revelou a violação da invariante
no caso ambíguo (bloco 60,8%, 20 id-switches), quantificou um bug de produção (−32 pts por
stationPx ausente), derrubou a v4 (abaixo), reprovou a persistência v1, e o replay sobre gravação
real diagnosticou o rótulo mudo **sem nova ida a campo**. Cada função de "verdade para aprender"
que o dev.md pediu existe: gravador opt-in com meta de versão/knobs, loader fiel à produção,
simulador determinístico, métricas de identidade, e agora player + anotação de `SessionTruth`.

## 2. Tabela-mestre: mecanismo proposto × status × evidência

| Mecanismo (material original) | Status | Evidência/motivo |
|---|---|---|
| Harness de replay + event sourcing + simulador (dev §3) | ✅ FEITO por inteiro, na ordem prescrita | 12 cenários pinados no CI; gravador de campo; loader; famílias com IC |
| Motor puro (estado,evidências)→estado (dev §4) | ✅ FEITO | todos os motores são funções puras, replay determinístico, zero Math.random |
| LGPD by design / borda: vídeo não viaja (dev §7) | ✅ FEITO | nenhum frame persistido; só metadados; gravação opt-in |
| Homografia câmera→planta | ✅ FEITO, produção | calibração na instalação; validada em campo (após episódio de unidade errada — §5) |
| Cold-start física→aprendido (dev §6, G9) | 🟡 PARCIAL | log-distance + fit contínuo pelas âncoras (`fitPathLoss`, regime anchors-offset declarado); GP completo pendente |
| Auto-auditoria NIS (dev §1, G2) | 🟡 PARCIAL | resíduo por âncora na UI (NIS-lite); drift da refTag; NIS formal por fonte pendente |
| Identidade como hipótese (dev §5, G7) | 🟡 PARCIAL | Assignment carrega confiança e abstém; máquina de estados de crença construída (persistência); versionamento/event-sourcing de identidade pendente |
| Filtering + smoothing, duas respostas (dev §2, G4) | ⬜ SÓ FILTERING | smoother pendente; a DEFINIÇÃO do episódio-pseudo-label já está em código |
| Smoother como rotulador (dev §6, G8) | ⬜ NÃO TENTADO | gated: exige gravar decisões do associador (roda no cliente; canal novo não construído sem necessidade validada) |
| ts de captura na borda (dev §2, G3) | ⬜ LIMITE FÍSICO documentado | o payload do TC22 não tem timestamp de dispositivo — sem o que carimbar; formato futuro definido |
| Set-membership ∩navegável (§3 do caderno, C1) | 🟡 GEOMETRIA PRONTA, recalibrado a produto | `floor-polygon.ts` puro/testado; sem UI; ver T2 |
| GP/kriging radio map (§5, C2) | ⬜ NÃO TENTADO (ordem-zero existe) | exige âncoras log-espaçadas (span atual 0,7-1,6m — pendência física nº 6) |
| Sinkhorn/OT (§4, B8) | ⬜ NÃO TENTADO; degrau redefinido | ver T3 — dustbin gated atrás da persistência |
| Hungarian (degrau clássico) | ✅ TESTADO → ❌ REJEITADO como default | wrong 642 vs 612 do guloso; knob `optimal` existe, OFF |
| Mixture factors / associação no grafo (B5) | ⬜ NÃO TENTADO | gated com o factor graph (T1) |
| GNN de poda (§6, B7) | ⬜ NÃO TENTADO | o próprio roadmap condiciona a "contagem de TAGs crescer" — hoje 5 tags |
| Kernel robusto Huber (§7, B4) | ⬜ NÃO TENTADO | o associador usa guardas discretas (minSamples/minMovement/top-2) no lugar; mediana curta pré-correlação anotada como mitigação futura p/ multipath móvel |
| Kalman/prior de movimento na oclusão (§2) | 🟡 PARCIAL | ByteTrack tem modelo p/ caixas; o associador indoor não prediz na oclusão |
| Fusão por covariância (§1) | ⬜ NÃO TENTADO como mecanismo | o contrato de evidência ainda não carrega covariância por medição |
| Spike GTSAM (F1) | ⬜ ADIADO deliberadamente (ADR-012) | o harness JS cumpriu o papel de validar a arquitetura em escala de brinquedo |
| Digital twin / MPC / tomografia / D-S / active inference | ⬜ FORA | mesmos cortes que você fez no caderno |

## 3. O que FUNCIONOU (com números)

1. **A física central, em campo** (2026-07-11): correlação RSSI×distância com corpo real chegou a
   **−0,91**, repetidamente, entre a pista do dono e a tag carregada — 28 falas no replay
   contrafactual da caminhada. A cascata a jusante comportou-se: âncoras paradas morrem
   honestamente em série-constante; a guarda de margem filtra empates. Primeiro dado que separa o
   sistema de "funciona no simulador".
2. **A guarda de ambiguidade top-2** (`minMargin 0,1`, torneio com regra a priori): erros da suíte
   −46%, id-switches 59→6, bloco 60,8→82,0% de precisão — a invariante do dono ("rótulo errado é
   pior que nenhum") virou mecanismo. Preço deliberado: cobertura.
3. **Exclusão de âncoras** (o ganho REAL da v4, isolado pela decomposição): falsos-rótulos de
   âncora 73→1 e 78→0 — capturado por um mecanismo imune a viés de RSSI (âncora cadastrada nunca
   é candidata), sem modelo de propagação no caminho.
4. **O funil de diagnóstico** (sua prescrição "instrumentem o funil, não o score"): localizou o
   assassino do rótulo mudo em minutos, offline, duas vezes (calibração em unidade errada:
   movVar máx 0,214 vs gate 0,25, ZERO falas em 9.877 avaliações; depois o próprio gate:
   movVar máx 0,228 vs 0,25 com calibração boa). Ferramenta permanente (`npm run funnel`).
5. **Mudança de default pelo rito completo** (`minMovement` 0,25→0,15): evidência dupla (campo:
   contrafactual falou; sintético: neutro no agregado, `parado` segue 100% abstenção), gates
   re-pinados conscientemente.
6. **A sentinela dupla da persistência confirmou sua previsão quantitativamente**: erro-segundos
   em memória da sentinela durante-memória (14,5s) > 2× a da confirmação (6s); e o achado mais
   fino — a crença que **nasce já errada** (confirmação fechada por evidência anterior à troca) —
   virou a emenda v2 que você propôs (janela de confirmação limpa).
7. **Previsão (c) da bancada CONFIRMADA e transformada em sensor de CI**: erro de cadastro de
   âncora (0-2m) não move a precisão de identidade (86,5% flat, decomposição bit-idêntica) —
   coerente com gate/blend OFF; se voltarem aos defaults criando o acoplamento, o CI acusa.
8. **Mineração passiva como substituto parcial de campo**: atenuação corporal ~12,5dB (dentro do
   seu envelope 4-10 médio/pico ~20), autocorrelação 0,49-0,94@2s (ruído real NÃO é IID — virou o
   AR(1) opt-in do simulador), 66-72% das quedas são locais (valida o resíduo-por-âncora),
   fragmentação de tracks → timeout ~12s da persistência.

## 4. O que FUNCIONOU A PRINCÍPIO e CAIU em revisão (as retratações — o processo funcionando)

1. **v4 (distância absoluta via âncoras)**: aprovada em torneio honesto (wrong 546→411, precisão
   70,8→75,4%) e **derrubada pela revisão adversarial** — circularidade sim↔fit (com −6dB de viés
   corporal só nas pessoas, despencou para 26% precisão/1,8% cobertura) + decomposição (todo o
   ganho era âncora-fora-do-jogo; wrong pessoa↔pessoa SUBIU 23%). Gate/blend viraram knobs de
   pesquisa OFF com 2 sentinelas de viés permanentes. → Regras institucionalizadas nº 1 e 2.
2. **Curva ×viés corporal da bancada ("84%→14,7%, o eixo mais agressivo")**: RETRATADA — o sinal
   do bodyBias estava invertido NO SEU PRÓPRIO DOC (§4 do simulador.md somava; atenuação subtrai;
   o dev implementou fielmente a fórmula errada). Re-medida: **não-monotônica** (84→~90% em
   4-12dB → 80,4% em 24dB) — viés direcional moderado REFORÇA a correlação. → Regra nº 5 (sanidade
   direcional em fórmula de spec). A exploração como *feature* está registrada como direção
   **condicionada à confirmação física** (trajeto radial ida-e-volta no hello world), proibida de
   tornear no sim antes — pela anatomia exata da v4 que você descreveu.
3. **"O joelho aparece na decomposição" (curva ×pessoas)**: RETRATADA pela normalização — o wrong
   10→87 era crescimento de denominador (decisões ×3,5); a taxa satura (2,4%→platô ~5,5%,
   côncava). Sua previsão (b) fica **mais próxima de refutada** — e o seu post-mortem apontou a
   lente certa: **num sistema com abstenção, colisão vira silêncio, não erro**. Corolário
   verificado: a cobertura decai GEOMETRICAMENTE (razão 0,846±0,030 por pessoa, 2→7) — exponencial
   sem joelho. É o mesmo fenômeno que reprovou a persistência em multidão (margens comprimem).
4. **Persistência de rótulo v1**: escopo aprovado por você com 3 mordidas (todas incorporadas),
   mecanismo saudável (conversão abstenção→acerto 239.500ms >> 10× a regressão), e **REPROVADA no
   próprio torneio**: erro-segundos passa (209.000→95.500ms) mas cobertura de experiência CAI
   (20,84→13,88%, 0,67×) — a barra `margem≥0,4 × 3 ticks` nunca fecha em multidão. Seu plano de
   retuning (precisão-implicada condicionada por regime + grade (P*,K) + janela limpa) está
   registrado e é a próxima rodada dessa frente.

## 5. O que NÃO FUNCIONOU / foi refutado

1. **Hungarian puro**: piora o guloso (ver T3). Registrado como achado que refina a prescrição.
2. **Shuffle-baseline (sua previsão (a) da rodada de conflito)**: FALSEADA por prova matemática —
   permutar nomes de tag é permutação de colunas da matriz de score; margem top-2 é invariante.
   O desenho era estruturalmente cego à pergunta. Você assumiu o erro de nível de abstração; o
   surrogate correto (deslocamento temporal circular, com controle positivo) está arquivado com
   prioridade baixa. → Regra nº 4.
3. **A trilha outdoor inteira (v0→v3, RMSE 24,4→14,35m)**: funcionou como engenharia, modelava o
   problema errado (GPS/AirTag; o problema real é indoor sem GPS). Re-rotulada; o andaime foi
   reaproveitado pela trilha certa. Teto físico provado lá (4/9 cenários com ganho ótimo de
   extrapolação = 0) antecipou a lição: o caminho além de 1 estação é hardware, não esperteza.
4. **Primeira tentativa de campo (2026-07-10)**: fracasso em 3 camadas descoberto em 2 noites —
   bug de wiring (grade MJPEG sem fusão; corrigido), calibração em unidade errada (cena projetava
   0,9×1,3"m"; gate fisicamente impassável), e o knob `minMovement` do galpão sintético 8×6m
   impassável em sala real 4×5m. Cada camada só apareceu porque a anterior caiu — o argumento
   definitivo pela instrumentação de funil que você prescreveu.

## 6. Pendências abertas (status honesto, prioridade prática)

1. **Hello world formal — o último passo é do dono**: repetir a caminhada com o default novo no
   ar, ver o rótulo na tela, gravar, anotar no player (UI pronta), processar. A mesma caminhada
   paga 3 contas: verdade anotável, viés corporal real, teste direcional (perna corpo-entre:
   RSSI 4-12dB menor E |r| maior que a perna livre).
2. **Retuning da persistência** com o seu plano (não executado ainda) → novo torneio (régua
   pinada) → revisão adversarial → só então candidata a default.
3. **Dustbin/OT-com-abstenção**: gated atrás do item 2 (re-medir conflictRate com persistência
   ligada antes de calibrar o custo).
4. **Cadência BLE (assassino nº 2, real e não fatal)**: inter-arrival ~2,06s → ~3,9 leituras
   distintas por janela de 8s; produz série-constante e dilui r. Pendências: `windowMs`/
   `minSamples` contarem leituras DISTINTAS; `minMovement` escala-aware; validação de unidade na
   UI de calibração (produto).
5. **Gravação das decisões do associador por tick** (pré-requisito do smoother-rotulador): o
   assign() roda no cliente; canal novo não construído sem necessidade validada. A definição do
   episódio-pseudo-label já está tipada e testada.
6. **Âncoras log-espaçadas** (0,5/1,5/4/8m): barato, físico, destrava o expoente n e o GP.
7. **Multi-estação**: o desbloqueador do factor graph e da sua previsão (c) da rodada de
   conflito (2ª estação derruba conflito desproporcionalmente — não testada, gated por hardware).
8. **Não testadas ainda**: sua previsão (b) da rodada de conflito (windowMs↑ derruba conflito
   mais que melhora precisão); previsão (a) da bancada (dropout estruturado → assinatura de erro
   distinta do IID); §9.4 científico (SessionTruth real de ponta a ponta — gated pelo item 1).

## 7. As 5 regras institucionalizadas (o que o processo comprou)

1. Nenhum mecanismo novo sem sentinela adversarial que viole o pressuposto físico compartilhado
   com o simulador (← queda da v4).
2. Todo ganho agregado é decomposto por tipo de erro antes de virar default (← decomposição da
   v4); adendo da Fase 4: decompor **em taxas** quando o eixo muda o nº de oportunidades (← a
   armadilha do "joelho").
3. Gravação de campo é artefato imutável e append-only; nenhum agente tem poder de deleção
   (← incidente do `rm -f`, ~7h perdidas; segmentação por hora + backup implementados).
4. Todo teste de hipótese exige controle positivo antes de interpretar um nulo (← shuffle-baseline).
5. Toda fórmula em spec vem com exemplo de sanidade direcional de uma linha (← sinal invertido
   do viés corporal — o entendimento certo com o documento errado é o modo de falha mais perigoso
   de uma spec).

## 8. Onde novas tentativas e métodos são bem-vindos (perguntas abertas a você)

1. **Cadência BLE**: a janela de 8s vê ~4 leituras distintas. Vale redesenhar o gate de amostragem
   (contar DISTINTAS; interpolar?) ou o próprio TC22 deveria acelerar o advertising? Há um
   trade-off bateria×taxa que você considere padrão nesse hardware?
2. **minMovement escala-aware**: proporcional à área do chão calibrado? Ao alcance radial máximo
   da cena em relação à estação? Ou trocar variância absoluta por variância relativa à distância
   média (coeficiente de variação)?
3. **Retuning da persistência**: mantém a grade (P*,K) que você propôs, ou o primeiro dado de
   campo real (quando o hello world fechar) deveria entrar ANTES do retuning sintético?
4. **O viés direcional como feature**: se o teste de campo confirmar a assimetria radial
   (4-12dB + |r| maior na perna corpo-entre), qual o desenho mínimo que NÃO repete a v4 — e ele
   compete em ROI com simplesmente instalar a 2ª estação?
5. **Multi-estação**: dado que ela desbloqueia simultaneamente o factor graph (T1), o GP (C2), a
   sua previsão (c) e reduz o peso de tudo acima — qual o desenho mínimo de experimento com 2
   estações que você consideraria decisivo?

---

**Fontes**: `docs/analises/tags-bluetooth/PENDENCIAS.md` (doc vivo) ·
`docs/cientifica/{status-implementacao, harness-associacao-indoor, relatorio-consolidado-2026-07-10,
escopo-persistencia-rotulo, bancada-aceite-fase4, simulador}.md` · cabeçalhos de
`src/fusion/{associate, sim, families, label-memory, persistence-sentinel, memory-metrics,
shuffle-baseline, session-loader}.ts`, `server/bt/session-recorder.js` · material original em
`docs/cientifica/{base, exploracao, dev, pedido_caderno}.md` + `caderno-provas-visuais.html`.
Comandos de reprodução: `npm run family -- <nome>` (curvas com IC) · `npm run funnel` (funil sobre
gravação real) · `npx vitest run src/fusion/` (12 pinos + torneios).
