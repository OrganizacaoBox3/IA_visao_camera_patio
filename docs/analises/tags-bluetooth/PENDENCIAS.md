# Pendências — Identidade aumentada BLE (tags nas câmeras)

> **Doc vivo.** Fonte única das pendências deste arco (tags BLE + AR nas câmeras).
> Atualizar a cada onda — feito sobe pra "Feito", novo gap entra em "Pendente".
> Diretriz do usuário (jul/2026): **manter as pendências sempre registradas.**
> Última atualização: jul/2026.

## 🔭 VIRADA CONCEITUAL — o objetivo do cliente (2º parecer do especialista, 2026-07-11)

O cliente quer saber **se o operador está trabalhando** (ocupação/ociosidade/conformidade de
rota), não a posição em cm. Isso NÃO estreita o projeto — dissolve o problema central. Registrado
aqui porque reordena TODAS as prioridades abaixo. Os pontos e o que já medimos:

1. **Complementaridade de dois regimes (o argumento mais forte do projeto)**: deslocamento → a
   correlação funciona (−0,91 medido); permanência → a correlação morre MAS sobra TEMPO, e um
   receptor de zona resolve por PROXIMIDADE (média), não correlação. Conta do especialista: 8min
   a 0,5Hz ≈ 230 leituras, n_eff ≈ 20-25, erro-padrão da média ~1,2dB; 2 mesas a 4m = ~15dB de
   separação = >10σ. O viés corporal (assassino da v4) é neutralizado por tempo (quantil alto) +
   restrição da câmera (assignment limitado por zona). "Onde falta movimento sobra tempo; onde
   falta tempo sobra movimento."
2. **A MÉTRICA ESTÁ ERRADA — otimizamos POR TICK, o cliente compra EVENTO** ("esta visita à mesa
   4 foi do operador 17?"). Cobertura de 30%/tick numa aproximação de 15s (~30 ticks) = ~9 falas
   a 82% → acurácia de EPISÓDIO muito acima disso; cobertura vira "houve ≥1 fala confiante na
   aproximação?" = altíssima. **Consequência: a persistência v1 pode NÃO ser fracasso — resolvia
   cobertura-por-tick, que o cliente não tem.** ✅🔬 **§2 MEDIDA (event-metrics.ts, verdade
   sintética, 12 cenários) — a tese SE CONFIRMA, refinada em DOIS eixos ortogonais que estavam
   colados**:
   - **Eixo IDENTIDADE** ("dado um evento numa pessoa COM tag, a tag estava certa?"): a agregação
     por evento **bate o tick em 9 de 10 cenários** — canonico 82,4→**90,9%**, bloco 80→**100%**,
     ruído 69,2→**87,5%**, multidão 61,5→**75%**. Agregado: **tick 74,5% → evento 79,6%** (+5,1pp;
     até +20pp por cenário). **A tese do especialista está certa neste eixo.**
   - **Eixo REJEITAR-QUEM-NÃO-TEM-TAG**: a agregação NÃO resolve — um falso-rótulo SUSTENTADO vira
     falso-EVENTO (a persistência ajuda o erro tanto quanto o acerto). Por isso a precisão de
     evento GLOBAL fica perto/abaixo do tick. Este eixo é o falso-positivo, não a identidade.
   - **Refinamento CRÍTICO (a prescrição LITERAL refutava a tese)**: argmax do z_comb cru + "falar
     sempre" compara tick-COM-guarda vs evento-SEM-guarda e DESPENCA (canonico 82→62%, viola a
     invariante). A agregação só ajuda quando (a) agrega as falas JÁ GUARDADAS do motor (não
     re-deriva da correlação crua) E (b) exige sustentação (≥3 falas) + dominância (margem top-2).
   - **Exceção honesta pinada**: `cruzamento` 78,4→66,7% — o id-switch troca a verdade física no
     meio do episódio; a agregação não conserta pista cuja verdade trocou.
   - **A "cobertura de 30%" vira ~55% no nível de evento** (canonico 37→55%), NÃO os ~100%
     idealizados — os episódios do sim são curtos (dropout/id-switch/warmup); sobe ~1,5-2×, real.
   - **Gravação REAL (_19, sem verdade → só consistência)**: 39 episódios, z_comb NÃO aponta tag
     dominante estável (concordância tick-a-tick 37,5%) — consistente com o "silêncio do campo" de
     1 estação. Reforça §1/§4: caminhada de 1 estação não produz assinatura limpa; o receptor de
     zona é o que fecha.
3. ✅🔬 **§3 RISCO CRÍTICO MEDIDO HOJE — a sobrevivência de tracks estáticos (a população que a
   mineração de fragmentação FILTROU FORA como "flicker de mobília")**. Re-mineração READ-ONLY da
   gravação passiva (988 tracks): **track ESTÁTICO (maxDisp<0,02) vive mediana 3,0s, p90 16,1s,
   MAX 59,2s — NENHUM chega a 1 minuto** (over1min=0, over8min=0). O especialista: "se vive 8min a
   arquitetura fecha; se morre a cada 40s, o receptor de zona vira REQUISITO, não luxo". **Veredito:
   morre em SEGUNDOS → o receptor de zona (2ª estação na mesa) é REQUISITO.** RESSALVA HONESTA: a
   gravação passiva tinha pouca gente parada REAL — a maioria desses 484 estáticos é mobília/
   flicker, então o número da PESSOA parada especificamente ainda precisa do hello world.
   - ✅🔬 **VEREDITO REFINADO pela alavanca barata (task #27, medida via bancada sintética,
     2026-07-11): a permanência NÃO exige hardware — era artefato do knob.** O parâmetro é `ttlMs`
     (ms de relógio, não frames), default 1500ms, CONCORDA cliente↔hub, JÁ configurável.
     **Divergência efetiva em produção**: o FRONT roda 1500ms fixo, o HUB já roda 8000ms (via probe
     do motion-gate) — o buraco da permanência está no FRONT, não no motor. Buffer **4× (6000ms) →
     pessoa parada vive os 8min inteiros como UM id, zero id-switch, zero custo no cruzamento em
     movimento** (satura em 4×; a "morte em 3s" era 100% artefato de ttlMs=1500). CUSTO decomposto
     (regra nº2): ghost/hijack cresce linear (12→50→67→100% em 1500→6000→8000→12000ms) — mas é
     problema DIFERENTE (uma pessoa NOVA herdar o id de quem ficou parado no mesmo pixel), não a
     morte do track, e tem mitigações (gates de teleporte `maxDist 0.35`, `reassocMaxGapMs`).
     **CONCLUSÃO: o receptor de zona resolve a DESAMBIGUAÇÃO de identidade (o ghost), NÃO a
     sobrevivência do track — para a permanência em si, subir o FRONT de 1500→~6000ms fecha o
     buraco de graça.** Recomendação p/ TORNEIO (não promoção direta — regra da casa): alinhar o
     FRONT ao hub via `eval:counting`.
4. **2ª antena RE-JUSTIFICADA**: não é "dimensão de assinatura no centro da área útil" — é
   **receptor de zona SEMÂNTICA (na mesa/ponto de coleta)**, resolvendo permanência (§1) +
   reidentificação pós-morte-de-track (§3). Dimensão de assinatura vem de brinde. O LUGAR é
   decidido pelo processo do cliente, não pela geometria de trilateração.
5. **Combinatividade verificada pelo especialista** (com prior art checado): (a) **conformance
   checking com eventos incertos** (Pegoraro/Uysal/van der Aalst, Information Systems 2021) — saída
   com LIMITES ("conformidade entre X e Y dada a incerteza"), a invariante da abstenção propagada
   até o relatório do cliente — o pilar mais sólido; (b) **HSMM** (van Kasteren; Switching-HSMM faz
   detecção de anormalidade por DURAÇÃO) = o detector de ociosidade com pedigree, aprende o normal
   de dados não-segmentados; (c) **workflow como prior de identidade** ("só o operador 17 estava
   escalado pra mesa 4") — a tese "restrições carregam mais bits que o BLE" RESSUSCITA (estava
   certa, o tipo de restrição — processo, não parede — é que estava errado). CORTAR: DTW, GP de
   interferência. Acréscimo prático: **ponderar a correlação pela confiança da homografia** (erro
   heterocedástico — preciso perto da câmera, lixo perto do ponto de fuga; pode estar comendo sinal
   hoje) — barato, testável.
6. **IP — o mecanismo central NÃO é novo e ESTÁ patenteado** (US 9772395/10571546/11467247 —
   casamento de trajetória visão×rádio; ID-Match, EyeFi). Encerra a fantasia de patentear
   "associação BLE×trajetória". MAS a novidade MUDOU DE LUGAR: ninguém propaga incerteza de
   identidade até conformidade de processo com LIMITES, nem usa workflow como prior, nem faz a
   troca de regime correlação↔proximidade. "Fomos empurrados PRA CIMA na pilha — o lugar mais
   defensável e mais vendável."
7. **Parar de vender "universal"**: câmera não vê no escuro/fumaça/atrás de obstáculo — AoA/UWB
   sim. A moldura honesta e MAIS FORTE: UWB/AoA dizem ONDE a tag está (pergunta que o cliente não
   fez); a câmera é o ÚNICO sensor do kit que tenta a pergunta REAL (está trabalhando?). "Não é um
   AoA barato — é a única combinação capaz de responder à pergunta comercial."
8. **Convergência jurídica**: "ocioso" é acusação com passivo trabalhista/LGPD. A invariante
   "rótulo errado é pior que nenhum" é o ESCUDO jurídico-ético + diferencial comercial. O sistema
   nunca conclui ociosidade — apresenta evidência com confiança e limites; humano decide.
   **Posicionar como otimização de fluxo/conformidade de processo, não vigilância individual** —
   mesmos dados, aceitação sindical e exposição legal radicalmente diferentes.

## 🎯 PLANO DE ONDAS COM GATE (parecer FINAL do especialista, 2026-07-11 — ver ADR-014)

O produto é **observação de processo com identidade probabilística**; a unidade é a **VISITA**, não
o tick (aproximação+entrada+permanência+saída+consolidação). Arquitetura de 5 camadas: observação
visual → identidade probabilística (Fisher-z na aproximação + prior de workflow) → conservação por
zona (rede de Petri) → estado operacional (HSMM por duração) → conformidade com eventos incertos
(saída em LIMITES) + evidência objetiva de processo. RSSI absoluto está MORTO para decisão (regra
nº6). TRL 3-4: princípio provado em campo, produto NÃO provado.

**As 3 hipóteses que decidem o futuro — GATE DA ONDA 0 RODADO (2026-07-11)**:
- **H1 (visita janela-única) — ⚠️ FALHA NOS DADOS ATUAIS, mas por falta de SPAN, não de sinal; e
  RETRATA a minha leitura otimista da §2**: a medição HONESTA (uma correlação sobre a janela do
  episódio inteiro, n_eff do ρ=0,7 real) decide ZERO episódios em todos os 12 cenários sintéticos e
  no campo — o span radial real é **0,03-0,11 década, uma ORDEM DE GRANDEZA abaixo** do 0,42 "passa
  por pouco" (e do ~0,9 que o receptor-no-destino daria). **A agregação de ticks da §2 INFLAVA**
  (confirmado): somar Fisher-z sobre ticks deslizantes que compartilham 15/16 dos dados fabricava
  um n aparente — o "evento 79,6%" da §2 está retratado; a métrica honesta se abstém. **MAS o
  controle negativo (shift temporal circular, o correto — não o embaralhamento cego) PROVA que o r
  é sinal físico quando há span: real 82,6% vs shift 7,7% (Δ 74,9pp).** A física está viva; falta
  span, que é GEOMETRIA DE INSTALAÇÃO (Δ3). Nuance honesta a refinar: o "episódio" medido foi o
  track INTEIRO (inclui permanência, que dilui a correlação); o −0,91 era uma janela de
  aproximação. Segmentar a FASE de aproximação é o refinamento pendente — mas o span baixo com a
  estação junto da câmera é robusto. **→ H1 é condicional ao span → a Onda 1 (receptor no destino)
  é o experimento decisivo, e testável no SIMULADOR antes do hardware.**
- **H2 (conservação por fronteira) — CONDICIONALMENTE SUSTENTADA; a fronteira é NECESSÁRIA mas não
  suficiente com o tracker atual**: o detector de fronteira é sólido (cruzamento genuíno é limpo em
  58-100%; a histerese N=2 zera a oscilação de borda). MAS a maioria dos tracks NASCE E MORRE
  DENTRO da zona (fragmentação — a mesma morte-em-segundos da §3), então a fronteira raramente
  testemunha as transições de identidade e a ocupação dispara sem saídas. **CONVERGÊNCIA COM #27**:
  isso é exatamente o que a alavanca barata cura — `ttlMs=6000` faz o track parado viver 8min como
  UM id, então ele para de fragmentar dentro da zona e a fronteira passa a testemunhar entrada E
  saída. **H2 fecha pela engenharia grátis (ttlMs), sem hardware.** Ressalva: as zonas testadas
  eram quadrantes arbitrários, não na granularidade do POSTO (regra Δ1) — zonas de posto reduzem
  cruzamentos e mudam a distribuição nasceu/morreu-dentro. Bônus: geometria de bbox NÃO separa
  mobília de operador parado (aspect ~2,5 vs 2,8, sobrepõem) — só duração; o número da pessoa
  parada ainda exige verdade anotada (hello world).
- **H3** REFUTADA na forma "proximidade por RSSI médio distingue mesas" → SUBSTITUÍDA por
  "gradiente de aproximação distingue tags" = o −0,91 medido.

**LEITURA DO GATE**: nenhuma hipótese foi REFUTADA; ambas são condicionais com alavanca conhecida —
H2 pela engenharia grátis (ttlMs 6000), H1 pela geometria (receptor no destino). O próximo passo
decisivo é SIMULAR o receptor no destino (Δ3, autorizado pelo dono) e ver se o span vai a ~0,9
década e a visita fecha com significância HONESTA — isso decide se a Onda 1 (ESP32) tem caso feito
ANTES de comprar hardware. Se nem no simulador fechar, a arquitetura pivota antes de gastar.

### ONDA 1 (medição de bancada, 2026-07-11) — geometria do span + θ, e uma CORREÇÃO DE MÉTRICA importante

Duas frentes paralelas (novos módulos, propriedade exclusiva; `receiver-geometry.ts`, `theta-discriminator.ts`):

**θ (Δ2, ADR-014 item 9) — REFUTADO como 2º discriminador**, com números (`theta-discriminator.ts`).
θ_verdadeiro é largo/instável (mediana ~21 dB/déc, IQR [8,6; 31]; e DENTRO do gate |r|≥0,7 sobe pra
[27; 62] porque selecionar por |r| alto premia retas íngremes). θ_espúrio-perigoso espalha (IQR
larg 86; 35% cai na faixa dos verdadeiros). Nenhuma banda de θ supera o baseline só-|r| (55,6%).
Heterocedástico (peso 1/d²) empata. Causa exatamente o risco anti-v4: viés corporal infla o slope +
span minúsculo deixa a estimativa ruidosa + o n do canal varia. **A ressalva de NÃO fixar θ≈22 se
provou certa.** Re-testável só se o receptor-no-destino trouxer span de verdade (slope menos ruidosa).

**Geometria do span (`receiver-geometry.ts`) + a CORREÇÃO que muda a leitura do gate**. O cálculo
NÃO-CIRCULAR (trajetória × distância euclidiana, sem o modelo de rádio) mediu, extraindo a trajetória
verdade por inversão de H: mover o receptor da câmera para o destino ganha **~3–4× no span radial**
(std 0,09 → 0,29 no destino / 0,34 no ótimo de sala). O agente concluiu "pivô" porque o std absoluto
(0,29) fica longe de 0,9. **MAS há uma confusão de métrica no próprio gate, que eu reconciliei**:
- `spanDecades` no código (`visit-metrics.ts`) é **std populacional de log10(dist)**.
- Os limiares 0,42/0,9 do ADR-014 são **RANGE**, não std: `log10(8/3)=0,426` (aproximação 8→3 m) e
  `log10(8/1)=0,903` (8→1 m). Batem EXATAMENTE com range. O teto de STD de uma aproximação reta
  idealizada é ~0,33 déc — std=0,9 exigiria razão ~1000:1 (irreal indoor). **Comparar std(0,29)
  contra alvo-que-era-range(0,9) é maçã com laranja; o veredito de "pivô" está mal-fundamentado.**

**O que sobrevive robusto** (independe de std/range): (a) o receptor no destino ganha 3–4× de
gradiente radial — e é o gradiente/ruído, não o std absoluto, que move |r| acima do ruído (o driver
REAL da significância; o span não decide nada no código — a significância Fisher-z decide); (b) o
campo real é ainda mais pobre que o sim (std 0,018–0,166). (c) A decisão H1 "abstém com ρ=0,7" NÃO
usa o span — é robusta à confusão.

**CORREÇÃO de uma premissa minha (honestidade)**: cheguei a levantar um "câmera vs estação" — que a
métrica correlacionaria RSSI(estação) × dist(câmera). **Errado**: `frame.ts:69` computa `dist` como
distância pessoa→ESTAÇÃO (o `stationWorld`, o receptor), não à câmera. Logo a métrica JÁ segue o
receptor — mover a estação para o destino faz o `dist` da correlação virar dist→destino
automaticamente; não há problema de covariância. (Resíduo real, de 2ª ordem: perto do destino a
homografia observa a pessoa com mais erro — heterocedasticidade, o que o #28 testou e empatou.)

**A pergunta de pivô, agora bem-posta e medível**: mover a estação para o destino leva o span de
dist→estação de **0,13 → 0,29 std** (medido, `receiver-geometry.ts`). Esse ganho de gradiente empurra
|r| além do gate de significância descontado por n_eff (ρ=0,7), fazendo a visita passar a DECIDIR
corretamente onde hoje abstém? **Próxima medição (simulador, autorizado): posicionar a estação no
destino da caminhada, regenerar, rodar `computeVisitMetrics` honesto e ver se DECIDE.** É a metade
circular/indicativa (o sim gera RSSI = f(dist→estação) + ruído, então |r| é alto por construção — o
que o testa é se o RUÍDO do modelo, no span maior, ainda deixa a significância passar; funil de
hipótese, não juiz): se NEM no sim otimista decidir, pivô forte; se decidir, indicação de seguir para
hardware com validação de campo. Correção de rigor a fazer junto: `spanDecades` reporta STD e RANGE
lado a lado, e o ADR-014/comentários anotam que 0,42/0,9 eram range. [✅ FEITO: `visit-metrics.ts`
ganhou `rangeDecades`/`medianRangeDecades`.]

### VEREDITO DA ONDA 1 (medição de bancada fechada, 2026-07-12) — o gargalo é n_eff, não span; e a saída é regime-dependente

`receiver-at-destino.test.ts` (knob aditivo `stationWorldOverride` no `sim.ts`, cenários bit-a-bit
intactos — 58 testes de pinning verdes) mediu, com ρ=0,7 honesto, pooled sobre 325 visitas-com-tag:

**1. Estação no destino confirma o span (0,13→0,27 std, cross-check com receiver-geometry) MAS quase
não decide** (0/325 → 1/325 no destino → 2/325 no ótimo de sala). **O gargalo diagnosticado é o
n_eff, NÃO o span**: o n_eff MÁXIMO da suíte inteira é 6,88 (mal supera o piso 3); aí a variância de
Fisher `√(1/(n_eff−3))` explode e o gate exige |r| ≥ 0,76 — o ganho de span não vence essa barra.
Mover o receptor não toca o n_eff (independência temporal). As duas metades (geometria pura +
significância) CONCORDAM.

**2. VARREDURA DE CADÊNCIA — a alavanca real, e a nuance que refina o pivô**. O n_eff é governado pela
cadência de refresh REAL do RSSI (advertising da tag), não pelo POST (a correção Δ4 500ms não cria
leituras distintas se a tag anuncia devagar — `distinctConsecutive` deduplica). Dobrar o refresh de
**1 Hz → 2 Hz** (`rssiPeriodTicks` 2→1):

| cadência | maxNeff | eps c/ n_eff>3 | cobertura | precisão |
|---|---|---|---|---|
| 1 Hz (atual) | 6,88 | 42/325 | **0,3 %** | 100 % |
| 2 Hz (dobrado) | 15,88 | 122/291 | **15,5 %** | 97,8 % |

Cadência de advertising **é uma alavanca de hardware real** — abre o gate 0,3%→15,5%. **Mas o ganho é
por DURAÇÃO de episódio, não por aproximação**: n_eff mediano por regime (a 2 Hz) — aproximação
3-8 s = **1,76** (abaixo do piso), longo 8-16 s = 3,88, muito-longo ≥16 s = 7,59. Alcançar n_eff>3
exige >17 leituras distintas ≈ **9 s a 2 Hz** (17 s a 1 Hz) — mais longo que uma aproximação real.

**3. LEITURA HONESTA (cuidado com a métrica "dwell")**: os episódios que decidem são observações
LONGAS EM MOVIMENTO (têm span + muitas leituras) — NÃO parada estacionária: o cenário `parado`
(span 0) nunca decide, a qualquer cadência. Logo: a identidade RSSI fecha na **aproximação
longa/observada** (precisa de tag rápida + span); o operador **parado num posto** não fecha por RSSI
(span 0) — a identidade tem de ser estabelecida na chegada e **CONSERVADA pela topologia** (camada 3,
a alavanca ttlMs de #27). **Isto NÃO é pivô contra o ADR-014 — é a validação empírica quantificada da
arquitetura de 5 camadas**: camada 2 (identidade RSSI) só contribui com advertising rápido E via a
aproximação; camada 3 (conservação por zona) faz o resto; camadas 4-5 (duração/conformance) leem
trabalho/ocioso. A significância per-visita por aproximação breve é estruturalmente inalcançável →
identidade ACUMULA entre visitas, não fecha por uma.

**DECISÃO DE HARDWARE (regime-dependente, para o dono/especialista pesarem)**: se o alvo é
permanência observada no posto → **tag de advertising rápido (≥2 Hz) é a alavanca de maior ROI, mais
que a 2ª antena**; o receptor no destino ajuda o span mas não é o gargalo. Se o alvo é fluxo de
passagem breve → nenhum receptor/cadência fecha per-visita; priorizar as camadas de acúmulo (Petri +
HSMM) e evidência objetiva. **#26 (ESP32) deixa de ser "o experimento decisivo" isolado** — o
experimento decisivo virou *cadência de advertising × duração de observação*.

### PARECER DO ESPECIALISTA SOBRE O GATE (2026-07-12) — a lei de saturação e o τ da população errada

Ele confirmou o achado E expôs **um 2º erro metodológico meu**. Registrado porque muda a leitura:

**1. A LEI (n_eff satura).** Com ρ=e^(−Δt/τ) e n=T/Δt:
`n_eff = (T/Δt)·tanh(Δt/2τ) → T/(2τ)` quando Δt→0.
**Aumentar cadência só ajuda até Δt ≪ τ; depois, amostrar mais rápido não cria informação.** O teto é
a duração observada dividida por 2τ — nada mais. Isso prevê que 4 Hz/10 Hz NÃO salvam (não queimar
bateria atrás disso). E a barra cai rápido: n_eff 6,88 → |r|≥0,76; n_eff 20 → |r|≥**0,44** (a diferença
entre falar em 15% dos episódios e na MAIORIA).
⚠️ **Isso INVALIDA parcialmente a minha varredura de cadência**: usei ρ=0,7 **FIXO** a 1 Hz *e* a 2 Hz.
Mas ρ depende de Δt — a 2 Hz, com o mesmo τ, ρ deveria SUBIR (não ficar em 0,7). **O ganho "0,3%→15,5%"
está provavelmente INFLADO.** Correção em curso (n_eff τ-based).

**2. O τ PODE TER SIDO MEDIDO NA POPULAÇÃO ERRADA** (a mesma classe de erro do "flicker de mobília"):
o τ (2,8–32 s) foi minerado das **ÂNCORAS — que são PARADAS** (fading estático, τ longo, dominado por
deriva ambiental). **A tag do operador está em MOVIMENTO**: a coerência espacial do fading é ~λ/2 ≈ 6 cm
a 2,4 GHz, então a 1,2 m/s ele atravessa um fade a cada ~50 ms → a componente de fading fica quase
**BRANCA** → τ_móvel é dominado pelo que sobra (orientação corporal, marcha), **provavelmente ~1–2 s,
não 10–30 s**. Contas: T=20 s com τ=10 s → teto n_eff = **1**; com τ=1,5 s → teto **6,7** (suspeitosamente
perto do 6,88 que medi). **Se o τ estiver errado, o gate disparou no número errado.**
→ **TESTE DECISIVO, barato, sobre dado que JÁ EXISTE**: autocorrelação do **RESÍDUO da tag MÓVEL** na
caminhada de campo (RSSI observado − previsto pela distância-câmera), não das âncoras.
**[✅ MEDIDO 2026-07-12 — ver o veredito abaixo. O especialista estava certo, e por baixo.]**

### ✅ VEREDITO DO τ_MÓVEL (`residual-autocorr.ts`) — e a 3ª correção metodológica (a mais grave)

**A ACF ingênua estava medindo o SNAPSHOT, não o canal.** O app posta a cada ~550 ms mas a tag só
atualiza o RSSI a cada ~2,5 s → a série do JSONL é uma **ESCADA** (sample-and-hold). Uma ACF ingênua
sobre uma escada DECAI mesmo que o sinal por baixo seja BRANCO — o decaimento é do hold, não da física.
Testado contra a hipótese nula do hold (ρ(Δ)=E[(L−Δ)⁺]/E[L], a ACF que ruído branco retido produz), ela
bate **lag a lag**:

| lag (s) | 0,5 | 1,2 | 2,2 | 3,2 | 4,2 | 5,2 |
|---|---|---|---|---|---|---|
| ACF crua | 0,801 | 0,604 | 0,369 | 0,268 | 0,175 | 0,090 |
| HOLD puro (nula) | 0,823 | 0,607 | 0,342 | 0,213 | 0,148 | 0,097 |
| **CORRIGIDA** | −0,123 | −0,010 | 0,041 | 0,070 | 0,032 | −0,008 |

**O decaimento é 100% artefato de amostragem.** Corrigido, o resíduo da tag móvel é **BRANCO**:
τ_móvel = **0 s** pelos dois métodos (lag-1 da série fresca; ajuste exp. da ACF corrigida); **limite
superior honesto ≤ 1,68 s** (o usado no n_eff, conservador). Sem corrigir, leríamos 2,52 s — artefato.
vs **τ_âncora 2,8–32 s** que o ρ=0,7 embutia. Blindagem anti-auto-engano: **controle positivo** — a
correção recupera um τ=4 s PLANTADO (não é uma máquina de zerar τ).

⚠️ **BOMBA (pendência aberta):** o τ CRU das 5 tags — móvel **E paradas** — cai em 1,96–38,8 s, DENTRO
da faixa 2,8–32 s da mineração original. **Indício forte (não prova — a mineração não foi re-rodada) de
que o τ das ÂNCORAS era ele próprio SAMPLE-AND-HOLD, não física** ⇒ o **ρ=0,7 "medido em campo" que
alimenta a métrica desde sempre pode ser artefato da cadência do POST.** → RE-RODAR a mineração das 6 h
com a correção de hold (pendência registrada).

**Erro MEU corrigido pelo agente:** eu instruí "escolher o par de maior |r|" — que é CEGO AO SINAL, e
elegeu uma tag com θ=−29,8 (RSSI SUBINDO com a distância — fisicamente impossível p/ tag carregada). A
regra certa é o maior r COM SINAL físico. (O `visit-metrics.ts` já fazia certo — ranqueia por score=−r
exigindo score>0; a cegueira estava só na minha heurística de seleção do prompt.)

### ✅ TABELA DE CADÊNCIA CORRIGIDA — o gate disparou no número errado, nas DUAS pontas

| métrica | 1 Hz (antiga) | 2 Hz (antiga) | **1 Hz (CORR)** | **2 Hz (CORR)** |
|---|---|---|---|---|
| ρ usado | 0,700 | 0,700 | **0,551** | **0,743** |
| n_eff MÁX | 6,88 | 15,88 | **11,28** | **13,29** |
| episódios n_eff>3 | 42 | 122 | **104** | **102** |
| **COBERTURA** | 0,3% | **15,5%** | **4,6%** | **10,0%** |
| precisão | 100% | 97,8% | 86,7% | 100% |
| barra \|r\| @maxNeff | 0,76 | 0,50 | **0,59** | **0,54** |

- **SUBESTIMEI** o n_eff da cadência ATUAL (τ de âncora parada aplicado a tag móvel): 6,88 → **11,28**;
  a barra |r| cai de 0,76 → **0,59**.
- **SUPERESTIMEI** o ganho de dobrar a cadência (ρ CONGELADO nas duas cadências): 15,5% → **10,0%**.

**A CADÊNCIA SATURA, como a lei previa**: 1→2 Hz rende só **1,18×** de n_eff (era 2,31× — o "dobro" era
o ρ congelado), e os episódios que cruzam o piso ficam **PLANOS** (104→102, contra 42→122 da régua
falsa). *Nuance honesta:* a cobertura ainda sobe 2,16× (4,6→10,0%) — não porque nasçam episódios acima
do piso, mas porque os que já passavam ganham n_eff e a barra |r| cede. Cadência não é alavanca NULA; é
**muito menor** do que vendemos.

### 🔴 RETRATAÇÕES (2026-07-12, após fechar o intervalo de τ) — três conclusões minhas CAÍRAM

Eu cravei 4,6% usando τ=1,68 s (o limite SUPERIOR conservador). A estimativa **PONTUAL** é τ→0 (branco),
e lá o quadro é OUTRO. Varredura da cobertura por τ (cadência ATUAL 1 Hz, pooled/325):

| τ (s) | ρ@1Hz | n_eff máx | \|r\| exigido | **BASE cob%** | **DESTINO cob%** | prec% |
|---|---|---|---|---|---|---|
| **0 (BRANCO)** ← estimativa pontual | 0,000 | **39,00** | 0,32 | **24,9%** | **45,2%** | 87,1% |
| 0,25 | 0,018 | 37,60 | 0,32 | 23,1% | 42,8% | 88,5% |
| 0,50 | 0,135 | 29,70 | 0,36 | 16,9% | 32,9% | 90,7% |
| 1,00 | 0,368 | 18,02 | 0,47 | 4,6% | 11,1% | 91,7% |
| **1,68 (bound)** ← o que eu usei | 0,551 | 11,28 | 0,59 | 0,6% | **4,6%** | 86,7% |
| *(o gate original: ρ=0,7 ≡ τ≈2,8 s)* | *0,700* | *6,88* | *0,76* | *0%* | *0,3%* | *100%* |

**RETRATAÇÃO 1 — "H1 não fecha": CAI.** Eu afirmei isso com o ρ ERRADO. Na estimativa pontual (τ→0), a
cobertura por visita é **45,2% no destino / 24,9% no baseline**, a 87–92% de precisão. A resposta honesta
é o **intervalo [4,6%; 45,2%]**, com massa perto de τ→0. **H1 volta a estar ABERTA.**

**RETRATAÇÃO 2 — "o gargalo é o n_eff, não o span": CAI. Era ARTEFATO do ρ errado.** Com ρ=0,7 o n_eff era
esmagado a 6,88 e NADA ajudava (por isso mover o receptor "não adiantava"). Com o ρ certo (n_eff máx
**39**), **o span VOLTA a importar**: o receptor no destino quase DOBRA a cobertura (24,9% → 45,2%).
**→ A #26 (ESP32 no destino) RESSUSCITA**, agora por DOIS motivos somados: span E separação de canal.

**RETRATAÇÃO 3 — o placar das previsões.** (a) τ_móvel ≪ τ_âncora → **CONFIRMADA** (e por baixo: é branco).
(b) "a cobertura salta bem acima de 15,5%" → **CONFIRMADA** (45,2%!) — eu a havia declarado refutada cedo
demais, olhando só a ponta pessimista. Ele acertou o SALTO; errou só a VIA (é a correção do τ, não a
cadência). (c) canal > dobrar cadência → **SUSTENTADA**.

**O QUE SOBREVIVE:** a **cadência SATURA** (1→2 Hz rende 1,18× de n_eff, não 2,31×) → **NÃO comprar tag de
2 Hz** segue de pé. E o ganho de graça é real: **só corrigir a métrica** (ρ) tira a cobertura de 0,3% para
**24,9–45,2%** no hardware ATUAL, sem comprar nada.

**⚠️ CAVEAT QUE ATRAVESSA TUDO:** a varredura de τ roda no **SIMULADOR** (que gera RSSI a partir da
distância — CIRCULAR por construção). Os 45,2% são **INDICATIVOS, não campo**. O que É campo é o **τ**.
**→ Validar exige verdade anotada: a caminhada do dono (#4) virou o GATE CRÍTICO** — sem ela medimos se a
visita DECIDE, mas não se ela ACERTA.

### 🔴🔴 RETRATAÇÃO 4 (2026-07-12) — os 45,2% CAEM: era BUG DE CONTAGEM no simulador (não estatística)

Revisor externo pegou o que passou por todos nós: **`n_eff ≤ nº de medições DISTINTAS = T/Δt_tag`**. É
CONTAGEM — não pode existir mais evidência independente do que leitura fresca. **Diagnóstico CONFIRMADO por
medição** (não por argumento):

- **A causa NÃO era a métrica.** `distinctConsecutive()` (visit-metrics.ts) deduplica corretamente (medido:
  n=12 amostras alinhadas → nDistinct=4 quando o valor só muda a cada 3 ticks).
- **A causa É o SIMULADOR.** `sim.ts` usa `rssiPeriodTicks ?? 2` × TICK_MS=500 ⇒ RSSI fresco a cada **1,0 s**.
  A **tag real anuncia a cada ~2,5 s** (medido em campo — o mesmo dado do sample-and-hold). O sim entregava
  **2,5× mais leituras genuinamente distintas do que a física permite**. Medido nos cenários: `nDistinct ≈
  T/0,99 s` (o sim) contra `T/2,24 s` (com a cadência real). **1285 episódios violam o teto físico da tag;
  pior caso nDistinct=45 contra teto 20 (2,3× de inflação).**
- **O n_eff=39 exigiria um episódio de ~97 s** contínuos com a tag real. Nenhuma aproximação a uma mesa dura isso.

**A COBERTURA HONESTA (mesma suíte, mesma geometria, mesmo τ — só a cadência da tag corrigida):**

| τ (s) | n_eff máx (1 s → **2,5 s**) | BASE cob% (1 s → **2,5 s**) | DESTINO cob% (1 s → **2,5 s**) | DEST prec% |
|---|---|---|---|---|
| **0 (BRANCO)** ← pontual | 39,00 → **23,00** | 24,9% → **7,6%** | **45,2% → 2,5%** | 100% |
| 0,50 | 29,70 → **22,69** | 16,9% → **7,3%** | 32,9% → **2,3%** | 100% |
| 1,00 | 18,02 → **19,51** | 4,6% → **3,9%** | 11,1% → **0,8%** | 100% |
| 1,68 (bound) | 11,28 → **14,53** | 0,6% → **1,1%** | 4,6% → **0,0%** | — |

**→ A RETRATAÇÃO 1 é RE-RETRATADA: H1 NÃO fecha.** A cobertura por visita no destino cai de **45,2% para
2,5%**. Os 45,2% eram o simulador anunciando a 1 Hz.

**→ A RETRATAÇÃO 2 CAI JUNTO — e a #26 (ESP32 no destino) perde a justificativa de COBERTURA.** Com a tag
real o destino fica ABAIXO do baseline em cobertura (2,5% vs 7,6%) — inversão que a régua inflada escondia.
**MAS olhar só a cobertura engana:** a precisão do baseline DESABA para **55,6%** (quase cara-ou-coroa), e a
do destino se mantém em **100%**. **O receptor no destino compra QUALIDADE (precisão), não cobertura.**

**A LEI COMPLETA** (registrada em `visit-metrics.ts`; antes só tínhamos o 2º termo):

> **n_eff = (T/Δt)·tanh(Δt/2τ) ≤ min( T/Δt_tag , T/(2τ) )**

Para a tag **MÓVEL** (τ→0, resíduo branco) quem MORDE é o **1º termo — a taxa de atualização da tag**.
**Consequência que INVERTE o laudo anterior: com τ pequeno NÃO há saturação em 1–2 Hz** → a cadência volta a
ser alavanca **LINEAR** (não para vencer autocorrelação — não há — mas para ter **pontos suficientes para
ajustar a reta**). "A cadência satura, não compre tag rápida" só valia para τ longo (tag PARADA).

**A ARITMÉTICA QUE MATA A APROXIMAÇÃO** (sobrevive a qualquer modelo — é contagem). Com a tag real (2,5 s),
uma aproximação de **3–8 s produz 3–5 leituras distintas**. O teste de Fisher tem **√(n_eff−3) no
denominador** ⇒ com n_eff ≤ 3 ele é **INDEFINIDO, não "difícil"**. Não há knob, span, receptor ou τ que
conserte: **faltam PONTOS**.

**ESPECIFICAÇÃO DE PROJETO** — (T, Δt_tag) → nDistinct → barra |r| → veredito (τ→0, a ponta otimista):

| T (s) | Δt_tag (s) | nDistinct | n_eff | \|r\| exigido | veredito |
|---|---|---|---|---|---|
| 8 | 2,5 | 5 | 5,0 | 0,88 | MARGINAL |
| **20** | **2,5** | 9 | 9,0 | 0,66 | **VIÁVEL** |
| 40 | 2,5 | 17 | 17,0 | 0,48 | CONFORTÁVEL |
| 20 | 1,0 | 21 | 21,0 | 0,43 | CONFORTÁVEL |
| 8 | 0,5 | 17 | 17,0 | 0,48 | CONFORTÁVEL |

**T MÍNIMO do episódio** (τ→0): tag real (2,5 s) → o teste **EXISTE a partir de 5,5 s**, fica **VIÁVEL
(|r|≤0,7) só a partir de 18 s**. A 2 Hz: **1,5 s / 4,0 s** (~5× menos permanência exigida — a alavanca
LINEAR). **→ Só PERMANÊNCIA fecha: o receptor precisa cobrir a janela em que o operador FICA, não a em que
ele PASSA.**

**BLINDAGEM PERMANENTE (Regra 8, no CI para sempre):** `visit-metrics.ts` agora TRAVA `nEff ≤ nDistinct`
(clamp explícito) e expõe `maxDistinctReadings(spanMs, dtTagS)` = ⌈T/Δt⌉+1 + `countingViolations()`. Testes
falham se alguém reintroduzir contagem de duplicatas OU alimentar a métrica com fonte mais rápida que a tag.
`sim.ts` exporta `REAL_TAG_PERIOD_TICKS=5` (2,5 s) e avisa **no cabeçalho** que o default 2 é OTIMISTA — o
default NÃO mudou (os 58 pinos bit-a-bit dos FUSION_SCENARIOS dependem dele).

### 🔴🔴 RETRATAÇÃO DA RETRATAÇÃO (2026-07-12, tarde) — os 45,2% eram BUG DE CONTAGEM. O número honesto é 2,5%.

**O invariante que fecha a questão (é CONTAGEM, não estatística — Regra 8):**
`n_eff ≤ nº de medições DISTINTAS ≤ ⌈T/Δt_tag⌉+1`. Não existe mais evidência independente do que
medições distintas. n_eff=39 exigiria um episódio de ~97 s com a tag real. **Nenhuma aproximação dura isso.**

**A causa (medida, não argumentada):** a métrica está LIMPA (`distinctConsecutive` deduplica certo —
verificado). **O bug é o SIMULADOR**: `sim.ts` usa `rssiPeriodTicks=2` (RSSI fresco a cada **1,0 s**), mas
a **tag real anuncia a ~2,5 s**. O sim entregava **2,3× mais leituras genuinamente distintas do que a
física permite** — **1285 episódios violavam o teto físico** (pior caso: nDistinct=45 contra teto 20).

**COBERTURA HONESTA (tag 2,5 s) vs INFLADA (1 s)** — mesma suíte, mesma geometria, mesmo τ:

| τ (s) | n_eff máx (1 s → **2,5 s**) | BASE cob% | **DEST cob%** (1 s → **2,5 s**) | DEST prec% |
|---|---|---|---|---|
| **0 (BRANCO)** | 39,00 → **23,00** | 24,9% → **7,6%** | **45,2% → 2,5%** | **100%** |
| 0,50 | 29,70 → 22,69 | 16,9% → 7,3% | 32,9% → 2,3% | 100% |
| 1,00 | 18,02 → 19,51 | 4,6% → 3,9% | 11,1% → 0,8% | 100% |
| 1,68 | 11,28 → 14,53 | 0,6% → 1,1% | 4,6% → 0,0% | — |

**Os 45,2% caem para 2,5%** — pior que os ~20% previstos pelo revisor.

**🔄 E O RECEPTOR NO DESTINO SE INVERTE OUTRA VEZ — mas SOBREVIVE, por outro motivo.** Com a tag real, o
destino fica ABAIXO do baseline em COBERTURA (2,5% vs 7,6%). Mas olhar só cobertura ENGANA: a **precisão do
baseline DESABA para 55,6%** (quase cara-ou-coroa) enquanto o **destino mantém 100%**. **O receptor no
destino compra QUALIDADE, não cobertura.** Dada a invariante da casa (*rótulo errado é pior que nenhum*) e
a métrica-que-mata (<1 falso alerta/turno), 2,5% a 100% vale MUITO mais que 7,6% a 55,6%. **#26 sobrevive —
por precisão, não por span.**

### 📐 A ARITMÉTICA QUE MATA A APROXIMAÇÃO (o achado que nenhuma correção futura derruba)

**Aproximação de 3–8 s com tag de 2,5 s → 3–5 leituras distintas.** O teste de Fisher tem √(n_eff−3) no
denominador: com n_eff ≤ 3 ele **não é difícil — é INDEFINIDO**. Não depende de ρ, estimador, simulador
nem algoritmo. **A aproximação típica está morta por CONTAGEM.**

**TABELA DE REQUISITOS (τ→0, a ponta otimista) — vira ESPECIFICAÇÃO DE INSTALAÇÃO:**

| T (s) | Δt_tag (s) | nDistinct | n_eff | \|r\| exigido | veredito |
|---|---|---|---|---|---|
| 8 | 2,5 | 5 | 5,0 | 0,88 | MARGINAL |
| **20** | **2,5** | 9 | 9,0 | 0,66 | **VIÁVEL** |
| 40 | 2,5 | 17 | 17,0 | 0,48 | CONFORTÁVEL |
| 20 | 1,0 | 21 | 21,0 | 0,43 | CONFORTÁVEL |
| 8 | 0,5 | 17 | 17,0 | 0,48 | CONFORTÁVEL |

**T MÍNIMO (tag atual de 2,5 s): o teste EXISTE em 5,5 s; fica VIÁVEL em 18 s.**
**Com tag a 2 Hz: 1,5 s / 4,0 s** — ~5× menos permanência exigida.

### ⚖️ A LEI COMPLETA — e as DUAS recomendações de hardware de ontem SE INVERTEM

**`n_eff ≤ min( T/Δt_tag , T/(2τ) )`** — antes só tínhamos o 2º termo. Para a tag MÓVEL (τ→0, resíduo
branco) quem MORDE é o **1º**: a taxa de atualização da TAG. **Logo NÃO há saturação em 1–2 Hz: a cadência
volta a ser alavanca LINEAR** (verificado: T_viável escala com Δt_tag). Contra-prova pinada: com τ=1,68 s,
25× de cadência quase não move o T exigido — a saturação só valia para τ LONGO (tag PARADA).

- **"Não comprar tag de 2 Hz" (laudo de ontem): REVERTIDA.** A tag rápida é a alavanca LINEAR que derruba
  a permanência exigida de **18 s → 4 s**.
- **"ESP32 no destino pelo span/cobertura": REVERTIDA na razão, MANTIDA na conclusão.** Ele compra
  **precisão (100% vs 55,6%)**, não cobertura.

**Blindagem permanente (Regra 8 no CI):** `visit-metrics.ts` clampa `nEff = min(…, nDistinct)` e exporta
`maxDistinctReadings()`/`countingViolations()`; testes FALHAM se alguém reintroduzir contagem de duplicatas
ou alimentar a métrica com fonte mais rápida que a tag. `sim.ts` exporta `REAL_TAG_PERIOD_TICKS=5` com
proveniência + aviso alto no cabeçalho (default 2 intacto — 45 testes de pinning verdes).

### 🔴 O ρ=0,7 NÃO TEM BASE FÍSICA DEMONSTRADA (re-mineração das 56 h — pendência #38 FECHADA)

- ✅ **A inflação está PROVADA sem depender de estimador**: **44–86% dos pares** no lag de 2 s são do
  **MESMO DEGRAU** — o snapshot correlacionando uma CÓPIA da mesma medição consigo mesma (dá 1 por
  construção). Removido o hold, o ρ(2 s) máximo de QUALQUER âncora por QUALQUER estimador é **0,57 —
  ABAIXO do 0,7 adotado**. Nenhuma leitura des-retida sustenta o 0,7.
- ✅ **A assimetria prevista EXISTE**: a âncora PARADA tem memória lenta REAL (τ até **626 s ≈ 10 min** —
  deriva ambiental); a tag MÓVEL não tem nem isso (branco). Fading estático vs. atravessar fades.
- ❌ **NÃO provado: o ρ exato da âncora.** Os dois estimadores DIVERGEM (~0 vs ~0,5) e ambos são enviesados
  nesta amostragem (a repetição de valor é irrecuperável por construção). Fica em [~0; ~0,5]. **NÃO se
  afirma que a âncora é branca** — o dado não sustenta.
- **Conclusão defensável**: a física é **BIMODAL** — deriva lenta de minutos (âncora) + branco em segundos
  (tag móvel). **Nenhuma das duas é um AR(1) de τ=2,8–32 s.** E o ρ da âncora **não transfere** para a tag
  móvel. **O ρ=0,7 na visita estava errado nas DUAS pontas: número inflado E população errada.**
- **Nota de método (vale mais que o número)**: tentou-se uma correção analítica do hold
  (ρ_crua = p·1 + (1−p)·ρ_fresca) e **a checagem de consistência embutida a REPROVOU** (erro até 0,48) →
  descartada; o veredito só usa estimadores que não dependem dessa hipótese. O aparato funcionando.
- **O que fecharia o intervalo de τ (medição, não compra)**: uma tag a ≥10 Hz por alguns minutos (resolve
  a ACF sub-500 ms), ou um receptor que separe os canais 37/38/39 (mede τ por-canal sem a brancura do
  salto de canal). Ambos → ESP32.

**3. AS 4 ALAVANCAS SOBRE O n_eff, RANQUEADAS** (a nova ordem de prioridade):
1. **T (duração observada)** — linear, GRÁTIS, e é GEOMETRIA. "Aproximação de 3-8 s" NÃO é constante
   física — é **artefato do FOV**. Um operador caminhando 20 m até a mesa leva ~16 s; se a câmera só vê
   os últimos 5 m, observamos 4 s e jogamos fora 75% da informação. **Conserte a câmera, não a tag.**
   Promove o Δ3 de "radial" para **"radial E LONGO"**: câmera cobrindo o corredor inteiro de aproximação
   + receptor no destino. Compõem-se, e custam só onde se parafusa o suporte.
2. **τ (diversidade de canal)** — potencialmente **3×**. BLE anuncia em 3 canais (2402/2426/2480 MHz,
   separados por 24 e 54 MHz); a banda de coerência indoor (delay spread 50–200 ns) é ~1–4 MHz → o fading
   em cada canal é essencialmente INDEPENDENTE → 3 olhares quase-independentes do mesmo path loss (~3×
   n_eff, ou √3 de redução de ruído). Foi o fator que mais ajudou na campanha que chegou a ~1 m indoor.
   ⛔ **BLOQUEIO CONFIRMADO POR MIM NO CÓDIGO (2026-07-12)**: o scanner do TC22 usa a API padrão do Android
   (`ScanResult.getRssi()`, `MainActivity.java:230`), e o Android **NÃO expõe o canal do advertisement**
   (dá PHY e txPower, nunca o índice 37/38/39). A gravação só tem {mac, rssi}. **→ Esta é a razão NOVA e
   FORTE para o receptor #2 ser ESP32/NimBLE e não outro Android: por ACESSO À FÍSICA, não por preço.**
   (Corolário: o nosso RSSI atual é canal-MISTURADO — injeta ruído branco no resíduo, o que enviesa o τ
   medido para BAIXO e derruba |r|.)
3. **Receptores independentes** — a 2ª antena RE-justificada, mas por outro motivo: não como "dimensão de
   assinatura" (formulação antiga, morta) e sim como **multiplicador de n_eff** (o multipath em B é
   largamente independente do de A → somar Fisher-z soma informação REAL). O quanto depende de ρ_AB,
   medível assim que B existir.
4. **Cadência** — SATURANTE. Ir a ~2 Hz e parar; não perseguir além até saber τ_móvel.

**4. RESPOSTA ÀS 3 PERGUNTAS**: (Q1 tags rápidas) **NÃO comprometer recurso ainda** — medir τ_móvel
primeiro; há 2 alavancas melhores e mais baratas na frente (T = geometria de câmera; canal = ESP32), ambas
grátis em bateria. (Q2 regime) **É PERMANÊNCIA no posto** — e permanência é exatamente onde o RSSI dá ZERO
(span 0) ⇒ **a identidade TEM que fechar na APROXIMAÇÃO**, o elo fraco ⇒ isso transforma "estender T" de
otimização em **requisito de projeto de 1ª classe**. (Q3 Onda 2) **AGORA, e independe de tudo acima** — o
argumento é aritmético: mesmo no melhor caso medido, ≥84,5% dos episódios NÃO terão identidade por rádio
em cadência nenhuma ⇒ a arquitetura NÃO pode repousar sobre o rádio ⇒ os outros 84,5% precisam de outra
fonte, e a única independente do rádio é o **workflow** (+ topologia). **Promovido de diferencial a
ESTRUTURA PORTANTE — e é grátis.** Fazer campo ANTES da Onda 2 seria testar a coisa errada (com prior de
workflow, a decisão de identidade é outra).

### 🔴🔴🔴 RETRATAÇÃO 5 (2026-07-12, noite) — o PISO OPERACIONAL: os 39,4% do "portal" CAEM (revisor externo)

**O FURO (confirmado por medição).** O gate `n_eff > 3` é o piso da **FÓRMULA** de Fisher (abaixo dele
√(n_eff−3) é imaginário — o teste NÃO EXISTE). Nós o usamos como se fosse o piso onde o teste **FUNCIONA**.
Não é: a distribuição amostral de r é assimétrica em n pequeno, atanh só corrige em parte, e **o nível
nominal de 95% é fantasia**. Medido: rodando com `minNEff=3` (o que o código fazia), a precisão do sistema é
**84,6% [IC95 81,5–87,2], n=603** — não 95%. O "portal" (T≥18 s, tag real 2,5 s) roda a **n_eff = 9**, abaixo
do piso — **os 39,4% saíram de um regime que a própria curva condena.**

**A CURVA precisão × n_eff (MEDIDA, 1464 episódios-com-tag; 3 cadências × 2 posições; τ→0).** Como subir o
piso só REMOVE decisões abaixo dele, a linha "minNEff=k" **É** o desempenho do sistema com aquele parâmetro —
é curva de TRADE-OFF, não gráfico descritivo:

| minNEff = k | PRECISÃO do sistema (IC95 Wilson) | COBERTURA (IC95) |
|---|---|---|
| **3 (hoje)** | 84,6% [81,5–87,2], n=603 | 41,2% [38,7–43,7], n=1464 |
| 9 | 88,8% [85,7–91,2], n=508 | 34,7% [32,3–37,2] |
| 12 | 90,6% [87,4–93,0], n=415 | 28,3% [26,1–30,7] |
| **19 (PISO)** | **94,2% [90,6–96,4], n=257** | 17,6% [15,7–19,6] |
| 20 | 94,5% [90,9–96,8], n=238 | 16,3% [14,5–18,2] |

**PISO OPERACIONAL = n_eff ≥ 19** (menor k cujo **IC95-inferior** da precisão ≥ 90%, com ≥10 decisões).
Sensibilidade declarada (o piso é ESCOLHA DE PRODUTO, não constante da natureza): alvo 80% ⇒ piso 3; **85% ⇒
piso 9; 90% ⇒ piso 19; 95% ⇒ NUNCA alcançado** (o teto da suíte é ~94%). Só-destino ⇒ piso 14; só-baseline ⇒
nunca (span nulo não se conserta com piso nenhum).

**A curva do revisor está REFUTADA na forma, CONFIRMADA no fundo.** Ele citou "n_eff 4 → 0% · 6 → 15,4% ·
10 → 100%". Medido: em **n_eff ∈ [3,5) o teste NÃO DECIDE NADA** (0 decisões em 273 episódios — a barra
|r| ≥ tanh(1,96/√(n_eff−3)) é ~0,97 lá; não há "0% de precisão", há ZERO precisão) e ela **NÃO estabiliza em
100%**: é uma **RAMPA RUIDOSA** de ~85% (k=3) a ~94% (k=20), **sem joelho**. O fundo (o piso 3 é fantasia)
está certo; o degrau limpo não existe.

**A PREVISÃO DO 1 Hz — GATE BINÁRIO: ❌ NÃO SE CONFIRMA (por 3 s de T).** Previsão registrada: "tag 1 Hz +
T ≥ 15 s ⇒ cobertura >70% a alta precisão". Medido (receptor no destino, piso 19):
cobertura **53,1% [IC95 39,4–66,3], n=49**, precisão 88,5% [71,0–96,0], n=26. **Causa é CONTAGEM, não sinal:**
a 1 Hz, T=15 s tem teto de **16** leituras distintas — **abaixo do piso 19**; nenhum episódio de 15 s PODE
decidir. **MAS o mecanismo se confirma logo ali**: a T ≥ 18 s (n_eff = 19 = o piso) a cobertura é **70,3%
[54,2–82,5]** e a T ≥ 20 s, **85,2% [67,5–94,1]**. Ele acertou o efeito e errou o T. (No piso que ele
POSTULOU — 10 — a previsão passaria: 91,8% [80,8–96,8]. **A diferença entre confirmar e não confirmar É o
piso — e o piso é medido, não postulado.**)

**TABELA DE DIMENSIONAMENTO DA COMPRA** (piso 19; T e corredor = ARITMÉTICA de contagem, sobrevivem a
qualquer modelo; cobertura/precisão = SIMULADOR ⇒ INDICATIVAS, circular por construção):

| Δt_tag | T exigido | corredor @1,1–1,2 m/s | cobertura cond. (IC95) | precisão (IC95) |
|---|---|---|---|---|
| **2,5 s (tag REAL)** | 43,0 s | **47–52 m** | n=2 — **amostra pequena demais** | n=1 — **idem** |
| **1,0 s (1 Hz)** | 17,5 s | **19–21 m** | 68,4% [52,5–80,9], n=38 | 88,5% [71,0–96,0], n=26 |
| **0,5 s (2 Hz)** | 9,0 s | **10–11 m** | 85,2% [77,6–90,6], n=115 | 96,9% [91,4–99,0], n=98 |

**VEREDITO — o portal FECHA, mas não com a tag de hoje, e a recomendação de compra SE INVERTE:**
- **tag atual (2,5 s): MORTA.** Exige ~52 m de corredor observável (o revisor previu 27 m; com o piso medido
  é o DOBRO). Não existe no CD. **Nenhum receptor, span ou knob conserta — faltam PONTOS.**
- **1 Hz: ~21 m de corredor** — NÃO os ~11 m que o revisor previu (ele postulou piso 8–10; o piso medido é 19,
  e o corredor DOBRA). Fecha **só se a planta tiver um trecho de ~20 m observável de ponta a ponta.**
- **2 Hz (0,5 s): ~11 m** — cabe em qualquer planta, a 96,9% de precisão. Custa bateria (contexto: 1 Hz ≈ 1–2
  anos de CR2032; 0,5 s ≈ meses–1 ano).
- ⇒ **A PERGUNTA QUE DECIDE A COMPRA NÃO É DE RÁDIO, É DE PLANTA:** existe um trecho de ~20 m em que a câmera
  vê o operador ANDANDO até o posto? **Se sim → 1 Hz** (bateria boa). **Se não → 2 Hz** (o único que cabe).
  A "1 Hz é o ponto ótimo" da nota de bateria **só valia com o piso postulado**.

**Blindagem (Regra 10, no CI):** `visit-metrics.ts` ganhou `minNEff` (piso EXPLÍCITO, default 3 = aditivo,
comportamento histórico intacto) + `wilsonInterval()`/`formatProportion()` — **nunca mais se reporta precisão
sem IC e sem n**. A curva, o gate binário da previsão e a tabela de compra estão pinados em
`receiver-at-destino.test.ts` ("REGRA 10"). Regra 8 checada em toda colheita: **0 violações**.

**PENDENTE (o que esta medição NÃO resolve):** (a) a cobertura/precisão são do SIMULADOR (circular — ele gera
RSSI = f(dist) + ruído); o que é honesto aqui é a ARITMÉTICA (T, corredor) e o COMPORTAMENTO do teste. (b) A
verdade anotada (#4, a caminhada do dono) segue sendo o GATE CRÍTICO — mede se a visita ACERTA, não só se
DECIDE. (c) **Medir a planta**: existe o corredor de ~20 m? É essa a medição de campo que fecha a compra.

**PREVISÕES REGISTRADAS (para cobrar)**: (a) τ do resíduo da tag móvel virá MUITO menor que o das âncoras
(~1–2 s); (b) se vier, n_eff sobe, a barra |r| cai para perto de 0,5 e a cobertura por episódio salta bem
acima dos 15,5%; (c) a diversidade de canal, se o stack expuser, entrega mais n_eff que dobrar a cadência
— e sem custo de bateria.

**ORDEM DE EXECUÇÃO**: medir τ_móvel (hoje, dado existente) → arrancar a Onda 2 em PARALELO (não espera
nada) → decidir cadência/ESP32 com o τ na mão. A #31 fica onde está.

**ONDA 0 — hoje, sem hardware, decide o resto**: (1) re-scoring por VISITA janela-única [🔬 em
medição, decide H1]; (2) tracks estáticos [✅ medido] + separar mobília de pessoa parada +
confiabilidade de fronteira [⬜ decide H2]; GATE: se H1+H2 passam, segue; se H2 falha → evidência
local forte (NFC/botão) antes de refinar algoritmo.
**ONDA 1 — receptor de zona** (ESP32 na mesa, amplificador de gradiente NO DESTINO — ~0,9 década
esperado vs 0,42 hoje). Software pronto (multiSourceFisher). Regra a priori pinada.
**ONDA 2** — zonas semânticas + rede de Petri + workflow como prior de identidade.
**ONDA 3** — HSMM (duração) + conformance com limites.
**ONDA 4** — evidência objetiva (PLC/scanner/botão) — sem ela, só presença, não produtividade.

**LISTA DE PARADA** (não fazer, economiza meses): RSSI→metros p/ decidir; retomar v4; factor graph/
GTSAM (estado é DISCRETO — Petri+HSMM é o formalismo); GNN/Sinkhorn/GP-completo/transformer antes
das Ondas 0-2; prometer posição métrica por BLE; vender "AoA barato"/"universal".

### ❌ PREVISÃO DO REVISOR **REFUTADA** (2026-07-12) — a concordância-no-erro **NÃO** cai com a separação temporal

**A previsão registrada** (revisor externo, depois da Regra 13): *"os 41,2% de concordância-no-erro foram
medidos no PIOR CASO — fragmentos do tracker separados por ~1 s, quase a MESMA medição duas vezes. Entre
âncoras separadas por minutos/horas a correlação de erro DESPENCA para o teto de independência (8,8%). Se
cair, a k=2 entre âncoras reais rende o que a soma promete — **e a compra de 2 Hz pode baixar**."*

**A CURVA MEDIDA** (`receiver-at-destino.test.ts`, bloco "ADR-015 §2"; cenários **estendidos a 20 min** por
OPÇÃO — o default pinado de 240 passos não sustenta bins de minutos; 1 Hz, receptor no destino, piso 10,
τ→0, 156 operadores). Régua **A** = todos os pares (n grande, IC otimista na largura); régua **B** = ≤1 par
por operador por bin (sem pseudo-replicação). Teto de independência é **bin-local e model-free**: P(repete o
MESMO erro | 1º errado) ≤ P(2º erra):

| separação | pares (A) | 1º ERRA → 2º REPETE (A) | teto do bin | × teto | régua B (n) |
|---|---|---|---|---|---|
| 0–2 s (fragmentos) | 1719 | **24,4%** [16,6–34,5], n=86 | 5,4% | **4,5×** | 33,3% (n=6) |
| 2–10 s | 1335 | 17,9% [11,0–27,9], n=78 | 5,7% | 3,1× | 33,3% (n=12) |
| 10–30 s | 3238 | 20,3% [15,2–26,7], n=187 | 6,2% | 3,3× | 38,5% (n=13) |
| 30–60 s | 4720 | 19,0% [14,7–24,1], n=269 | 5,7% | 3,3× | 16,7% (n=12) |
| 1–5 min | 33334 | 20,5% [18,7–22,3], n=1943 | 5,7% | 3,6× | 36,4% (n=11) |
| **> 5 min** | 53241 | **21,5%** [20,1–23,0], n=3049 | 6,0% | **3,6×** | 36,4% (n=11) |

**A curva é PLANA — não cai, não é monotônica, não converge para o teto.** Entre episódios separados por
**mais de 5 minutos** o erro se repete tanto quanto entre fragmentos de 1 s.

**A CAUSA (a leitura que sai disto).** O erro correlacionado **não é artefato do fragmento**: é **propriedade
do OPERADOR, não do INSTANTE**. A geometria da trajetória daquela pessoa, **qual vizinho é confundível com
ela**, a colocação da tag no corpo e a distribuição do viés corporal ao longo do turno são **as mesmas** 5
minutos depois. **Separar no tempo não separa a CAUSA.** ⇒ **A Regra 13 sobrevive inteira** e o "n_eff
19+19=38" segue FALSO — agora não só no pior caso, mas em **toda separação medível**.

**A POLÍTICA COM DIVERSIDADE (implementada: `minSeparationMs` em `anchor-policy.ts`) — knob NULO.**
k=2, 1 Hz, piso 10: SEM diversidade **97,9% [IC95 94,0–99,3], n=142** de precisão de turno / cobertura 91,0%.
COM diversidade, o IC-inf varia entre **92,9% e 95,0%** conforme a separação exigida (≥10 s … ≥300 s) — a
**dispersão é do tamanho do "ganho"**. Não há efeito; há ruído. E na tabela de compra ela **PIORA**: no alvo
≥97% o piso exigido sobe de 12→14 (1 Hz) e 8→13 (2 Hz), porque exigir separação **remove âncoras** (n cai ⇒
Wilson alarga ⇒ IC-inf cai) **sem remover erro**. **Não incluir diversidade na compra.**

**LIMITE HONESTO DA REFUTAÇÃO.** O simulador modela mudança de **pose/rumo/região** ao longo da caminhada — e
isso **não decorrelacionou nada**. Ele **não** modela trocar de roupa, mudar a tag de bolso ou entrar por
outra porta. Refutado está *"a **separação temporal**, sozinha, decorrelaciona o erro"*. Se a decorrelação
vier de trocar o **bolso** da tag, isso é experimento de **campo** + mudança de **procedimento** — não é o que
a k=2 compra de graça no relógio.

### 💰 A COMPRA REAVALIADA — e o que DE FATO a baixou (não foi a diversidade: foi a DURAÇÃO DO TURNO)

Tabela com k=2 (concordância), receptor no destino, τ→0, **turno de 20 min** (contra os 120 s dos laudos
anteriores — que já declaravam sua cobertura de turno como "um PISO, não uma previsão"):

| alvo (IC95-inf) | política | Δt_tag | piso/ep | T exig. | corredor (1,1–1,2 m/s) | \|r\| exig. | cobertura turno |
|---|---|---|---|---|---|---|---|
| ≥95% | k=1 (ATUAL) | qualquer | — | — | **IMPOSSÍVEL** | — | — |
| ≥95% | k=2 | 2,5 s (ATUAL) | 8 | 18,0 s | 19,8–21,6 m | 0,66 | 60,3% |
| ≥95% | k=2 | 1 Hz | 12 | 11,5 s | **12,7–13,8 m** | **0,55** | 89,1% |
| ≥95% | k=2 | 2 Hz | 8 | 4,0 s | 4,4–4,8 m | 0,66 | 87,2% |
| ≥97% | k=1 (ATUAL) | qualquer | — | — | **IMPOSSÍVEL** | — | — |
| ≥97% | k=2 | 2,5 s (ATUAL) | — | — | **IMPOSSÍVEL** (nenhum piso ≤20) | — | — |
| ≥97% | k=2 | 1 Hz | 12 | 11,5 s | **12,7–13,8 m** | **0,55** | 89,1% |
| ≥97% | k=2 | 2 Hz | 8 | 4,0 s | 4,4–4,8 m | 0,66 | 87,2% |

**⇒ A TAG DE 2 Hz DEIXA DE SER OBRIGATÓRIA — mas o crédito é do k=2 + turno longo, não da diversidade.**
O laudo anterior ("≥97% só com 2 Hz, corredor 9,4–10,2 m") mediu turno de 120 s. Num turno realista o
operador tem **muitas mais oportunidades** de episódio ⇒ a k=2 acha dois decididos com muito mais frequência
⇒ a **população ancorada muda**. **A tag de 1 Hz atinge ≥97%** com corredor de **~13–14 m** e |r| exigido de
**0,55** (a faixa defensável — piso ≥12). **A tag ATUAL (2,5 s) NÃO atinge 97% em política nenhuma**: trocar a
tag segue necessário; o que caiu é *qual* tag.

**O QUE NÃO MUDA COM NADA DISSO** (é aritmética de contagem, não estatística — sobrevive à circularidade):
`T exigido` e `corredor`. Para um mesmo piso, o corredor é o mesmo em todos os laudos.

**A MEDIÇÃO DE CAMPO QUE FECHA A COMPRA (inalterada):** **existe um corredor reto de ~13–14 m** com a câmera
observando e o receptor no fim? Se sim → **1 Hz** (bateria boa). Se não → **2 Hz** (corredor de ~5–8 m).

## Feito (no `main`)

- Registro/nomeação de tags (`bt_tags` + `/tags-ble`).
- Estação TC22 (app robusto, tela viva, sem Grendene no header).
- Ingest efêmero (`bt-readings`) + relay socket `bt-readings` + snapshot.
- Homografia (retângulo de dimensão conhecida + arrastar pontos + grade de conferência).
- Fusão tag↔pessoa por correlação RSSI×distância + recusa honesta ("não sei").
- Rótulo AR na caixa da pessoa — **grade E tela cheia**.
- **Ponto da ESTAÇÃO na calibração** (origem correta da correlação) — commit `91aa48c`.
- **Fase 2 — tag fixa de REFERÊNCIA**: heartbeat da estação + drift do RSSI + leitura RSSI@1m
  (observabilidade; **não** entra na associação, que segue por correlação). Módulo puro `stationHealth.ts`
  + hook + chip; marcada na calibração (`refTag:{mac,px}`).
- **TC22 conecta ao hub sozinho**: descoberta UDP na LAN (broadcast `VISAO_HUB_DISCOVER` → o hub responde
  o endereço; `server/discovery.js` no MESMO processo — gate `single-hub.test.js`). Endereço também
  editável à mão (toque no subtítulo) e persistido, como fallback. "Sobe um, sobe tudo" travado em teste.
- **Costura de localização (ADR-012)**: contrato `LocatedEntity` (`src/localizacao/entity.ts`) + adapters
  do heurístico; a `TagsMapPage` consome a costura (prova viva).
- **Fase 0 do motor científico — harness de replay** (`src/localizacao/`, `docs/cientifica/fase0-harness-replay.md`):
  contrato de evidência + motor puro plugável + gerador sintético + métricas (RMSE/cobertura) + gate Vitest.
  **Baseline v0 medido: RMSE 24,4 m** no cenário-gate — o alvo que a fusão futura precisa superar.
- **Fase 1 (paralelizada)**: (A) **recorder opt-in** de dado real (`server/bt/recorder.js`, `BT_RECORD` OFF por
  default, metadados-only/LGPD, gitignored) + loader puro (`src/localizacao/recording.ts`); (B) **motor de fusão v1**
  (`src/localizacao/fusion-engine.ts`, centroide ponderado por RSSI) — **RMSE 12,29 m (~metade do baseline)** no gate
  sintético. Ganho honesto: sintético; campo tende a menos.
- **Fase 2 (paralelizada)**: (1) **motor v2 com modelo de movimento** (`src/localizacao/motion-engine.ts`, velocidade
  da tag + extrapolação) — 11,28 m no gate; (2) **suíte de benchmark** (`src/localizacao/scenarios.ts`, 9 cenários).
  **Achado honesto:** a fusão v1 é o ganho robusto (~43% vs baseline, 8/9); o v2 **empata** no agregado (14,8 vs 14,9)
  e perde em 4/9 por overshoot — ganho decisivo do v2 fica p/ um **v3 com extrapolação adaptativa por confiança**.
- **Fase 3 (torneio paralelo)**: 2 hipóteses de v3 (consistência × resíduo). Vencedor **`guarded-engine.ts`** (resíduo
  + confiança da base) — **14,35 m (−3,7% vs v1)**, vence 5/9. **TETO FÍSICO provado:** 4/9 cenários têm ganho de
  extrapolação ótimo = 0 → limite de 1 estação+RSSI; caminho além = **âncora/multi-estação**, não mais extrapolação.
  **Default segue o v1** (ganho do v3 é modesto/sintético/afinado à suíte) — v3 é candidato até **dado de campo** validar.

## Pendente (priorizado — REORDENADO 2026-07-10 pelo especialista, em resposta ao relatório consolidado)

> Ver `docs/cientifica/relatorio-especialista-resposta-2026-07-10.md` (resposta integral) e
> `status-implementacao.md` §Princípios institucionalizados. Ordem por valor imediato/esforço, não por
> ambição — o campo (real) sempre antes de qualquer coisa construída em cima de fundação sintética.

1. ✅ **Mineração das 6h reais** (quedas transientes/autocorrelação/cross-âncora) — FEITO, ver abaixo.
2. **Hello world de campo (2 min, o próprio dono sozinho, 1 tag no bolso)** — verdade trivial (todo
   track é ele), zero coordenação. Mede viés corporal real + correlação RSSI×distância com corpo de
   verdade + taxa de abstenção com alvo único. Não mede ambiguidade multi-pessoa, mas já destrava as
   perguntas de viés/GP. O roteiro completo de 6 min (`protocolo-teste-campo-indoor.md`) continua
   sendo o padrão-ouro quando houver disponibilidade — **ambos DEFERIDOS pelo dono**, não bloqueio
   técnico. É também o dado que decide se os knobs `maxDistRatio`/`distWeight` da v4 podem ser religados.
   **A mesma caminhada agora acumula TRÊS funções (especialista, 2026-07-11)**: (a) verdade anotável
   — a UI de anotação do player está pronta; (b) viés corporal real; (c) **teste direcional da
   hipótese do viés-como-feature**: num trajeto radial ida-e-volta (mesma geometria, placement
   fixo), a perna corpo-entre deve ter RSSI sistematicamente menor (esperado 4-12dB) E correlação
   RSSI×distância MAIS FORTE que a perna livre. A curva não-monotônica da bancada (viés moderado
   melhora precisão 84→90%) fica registrada como **direção CONDICIONADA a essa confirmação física —
   PROIBIDO tornear no sim antes dela** (seria a v4 com outro chapéu: mecanismo e gerador
   compartilhando o mesmo cardioide especificado); mesmo depois, o torneio exigirá sentinelas que
   quebrem o pressuposto direcional (placement sorteado por sessão, multipath descorrelacionante).
   ROI honesto do especialista: explorar a feature exige estimar orientação+placement (latentes
   novas); uma segunda estação compra dimensão de assinatura sem inferir nada.
   - 🔴 **PRIMEIRA TENTATIVA REAL (2026-07-10) — SEM SUCESSO, registrado honestamente**: câmera nova
     conectada, calibrada, tag cadastrada com nome. Achado antes desta tentativa: a grade (dashboard)
     nunca ligava a fusão tag↔pessoa nos tiles MJPEG (bug de wiring — `CameraWorkspace mode="tile"`
     não recebia `getReadings`/`calibrationRev`; só a câmera aberta em tela cheia e o tile WebRTC
     tinham a fusão ligada) — CORRIGIDO (`CameraWorkspace.tsx`/`CameraTile.tsx`, commit deste dia).
     Confirmado que o fix funcionou: o anel BLE (que depende da MESMA calibração/leituras) passou a
     aparecer na grade. **Mas o rótulo da pessoa segue "Pessoa `<id>`" mesmo depois do fix, mesmo
     pedindo caminhada contínua de ~10-15s sem parar** — ou seja, o problema NÃO é mais wiring, é a
     ASSOCIAÇÃO em si (`assign()`) não atingindo confiança para falar com corpo/RSSI real. Causa
     raiz AINDA NÃO diagnosticada (candidatos: `minMovement`/`windowMs` calibrados só no simulador
     não baterem com a cadência real de RSSI da estação; sinal fraco/instável na posição real da
     estação; environment com multipath pior que o assumido) — **não investigado a fundo ainda**
     porque o dono pausou o teste para seguir com a bancada de simulação.
   - 🔬 **PLANO DE DIAGNÓSTICO definido pelo especialista (2026-07-11): instrumentar o FUNIL, não
     o score** — a decisão final é o fim de uma cadeia de vetos; o silêncio pode morrer em
     qualquer elo. Registro por tick e por par (tag,track): n_pares na janela → span temporal →
     movStd do track → r → score → margem → gate que vetou. Candidatos ordenados por
     probabilidade×discriminabilidade: (1) **cadência real** — BLE de campo (advertising+scan
     window+dedup) pode entregar menos leituras/janela que o `minSamples` assume; comparar
     inter-arrival real (a mineração das 6h tem a distribuição) com o que o associador exige — se
     n_pares morre no gate 1, nada a jusante importa; (2) **relógio/latência** — ts de chegada no
     hub + jitter desalinha os pares (rssi,dist) e dilui r; teste discriminante: cross-correlação
     com lag variável — pico de |r| em lag≠0 é assinatura de relógio, e o próprio lag é a
     correção; (3) **multipath em movimento** — σ 5,6dB foi medido em âncoras PARADAS; tag móvel
     atravessa fading espacial; assinatura: σ da tag móvel >> σ das âncoras, r subindo com janela
     maior; (4) **escala do minMovement** — calibrado em sim; homografia real pode produzir metros
     diferentes → movStd real sob o limiar com a pessoa visivelmente andando. **E o diagnóstico
     NÃO espera corpo presente**: se a caminhada frustrada foi gravada (FUSION_RECORD estava
     ligado no hub na época), o replay com o funil instrumentado roda sobre ela HOJE.
   - ✅🔬 **FUNIL RODADO SOBRE A GRAVAÇÃO REAL (2026-07-11) — ASSASSINO LOCALIZADO EM MINUTOS,
     exatamente como o especialista previu.** Ferramenta: `diagnoseFunnel()` aditivo em
     `associate.ts` (por par: n_samples → span → movVar → r → score → margem → veredito, reusando
     a MESMA matemática do assign) + `diagnoseFusionSession()` + `npm run funnel` (leitura pura do
     arquivo de campo). Resultado na câmera do teste frustrado (`cam-8a95ac6090`, H calibrada,
     18,7 min, 12 pistas):
     - **9.877 ticks×par avaliados, ZERO SPOKE** — o silêncio reproduzido offline.
     - **Histograma de vetos: lowMovement 80,5% · constantSeries 15,1% · poucos samples 4,3%.
       NENHUM par jamais chegou ao score** — o funil morre antes de existir correlação.
     - **CAUSA RAIZ: a ESCALA da homografia.** A cena inteira projeta em ~0,9×1,3 "metros" — a
       calibração foi salva em unidade errada (dimensões do retângulo não estavam em metros
       reais). `movVar` máximo da sessão INTEIRA = 0,214, contra `minMovement=0,25` (≈0,5m de
       desvio): **o gate de movimento era fisicamente impassável — o rótulo NUNCA poderia falar
       com esta calibração**, por mais que a pessoa andasse.
     - **Contraprova**: a câmera SEM calibração (`cam-6da58c2c5e`, proxy 1/bh, 147 min) FALA —
       3.329 ticks×par SPOKE, ~300 episódios de rótulo (movVar p90=2,14 no proxy).
     - **Assassino nº 2 (real, não fatal): cadência BLE** — inter-arrival mediano do batch =
       2.063ms → só ~3,9 leituras DISTINTAS por janela de 8s (o tick de 500ms repete o último
       batch; o gate de contagem passa com amostras-escada). Produz o `constantSeries` alto e
       dilui r — mas não explica o zero absoluto.
     - **AÇÕES**: (1) IMEDIATA (dono): recalibrar a `cam-8a95ac6090` com os pontos do retângulo
       em METROS REAIS — o teste de campo pode ser repetido no mesmo dia; (2) produto: validar a
       unidade no fluxo de calibração (um retângulo de <2m de lado num galpão é quase certamente
       erro de entrada — avisar na UI); (3) pesquisa: `minMovement` adaptativo à escala da cena;
       (4) `windowMs`/`minSamples` cientes da cadência real de ~2s do BLE (contar leituras
       DISTINTAS, não ticks).
   - ✅🔬 **SEGUNDA RODADA DE CAMPO (2026-07-11, mesma noite) — A FÍSICA VALIDADA E O DEFAULT
     MUDADO PELO RITO COMPLETO.** O dono recalibrou (chão visível agora projeta ~4,4×5,0m —
     escala plausível, problema de unidade resolvido) e caminhou radialmente. Sequência:
     - Funil pós-recalibração: `movVar` saltou de max 0,049 pra **max 0,228** — mas ainda ZERO
       falas: o gate `minMovement=0,25` (calibrado no galpão sintético 8×6m) continuava
       impassável numa sala real de ~4×5m. Veredito migrou de "execução" para "knob".
     - **REPLAY CONTRAFACTUAL da mesma caminhada** (sem tocar produção): com `minMovement=0,15`,
       **28 falas com correlação até -0,91** — a pista do dono casou com a tag `CE:5D`
       repetidamente. **A correlação RSSI×distância está VALIDADA COM CORPO REAL pela primeira
       vez.** A cascata a jusante se comportou (âncoras morrem honestamente em série-constante;
       margem filtra empates); a cadência BLE de ~2s não impediu corr forte com movimento amplo.
     - **Torneio sintético da mudança** (12 cenários): 0,15 é NEUTRO no agregado (73,0%=73,0%);
       `parado` segue 100% abstenção (o caso que o knob protege — variância de gente parada é ~0);
       custo localizado: bloco 82,0→80,0%, falseLabels +1-2 em 3 cenários.
     - **DEFAULT MUDADO: `minMovement` 0,25→0,15** (`associate.ts` + espelho no
       `session-recorder.js`), com evidência dupla (campo + torneio) e re-pinagem consciente dos
       gates afetados (`replay-fusion.test.ts`: bloco/grade-sem-station/ancoras-multidao*;
       `persistence-tournament.test.ts`: PINS re-medidos — o quadro qualitativo do torneio da
       persistência NÃO mudou: ratio 0,68 vs 0,67, v1 segue reprovada).
     - **Falta para fechar o hello world**: o dono repetir a caminhada COM o default novo no ar
       (rebuild/restart do front) e ver o rótulo na tela; gravar; anotar no player; processar
       (task #4). A caminhada agora paga **QUATRO contas** (especialista, resposta ao laudo):
       verdade anotável, viés corporal real, teste direcional, e **ρ do resíduo da tag MÓVEL**
       (a autocorrelação medida veio de âncoras paradas — inclui o canal lento; a tag móvel
       atravessa o fading e deve descorrelacionar mais rápido; o ρ que importa pro n_eff ainda
       não foi medido).
   - 🔬 **RESPOSTA DO ESPECIALISTA AO LAUDO (2026-07-11) — o mapa novo, em execução**:
     - **Raiz comum dos gates**: minSamples+minMovement+minConfidence são três proxies discretos
       de UM teste — significância da correlação dado o nº de pontos INDEPENDENTES. Com ρ~0,7 @2s,
       as ~3,9 leituras distintas da janela valem **~0,7 ponto independente** — explica por que o
       campo precisou de −0,91 pra falar (espúrio |r|>0,5 é rotina com n_eff dessa ordem). Gate
       reformulado: Fisher z=atanh(r), falar exige |z| ≥ z_crit·√(1/(n_eff−3)), n_eff mínimo ~5-6.
       E o gate de movimento vira **std(log₁₀ d) em DÉCADAS** (adimensional — escala-aware por
       construção; limiar do ruído medido: ~0,25 década p/ SNR=1, prática 0,12-0,18; correlacionar
       RSSI×log(d) é o modelo físico e o r do par verdadeiro sobe de graça).
     - ✅🔬 **RODADA DE RECALIBRAÇÃO DOS GATES — TORNEADA (2026-07-11), 3 knobs entregues OFF por
       default (pins intactos, 340 testes verdes), com TRÊS leituras honestas**:
       (a) **O gate de significância COMO PRESCRITO é MUDO TOTAL** (0 falas em toda a suíte, e a
       matemática explica): no harness ~8-9 leituras distintas/janela → n_eff = 8·0,3/1,7 ≈ **1,4
       < 3**; com ρ=0,7 e minNeff=5, falar exige n≥28 leituras frescas ≈ janela de 30-60s, não 8s.
       **Inconsistência a devolver ao especialista: pelos números DELE (3,9 distintas → n_eff
       0,7), o gate como prescrito nunca falaria nem no campo** — a re-derivação precisa acoplar
       janela↔n_eff (windowMs maior quando o gate liga? ρ medido POR janela? — e o POST de 500ms
       muda o n mas também o ρ do lag menor). O knob está correto e testado; os PINOS zCrit/ρ/
       minNeff são incompatíveis com windowMs=8000.
       (b) **C (log+decades 0,12) é a candidata mais interessante**: precisão média +7,3pp, wrong
       −62% (556→209), cruzamento 78→97% — pagando metade da cobertura. DOIS FUROS: bloco DEGRADA
       (80→59,5% — o que sobra escapa da guarda de margem) e **décadas de metro ≠ décadas de
       proxy** (sem-calibracao fica 100% mudo; o limiar adimensional não transfere ao 1/bh — se
       promovida, o modo proxy precisa de limiar próprio ou veto explícito).
       (c) **B (log só) é ~neutro no sim POR CONSTRUÇÃO** (o sim gera RSSI por log-distância — a
       vantagem do span radial só aparece com dado real). É a mudança mais barata e fisicamente
       correta; a evidência decisiva é o replay de CAMPO pós-APK novo, não este sim.
       NADA promovido — como mandado.
     - **CADÊNCIA — ASSASSINO Nº 2 LOCALIZADO COM ENDEREÇO (diagnóstico nosso, mesma noite)**: o
       TC22 já roda `SCAN_MODE_LOW_LATENCY` (quase contínuo) — mas `POST_EVERY_MS=2000` no app +
       `onScanResult` guardando só a ÚLTIMA leitura por MAC descartava todo o resto (o
       inter-arrival de ~2,06s cravado em TODAS as tags é o POST, não o advertising). **CORRIGIDO:
       500ms** (≈4× leituras distintas/janela; custo +1,5 req/s na LAN, zero bateria de tag).
       Nunca interpolar RSSI (inventa pontos, infla n, enviesa r) — regra registrada.
       ✅ **APK rebuildado e instalado no coletor (2026-07-11, mesma noite) — VALIDADO EM
       PRODUÇÃO**: inter-arrival do batch caiu de ~2.060ms para **543ms (mediana; p90 556ms)** —
       110 batches/min vs ~29 antes (3,8×). O teto físico da janela de 8s subiu de ~3,9 para ~15
       batches. Ressalva de medição: âncora PARADA repete RSSI inteiro legitimamente (leitura nova
       com mesmo valor — o dedup do significanceGate subconta nesse caso, limitação conhecida e
       inócua: parada não fala mesmo); o nº real de amostras independentes de tag MÓVEL é o que a
       próxima caminhada mede (a 5ª conta da caminhada).
     - ✅🔬 **Grade (P*,K) da persistência — RODADA em sintético (2026-07-11), e a regra do
       especialista disparou: "se nenhuma célula fecha nem no sintético, o desenho muda antes de
       qualquer campo". Resultado em três achados**:
       (a) **A grade prescrita REPROVA em TODAS as 9 células** — a premissa quantitativa ("margem
       0,22 em multidão historicamente entrega ~93%") não se sustenta neste simulador: a curva
       estratificada MEDIDA dá **63%** para margem 0,2-0,3 em regime denso (o único bin ≥0,90 da
       curva inteira é denso [0,4-1]; o esparso teta em 77%). Com P* ∈ {0,90;0,95;0,98} quase nada
       qualifica — cobertura colapsa (0,00×-0,21× o baseline, PIOR que a v1 de 0,68×).
       (b) **A emenda cleanWindow contradiz o retuning POR CONSTRUÇÃO do proxy**: `hadConflict` é
       definido como "concorrente real E margem<0,3" (CONFLICT_MARGIN_THRESHOLD) — logo falas
       "limpas" NUNCA têm margem <0,3, e o canal que o retuning queria abrir (confirmar com margem
       comprimida em denso) é morto pela própria tradução proximidade-física→hadConflict. A
       tradução não era inócua.
       (c) **O DESENHO (condicionalização por regime) tem forma — fora da grade prescrita**: sweep
       diagnóstico com cleanWindow OFF: **(P*=0,60, K=4) → 0,42× erro-segundos / 1,03× cobertura —
       FECHA OS DOIS EIXOS** no sintético (também 0,55/K4 e 0,65/K2 fecham). O alvo de P* tem de
       vir da curva medida (~0,55-0,65 na sintética), não do chute 0,90+.
       **Estado**: mecanismo entregue ADITIVO (regime-reliability.ts + confirmPolicy em
       label-memory.ts, 20 testes novos, pins v1 intactos, grade roda no CI em <1s); NENHUM default
       promovido (regra mantida: curva precisa de âncora real; célula densa segue sintética com
       ressalva declarada nos headers). **Pergunta de volta ao especialista**: o P*~0,60 sintético
       é artefato do simulador (margens comprimidas demais por construção?) ou o alvo realista de
       precisão-implicada em regime denso é mesmo dessa ordem — e nesse caso a régua de produto
       ("rótulo errado é pior que nenhum") aceita confirmar a 60%? E qual proxy substituir na
       janela limpa, já que hadConflict é redundante com a margem?
     - **Viés direcional como feature**: desenho anti-v4 ARQUIVADO (4 passos: confirmação física →
       score auxiliar isolado medido por AUC sobre dado real anotado, nunca sim → torneio com
       sentinelas de placement/multipath → decomposição exigindo ganho vindo dos empates). A
       variável latente "orientação" a câmera JÁ mede (heading do track) — a feature mínima é
       corr(resíduo-de-RSSI, cos(heading vs direção track→estação)). **ROI: perde pra 2ª estação**
       — teste físico é grátis na caminhada; o esforço vai pra estação.
     - **🔺 2ª ESTAÇÃO PROMOVIDA: de "gated por hardware" para O ITEM DE MAIOR VALOR POR REAL
       INVESTIDO do backlog** (~R$30 de ESP32 contra um canal de identidade que a física mostrou
       estar no limite). Desenho decisivo do especialista, registrado para execução: (i) hardware:
       ESP32/NimBLE via MQTT ou Android aposentado — a correlação é INVARIANTE a offset de rssi0
       entre receptores (os 16dB de spread são irrelevantes aqui); requisito duro é RELÓGIO (NTP
       monitorado; 1s de offset a 1,2m/s = 1,2m de erro de pareamento); (ii) geometria: gradientes
       radiais cruzando a ~90° no centro da área útil (nunca perto da estação A); (iii) software:
       o contrato de gravação JÁ carrega `stationId` por batch — falta o software de fusão
       multi-estação (séries por (tag,station) + fusão por SOMA DE FISHER-Z, que o gate de
       significância já acomoda); (iv) protocolo: a mesma caminhada gravada pelas duas estações;
       depois sessão de 2-3 pessoas; (v) análise: replay contrafactual em 3 colunas (A só, B só,
       A+B), regra a priori FIXADA ANTES: precisão(A+B) ≥ máx(A,B), cobertura ≥1,5×, conflictRate
       ≤0,6×. **PREVISÃO REGISTRADA (cobrar)**: a razão de decaimento geométrico da cobertura
       (0,846/pessoa com 1 estação) SOBE visivelmente com A+B — se mover, valida que o teto era
       DIMENSIONAL, e trilateração/fator BLE de posição/factor graph (T1) ganham alicerce medido
       de graça na mesma gravação.
     - ✅🔬 **FUNDAÇÃO DO MOTOR UNIVERSAL CONSTRUÍDA (2026-07-11, ADR-013 — a "Fase 8" do dono com
       lastro)**: (i) vocabulário de evidência tipado pelos DOIS EIXOS QUEM×ONDE
       (`src/fusion/evidence.ts`: position2d/range/bearing/identity-series/identity-claim +
       SourceKind extensível); (ii) `sourceKind:"ble-rssi"` na gravação + `sourceId` preservado
       pelo loader em cada reading (gravações antigas byte-idênticas); (iii) **fusão de identidade
       multi-fonte por soma de Fisher-z ponderada** (`multiSourceFisher`, knob OFF; redução
       fonte-única BIT-EXATA provada; 2 fontes desempatam par espúrio de ~0,99→~0,3→abstém);
       (iv) checklist de entrada de sensor (1 página, rito de homologação). **MÉTRICA DE
       UNIVERSALIDADE MEDIDA: 61 linhas de motor + 1 de adapter** nesta entrega — a previsão do
       especialista ("chegada do ESP32 = ~zero linhas novas no motor, só o adapter preenchendo
       sourceId") fica pinada no docstring do knob para cobrança no dia. LIMITAÇÃO v1 declarada:
       cada fonte correlaciona contra a MESMA série de distância (estação principal) — fonte B
       vale como dimensão extra de assinatura; TrackDist por fonte (geometria própria, ganho
       pleno de ortogonalidade) é a fase 2, quando a estação B tiver posição cadastrada. O
       critério de entrada do factor graph agora é objetivo (ADR-013 item 6): 2ª fonte POSICIONAL
       independente (UWB/AoA/mmWave).
3. 🟡 **Contrato de gravação/pseudo-label** (session-recorder) — PARCIAL, 2026-07-10:
   - ✅ **Versão do algoritmo/knobs por sessão**: linha `"meta"` no JSONL (`gitRev` do hub via
     `git rev-parse --short HEAD` + espelho manual do `FusionConfig` DEFAULTS de `associate.ts`),
     escrita 1x por processo. `session-loader.ts` parseia (`SessionMeta`), retrocompatível com
     gravações antigas (`meta: null`).
   - ⬜ **Decisões do associador por tick (margem + candidatos rejeitados)** — GAP HONESTO: o
     associador (`TagTrackAssociator.assign()`) roda no CLIENTE (`useTagFusion.ts`, browser), não
     no hub que grava o JSONL (`server/bt/session-recorder.js`) — gravar isso exige um canal NOVO
     cliente→servidor (endpoint/socket) que não existe hoje; não construído sem necessidade
     validada em campo. A DEFINIÇÃO já está pronta em código: `PseudoLabelCandidate`/
     `AssignmentTick`/`findPseudoLabelCandidates` (`src/fusion/session-loader.ts`) — "episódio-
     candidato" = associação sustentada (≥5s), margem alta (≥0.15), sem conflito, sem troca de
     tag/id no mesmo track. Espera o wiring de gravação para ter dado real a minerar.
   - ⬜ **Offset de relógio hub↔TC22** — investigado e CONFIRMADO limite físico: o payload real do
     TC22 (`tc22-scanner/.../MainActivity.java:405`, contrato `{stationId, readings:[{mac,name,rssi}]}`)
     NÃO tem timestamp do dispositivo — todo `ts` é `Date.now()` do hub na chegada (mesmo achado já
     listado em `status-implementacao.md`, "ts de captura na borda"). Não implementável sem o TC22
     ganhar um campo de timestamp próprio; documentado como limitação, não inventado protocolo NTP.
     Se o TC22 um dia mandar `deviceTs`, a linha `{"t":"clock","ts":<hubTs>,"deviceTs":<...>}` é o
     formato natural a adicionar (o loader já tolera tipos de linha desconhecidos).
4. **Espalhar as âncoras em distâncias log-espaçadas** (ex.: 0,5/1,5/4/8 m à estação, não um retângulo
   compacto) — barato, destrava a identificabilidade do expoente `n` e amplia a malha de auditoria de
   resíduo (uma âncora perto do canto da `…CE:3C` separaria obstrução local de deriva da estação).
   Requer acesso físico — mesma disponibilidade do item 2.
5. **Set-membership ∩navegável** — RECALIBRADO: item de **produto** (anéis visualmente honestos), não
   degrau científico nesta arquitetura (câmera=posição já não precisa da restrição de mapa; anel de 1
   estação é isotrópico). Geometria pura já pronta (`floor-polygon.ts`); falta só a UI.
6. **Multi-estação** — gated (hardware é barato — ESP32/Android aposentado bastam — mas o custo real é
   que cada estação nova precisa da própria calibração/auditoria de deriva, como as 4 âncoras atuais
   já provam). Depois do campo, não antes.
7. ✅🔬 **Reliability diagram + taxa de conflito** — CONSTRUÍDOS 2026-07-10 (task #13). `conflictRate`
   NÃO é baixa (46,9% no canônico, ~90-98% em multidão) — **corrigiu a suposição do especialista** de
   que seria rara com poucas tags. Reliability é honestamente monotônico em `multidao`.
8. 🔬 **Hungarian+dustbin — REBAIXADO de volta para GATED** (correção de sequenciamento, especialista
   2026-07-10, revisão do escopo de persistência): a taxa de conflito alta (item 7) segue sendo o
   gatilho quantitativo, mas o **custo da lixeira seria calibrado contra uma paisagem de conflictRate
   que está prestes a mudar** — o item 9 (persistência) reduz o pool ativo a cada confirmação, o que
   baixa `conflictRate` por construção. Calibrar o dustbin contra o número de HOJE seria calibrar
   contra um mundo já obsoleto quando o dustbin entrasse em produção. **Gate corrigido: construir e
   medir o item 9 primeiro → re-medir `conflictRate` com persistência ligada → só então tornear o
   dustbin com o número pós-persistência.** Desenho do custo (derivado da curva de calibração, não
   knob livre) e regra a priori (erro total ≤ baseline, cobertura ≥ baseline, sobrevive às sentinelas,
   ganho decomposto como conversão abstenção→acerto) seguem valendo, só a ORDEM mudou.
9. **Persistência de rótulo no track** (produto — não ciência, mas rodada própria tipo v4) — escopo
   escrito em `docs/cientifica/escopo-persistencia-rotulo.md`, **REVISADO E APROVADO pelo especialista
   (2026-07-10)** com 3 correções incorporadas: (i) "sem conflito" na confirmação é LOCAL ao par
   track/tag (`Assignment.hadConflict`), não o `conflictRate` agregado de tick — senão multidão nunca
   confirmaria nada; (ii) **sentinela DUPLA** — id-switch-na-confirmação E id-switch-durante-`memória`
   (o pior caso real: troca silenciosa de ID do tracker num cruzamento, sem salto físico detectável,
   persistindo até o timeout); (iii) o `timeout` do estado `memória` vem da mineração de fragmentação
   (item 10), NÃO da curva de reliability (que calibra confiança de entrada, não sobrevivência de
   crença) — **isso torna o item 10 uma DEPENDÊNCIA desta rodada, não mais um item independente**.
   Ordem de construção corrigida: (1) minerar fragmentação → (2) máquina de estados → (3) sentinela
   dupla → (4) torneio → (5) revisão adversarial. **Construção e torneio começam já** (não é física
   nova); o **DEFAULT em produção** fica condicionado a dado (ou proxy) de id-switch com gente de
   verdade — diferente do hello world solo (item 2), que não testa ambiguidade multi-pessoa.
   - ✅ **(1) mineração de fragmentação** — feita, ver item 10.
   - ✅ **(2) máquina de estados** — `src/fusion/label-memory.ts` (`LabelMemoryPolicy`), pura, 15
     testes verdes. candidata→confirmada exige N=3 ticks consecutivos de fala QUALIFICADA (margem
     ≥0,4 — bin de alta confiança do reliability diagram, mais estrito que o `minMargin` de fala do
     associador — E `hadConflict:false`, LOCAL por par, Mordida 1). Confirmada→memória quando
     evidência fresca some; memória→confirmada na reentrada (mesma barra); quebra por contradição
     sustentada (N=3 ticks de outra tag qualificada) ou por timeout (12s, candidato da mineração,
     Mordida 3) — contradição FRACA não derruba ativamente (v1, backstop é só o timeout). Morte de
     track = ausência no array de assignments → remove a crença. **Ainda NÃO** wired em
     `useTagFusion.ts`/produção (por design — torneia no harness antes; ver escopo doc).
   - ✅🔬 **(3) sentinela dupla — FEITA e a Mordida 2 COMPROVADA, não só implementada**
     (`src/fusion/sim.ts` ganhou `forceSwitchAt` — troca determinística de trackId, sem RNG, no
     tick exato que o chamador escolher, byte-compat quando ausente; `src/fusion/
     persistence-sentinel.ts` acha o instante certo por replay-e-descobre: confirma → procura
     proximidade física real entre as 2 pessoas numa janela — só injeta quando acha um tick
     "sem salto", senão devolve `null` honesto). 6 testes verdes, **cenário determinístico
     (seed=1, "cruzamento")**: sentinela 1 (id-switch na confirmação) injeta no tick 6 — a crença
     CONFIRMA o rótulo ERRADO já ao nascer (a evidência que fecha a confirmação vem de antes da
     troca) e segue errada por ≥4 ticks medidos; sentinela 2 (id-switch durante memória, sustain=4
     ticks) injeta no tick 76 — crença errada por ≥10 ticks medidos, corrigindo só no tick 95 (9,5s
     depois da injeção) — **mais lento que a sentinela 1**, na direção que a previsão do
     especialista registrava (memória é o pior caso). Números fixos/reproduzíveis, não achados por
     sorte — documentados no teste.
   - ✅🔬 **(4a) métricas novas — FEITAS e a previsão do especialista CONFIRMADA quantitativamente**
     (`src/fusion/memory-metrics.ts`, 9 testes): `computeMemoryMetrics` (cobertura de experiência —
     tempo, não tick, pesado por delta real de `ts` — + erro-segundos decomposto fresco×memória) e
     `computeCorrectionLatencies` ("da quebra real até a tela parar de mentir", por episódio
     contíguo de desacordo crença×verdade). Medido nas duas sentinelas (seed=1, "cruzamento"):
     erro-segundos-em-memória da sentinela durante-memória (14,5s) é **mais que o DOBRO** da
     sentinela na confirmação (6s) — exatamente a direção prevista (memória é o pior caso, mais
     tempo pra exibir errado sem correção precoce). Números fixos, reproduzíveis, no teste.
   - ✅🔬🔴 **(4b) torneio — RODADO, e a v1 (defaults atuais) NÃO PASSA a regra a priori em
     agregado** (`src/fusion/persistence-tournament.test.ts`, 13 testes, PINS honestos — não
     forçados a passar). Suíte inteira (12 cenários) medida, baseline (associador cru, sem
     persistência) × com-memória, mesma unidade de tempo:
     - **Eixo 1 (erro-segundos ≤ baseline): PASSA.** Agregado 209 000ms → 95 500ms.
     - **Eixo 2 (cobertura de experiência ≥ N× baseline, N≥1): FALHA.** Agregado 20,84% → 13,88%
       (multiplicador ≈0,67× — CAIU, não subiu).
     - **Causa raiz (achada pela quebra por cenário, não chutada)**: em multidão
       (multidao/ancoras-multidao/ancoras-multidao-bias/ancoras-mismatch-n), a barra de
       confirmação (`confirmMargin:0,4` por `confirmTicks:3` consecutivos) é estrita demais pro
       regime de correlação mais ruidoso desses cenários — o track NUNCA confirma, e a memória
       fica ZERADA (0% cobertura, 0 erro) exatamente onde o baseline por-tick conseguia acertar
       OCASIONALMENTE (16-25% de cobertura ali). A decomposição por transição confirma que o
       canal legítimo existe (abstenção→acerto: 239 500ms, >>10× a regressão correto→errado: só
       8 000ms) — o mecanismo NÃO está "quebrado", só está OTIMIZADO para o caso simples
       (canonico/sem-calibração melhoram) e mal-calibrado pro caso denso.
     - **CONCLUSÃO, sem meias-palavras: v1 como está NÃO é candidato a default.** Precisa de
       retuning dos parâmetros de confirmação (ex.: barra adaptativa à densidade da cena, ou
       `confirmMargin` mais permissivo com `confirmTicks` maior compensando) numa PRÓXIMA rodada
       de torneio — não decidido aqui por chute; fica registrado como o próximo passo real antes
       de (5). Mesma disciplina do v4: achado negativo documentado com a mesma força que um
       achado positivo, nada escondido.
   - ⬜ **(4c) retuning — PLANO DEFINIDO pelo especialista (2026-07-11): mudar a VARIÁVEL da
     barra, não o número.** A falha de multidão não é "0,4 é alto demais" — é que margem absoluta
     é um proxy cuja taxa de câmbio varia com o regime (densidade comprime margens). Plano:
     (1) estratificar a curva de reliability por regime (estratificador mais barato: nº de
     candidatos avaliáveis no tick; binário denso/esparso já serve); (2) a barra vira
     **"precisão-implicada ≥ P\* por K ticks de fala qualificada"** — se margem 0,22 em multidão
     historicamente entrega 93% de acerto, ela confirma em multidão (a adaptatividade EMERGE da
     condicionalização, sem função ad-hoc de nº de tags); (3) grade de busca sobre (P\*, K) ∈
     {0,90; 0,95; 0,98} × {2; 3; 4} — 9 células, regra a priori como filtro, dois parâmetros com
     semântica probabilística em vez de dois números mágicos; (4) **emenda v2 da confirmação
     (nascida do achado "crença nasce já errada")**: janela de confirmação LIMPA — nenhum evento
     de proximidade <0,4m entre os K ticks que a fecham (ataca o modo de nascimento tóxico,
     custa quase nada de cobertura). **Previsão registrada do especialista**: com a barra
     condicionada, a confirmação volta a fechar em multidão e a cobertura de experiência supera
     o baseline por-tick no agregado mantendo erro-segundos abaixo — porque a decomposição
     (abstenção→acerto 239.500ms >> correto→errado 8.000ms) diz que o defeito é de câmbio, não
     de motor. Se nem assim houver célula que satisfaça os dois eixos em todos os regimes, ISSO
     é a evidência de que o denso exige política própria. Retornar ao torneio (4b) — régua
     pinada em `persistence-tournament.test.ts`.
   - ⬜ **(5) revisão adversarial** antes de qualquer default em produção — só depois de (4c) e um
     torneio que passe os dois eixos da regra a priori.
   - 🔬 **Diagnóstico unificador (especialista, 2026-07-11)**: a falha da persistência em multidão
     e a refutação da previsão (b) são o MESMO fenômeno — densidade comprime margens; a margem
     alimenta tanto a fala quanto a confirmação; num sistema com abstenção, colisão vira SILÊNCIO,
     não erro (por isso wrongRate satura e quem sangra é a cobertura). **Corolário verificado
     (2026-07-11, dados da família ×pessoas já medida)**: a cobertura decai GEOMETRICAMENTE —
     razão consecutiva 0,846±0,030 (quase constante, 2→7 pessoas), ~15%/pessoa adicional.
     Não-linear em nível (exponencial), coerente com colisão comprimindo margens continuamente,
     mas SEM joelho/limiar crítico. O corolário do especialista ("a não-linearidade deve estar na
     cobertura") fica confirmado na forma exponencial, não na forma de quebra de regime.
10. ✅🔬 **Fragmentação de tracks como proxy de id-switch — MINERADA 2026-07-10** (leitura pura de
    `server/bt/fusion-session.jsonl`, sem escrever/mover/apagar nada nele — invariante de gravação
    respeitada). Método: casar morte de track com nascimento de track NOVO próximo no tempo (≤15-30s)
    e no espaço (centro do bbox, dist≤0,15 normalizado), condicionado a `maxDisp≥0,06` durante a vida
    do track morto (ver caveat abaixo — o motivo do filtro).
    - **Achado prévio que quase contaminou a medição**: dos 312 tracks distintos vistos na câmera com
      sinal (90 min), **metade (157/312) tinha deslocamento total <0,02** (normalizado) — quase certo
      artefato de tracker sobre objeto parado/ruído, não pessoa andando. Medir fragmentação sem
      filtrar isso teria inflado o proxy com "flicker" de coisa parada (193 candidatos brutos, número
      descartado). Filtrando para tracks com movimento real (`maxDisp≥0,06`): 92 mortes de track
      "móvel" em 90 min (uma única câmera tinha sinal na janela gravada; a segunda câmera ficou vazia
      no período).
    - **Resultado condicionado**: 35-46/92 mortes de track móvel (38-50%, sensível à janela de
      casamento) acham um renascimento próximo — ou seja, a MAIORIA (50-62%) das mortes de track com
      movimento real são saídas de cena genuínas, não fragmentação. Gap temporal das que religam:
      mediana 6,5-9,1 s, p75 12,0-14,9 s, p90 13-18 s (a distribuição NÃO converge limpo ao alargar a
      janela de 15s→30s — a cauda continua crescendo, sinal de que o casamento por proximidade
      espaço-temporal é um proxy ruidoso, não uma medição definitiva).
    - **Parâmetro candidato para o `timeout` do estado `memória` (v1, a revisar com dado de campo
      real): ~12 s** — na zona mediana-a-p75 da janela de 15s (a mais conservadora/menos contaminada
      pela própria largura da janela de busca). Ordem de grandeza, não número definitivo — mesma
      ressalva que o especialista já havia registrado ("calibra a ordem de grandeza, não a verdade").
    - **Limitação honesta, registrada para não virar acidente**: (i) sem verdade anotada, não dá pra
      distinguir "id-switch real durante cruzamento de 2 pessoas" de "tracker perdeu e reencontrou a
      MESMA pessoa" — ambos os casos entram como "candidato"; (ii) a gravação disponível tinha muito
      pouca atividade humana real (grande parte dos tracks era ruído estático) — o número de eventos
      úteis é pequeno (92 mortes móveis, 35-46 candidatos) para uma estatística robusta; (iii) só 1
      câmera teve sinal na janela gravada. **O teste de campo com gente de verdade (item 2) continua
      sendo a fonte que resolveria isso de vez** — este proxy destrava a construção agora com um valor
      defensável, não substitui o dado real.
11. **Achado de código (2026-07-10, verificado por leitura, não suposição)**: o cálculo de
    margem/conflito (`associate.ts`) usa a matriz de score ESTÁTICA (pré-resolução gulosa) — um
    concorrente "fantasma" já consumido por OUTRO par ainda conta como rival. Isso **superestima**
    ambiguidade sistematicamente (nunca subestima) e pode explicar parte da taxa de conflito alta,
    em cima da colisão de assinatura 1-D. Não é bug (é simplificação defensável); registrado para
    informar a leitura do shuffle-baseline (item 7) e de qualquer refinamento futuro do dustbin.
12. **Bancada de simulação** (proposta do dono, `docs/cientifica/simulador.md`, avaliada e planejada
    2026-07-10 — plano em `C:\Users\crist\.claude\plans\peppy-wondering-garden.md`): generaliza
    `sim.ts` em World Spec JSON (mundos paramétricos, física calibrada pelos números já minerados
    nesta sessão — τ de autocorrelação, offsets regionais, viés corporal) + player visual (2 vistas
    sincronizadas) + modo de anotação que alimenta o teste de campo (item 2) via `SessionTruth`. Não
    duplica o simulador existente (generaliza `SimOpts`/`simulateFusionScenario`); risco técnico
    principal é reproduzir os 8 cenários pinados BIT-A-BIT antes de qualquer física nova (gate
    isolado, "passo zero"). **Trilha P (player, não toca `sim.ts`) pode rodar AGORA em paralelo** ao
    item 9 (persistência); **Trilha M (World Spec, mexe em `sim.ts`) espera o item 9 fechar** — dono
    único por arquivo por rodada, mesma lição do `session-loader.ts`.
    - ✅ **Fase 0 (Trilha P)** — feita: núcleo puro do player (`src/fusion/player/`) + rota `/replay`
      navegável (canConfigure), 18 testes. Ver commits de 2026-07-10.
    - ✅🔬 **Fase 1, passo zero (Trilha M) — FEITA, aceite §9.1 confirmado** (`src/fusion/
      world-spec.ts` + `world-spec.test.ts`, 13 testes): `WorldSpecV1` (JSON declarativo) → tradução
      pura pra `SimOpts` → MESMA `simulateFusionScenario` de sempre (decisão de baixo risco:
      NÃO reescreveu o miolo do gerador nem a ordem de consumo do RNG — só uma camada de tradução em
      cima). Os 12 cenários pinados de `FUSION_SCENARIOS` reproduzem **bit-a-idênticos** (`toEqual`
      profundo, não só métricas agregadas) pelo caminho novo. **Ainda NÃO tem física nova** — nenhum
      parâmetro aqui é "medido"; são os MESMOS defaults de sempre, só em JSON. A Fase 2 (física
      calibrada com os números já minerados nesta sessão — τ autocorrelação 0,49-0,94/2s, spread de
      offset regional ~16dB, viés corporal ~12dB médio validado contra quedas transientes, timeout
      de fragmentação ~12s) é o próximo passo — SÓ ali os dados reais/medidos entram de fato.
      Sequenciada corretamente: só começou depois que a rodada de persistência (item 9) pausou.
    - ✅🔬 **Fase 2, primeiro incremento — ruído RSSI autocorrelacionado (AR(1)), calibrado pelo τ
      medido** (`sim.ts`, knob `rssiNoiseTauS`, opt-in — ausente = IID, byte-compat total, os 12
      cenários pinados seguem intactos). Honestidade sobre a calibração: a mineração das 6h reais
      deu autocorrelação de 0,49-0,94 NUM LAG de 2s — invertendo ρ(Δt)=exp(-Δt/τ) pros dois extremos
      dá τ≈2,8s a τ≈32s, uma faixa LARGA (a mineração cobriu regimes de obstrução bem diferentes por
      âncora); por isso **não** cravamos um default único escondendo essa incerteza — quem liga o
      knob escolhe o τ explicitamente. 3 testes novos: controle positivo (regra institucionalizada
      nº4 — sem o knob, autocorrelação empírica ≈0, prova que SEM ele é IID de verdade) + a
      autocorrelação COM o knob bate a fórmula teórica (ρ=exp(-Δt/τ)) dentro de margem + byte-compat
      confirmado. Só se aplica ao RSSI de PESSOA por ora (âncoras seguem IID — limitação declarada,
      não medida ainda pra elas). Restante da Fase 2 (offsets regionais, viés corporal direcional,
      oclusão estruturada) segue pendente — próximos incrementos, mesmo padrão (opt-in, fonte
      marcada, byte-compat).
    - ✅🔬 **Fase 2, segundo incremento — offsets REGIONAIS por polígono (não achatado por
      emissor, por pedido explícito do dono)** (`sim.ts`, knob `rssiRegions`, opt-in): reusa
      `pointInPolygon` de `floor-polygon.ts` (mesmo primitivo do ∩navegável, sem duplicar
      geometria) — dentro de um polígono soma o `offsetDb` daquela região (pessoas E âncoras;
      regiões sobrepostas SOMAM, não "a primeira que bater"). FONTE: `rssi0` implícito variou
      16dB entre as 4 âncoras da calibração real (`relatorio-consolidado-2026-07-10.md` §4) —
      evidência de que um modelo único de propagação pro espaço inteiro é pobre. O MECANISMO está
      pronto e testado; os polígonos/deltas de uma família calibrada ficam pra Fase 3.
    - ✅🔬 **Fase 2, terceiro incremento — viés corporal DIRECIONAL** (`sim.ts`, knobs `bodyBias`+
      `tagPlacement`, opt-in, por pedido explícito do dono de fazer o modelo completo, não só a
      profundidade média): ângulo entre o heading (direção de caminhada, proxy da orientação do
      corpo) e a linha tag→estação, mais o lado do corpo (`peito`/`bolso-esq`/`bolso-dir`) —
      pior caso (`peakDb`) quando o corpo bloqueia a linha de visão, piso (`meanDb`) quando a tag
      encara a estação, `angWidthDeg` controla a largura da zona de sombra. Pessoa PARADA (sem
      heading real) usa só o piso — decisão explícita de não inventar orientação sem movimento.
      FONTE: `meanDb`/`peakDb` cruzam literatura (4-10dB médio, pico ~20dB) com a profundidade
      medida nas quedas transientes das 6h reais (~12dB médio); `angWidthDeg` é `[chute marcado]`
      até o teste de campo calibrar — marcado como tal, não escondido. 12 testes novos (unitários
      da função pura `bodyBiasDb` + integração ponta-a-ponta) provam: pior/melhor caso batem
      `peakDb`/`meanDb`; a colocação da tag rotaciona a direção efetiva; o valor nunca extrapola
      o intervalo [meanDb, peakDb]; pessoa parada usa só o piso; byte-compat quando ausente.
    - ✅🔬 **Fase 2, quarto e ÚLTIMO incremento — oclusão ESTRUTURADA (obstáculos)** (`sim.ts`,
      knob `obstacles`, opt-in, por pedido explícito do dono de fechar a Fase 2 inteira nesta
      sessão): polígonos de mundo com dois papéis independentes por obstáculo — `occludesVision`
      (dropout ESTRUTURADO, determinístico: segmento pessoa→câmera cruza o polígono → o tracker
      simplesmente não vê, mesmo efeito de `dropoutP` mas pela geometria, não sorteio) e
      `rfAttenDb` (atenuação de RF somada ao RSSI quando o segmento pessoa/âncora→estação cruza —
      múltiplos obstáculos cruzados SOMAM, mesma convenção de `rssiRegions`). Reusa
      `segmentIntersectsPolygon` (novo primitivo puro, algoritmo clássico de interseção de
      segmentos) contra as arestas do polígono. 8 testes novos (primitivo de interseção + bloqueio
      de visão + atenuação de RF isolada + soma de múltiplos obstáculos + byte-compat).
      **FORA DE ESCOPO v1, documentado no código, não escondido**: o acoplamento "id-switch
      elevado na SAÍDA da oclusão" que `simulador.md` §4 propõe fica pra uma rodada futura — exige
      estado extra (há quanto tempo a pessoa estava oculta) que este incremento não adiciona;
      `idSwitchOnCross` (proximidade física) segue sendo o único mecanismo de id-switch hoje,
      independente deste knob.
    - **FASE 2 COMPLETA** — os quatro incrementos de física medida (ruído AR(1), offsets
      regionais, viés corporal direcional, oclusão estruturada) estão prontos, testados (73 novos
      testes em `sim.ts`/`sim.test.ts` ao todo nesta rodada) e **todos** byte-compat com os 12
      cenários pinados (nenhum default mudou). Nenhuma família/curva calibrada foi criada ainda
      com eles — isso é Fase 3 (famílias paramétricas, ≥20 seeds/ponto, IC — próximo passo natural
      quando houver prioridade pra isso) ou o teste de campo real decidindo os valores finais.
    - ✅🔬 **Fase 3, primeira leva (2 frentes paralelas, propriedade exclusiva de arquivo)**:
      - **(A) Famílias paramétricas** (`src/fusion/families.ts`, 6 testes): `runFamily()` — um
        eixo varia, seeds determinísticos 1..N (default 20, §7.1), IC 95% por bootstrap percentil
        (LCG próprio seedado, zero Math.random), decomposição por tipo de erro OBRIGATÓRIA
        (wrong/falseLabels/idSwitches junto de precisão/cobertura). Cada célula é literalmente
        `replayFusion(simulateFusionScenario(...))` — motor único, nada reimplementado. Primeira
        família concreta: `FAMILY_PRECISION_VS_PEOPLE` (people 2..7). CI roda eixo reduzido; a
        curva completa fica atrás de `FAMILY_FULL=1`.
      - **🔬 Previsão (b) do escopo ("a curva precisão×pessoas tem JOELHO") — ⚠️ LEITURA
        RETIFICADA pela revisão adversarial da Fase 4 (2026-07-11)**: a leitura original deste
        item ("wrong acelera 10→87, o joelho aparece na decomposição") NÃO sobreviveu à
        normalização — o crescimento era majoritariamente do DENOMINADOR (nº de decisões cresce
        ~3,5× no eixo). Normalizado, `wrongRate` SATURA (2,4%→5,3%→platô ~5,5%), curva côncava —
        o oposto de aceleração; e `people=2` é incomparável (1 tag → swap impossível). **Veredito
        corrigido: previsão (b) mais próxima de REFUTADA** — o que degrada com densidade são
        cobertura (41%→17,7%) e precisão (89,6%→72,2%), em declive suave. Ironia registrada: a
        leitura errada usou a bandeira da "regra da decomposição" enquanto caía na armadilha da
        contagem absoluta — a regra certa é decompor EM TAXAS quando o eixo muda o nº de
        oportunidades. Correção estrutural: `FamilyPoint` agora carrega `wrongRate`/`swap`/
        `opportunities` (a armadilha não se repete).
      - **(B) Modo anotação — núcleo puro** (`src/fusion/player/annotation.ts`, 10 testes):
        estado imutável de anotação (trackId → mac|null|ausente — os TRÊS estados de
        `SessionTruth` preservados), export com MAC normalizado, import pra retomar sessão,
        resumo pra UI futura. SEM UI de propósito: o player ainda não abre gravação real, e
        anotar sintético não faz sentido (a verdade já nasce pronta lá). É a ferramenta que
        faltava pro dia do teste de campo (item 2) — anotar o roteiro de 6min em minutos.
      - ✅🔬 **Fase 3, segunda leva (2 frentes paralelas, 2026-07-11)**:
        - **3 famílias novas** (`families.ts`): ×ruído (rssiNoiseDb 2..12 — degrada suave, 95,2%→
          55,1%, sem joelho), ×viés corporal (⚠️ RETRATADA E RE-MEDIDA — ver revisão adversarial
          da Fase 4 abaixo: a curva original "84%→14,7%" mediu um mundo com o SINAL do viés
          invertido; a curva correta é NÃO-MONOTÔNICA: 84%→~90% em 4-12dB → 80,4% em 24dB)
          e ×erro de cadastro de âncora. Knob novo `anchorPosErrorM` em `sim.ts`
          (modela posAssumed≠posReal do §3 — desloca SÓ o cadastro exportado, física intacta,
          byte-compat).
        - **🔬 PREVISÃO (c) DO ESCOPO — CONFIRMADA COM NÚMEROS** ("erro de posição de âncora move
          auditoria e anéis, NÃO a precisão de identidade; se mover, há acoplamento escondido"):
          curva completa (20 seeds/ponto), precisão **86,5% em TODOS os 5 pontos** (0 a 2m de
          erro), decomposição bit-idêntica. Coerente com gate/blend OFF por default: a correlação
          não consome posição de âncora. O teste roda em CI comparando os ICs dos extremos — se um
          dia gate/blend voltarem aos defaults e criarem o acoplamento, este teste FALHA com
          mensagem "ACHADO: acoplamento escondido" (sensor permanente, mesma família das
          sentinelas de viés do v4).
        - **Comando ponta-a-ponta (aceite §9.3 ✅)**: `npm run family -- <nome>` (scripts/
          family.mjs — spawna o vitest com FAMILY_FULL=1, sem dependência nova) imprime a curva
          completa com IC + decomposição. Sem argumento lista as 4 famílias.
        - **Player abre GRAVAÇÃO REAL (aceite §9.2 parcial ✅) + UI de anotação (§6 ✅)**
          (`ReplayPlayerPage.tsx` + `player/session-view.ts` novo, 12 testes): .jsonl lido 100% no
          cliente (LGPD — nada sobe), domínio da planta calculado do bounding box real (fallback
          8×6), painel de anotação (track → MAC/sem-tag/limpar, os 3 estados de SessionTruth),
          export/import por download local manual (padrão cine-loop). Anotar pinta o track no
          replay na hora. Limitações declaradas: enquadramento pelos primeiros 2000 ticks; lista
          de tracks sem virtualização (gravações de horas ficam pesadas de rolar, não travam).
      - **Restante da Fase 3/4**: pino das curvas quando estabilizarem (§7.1), aceite §9 formal
        (o §9.4 — SessionTruth anotado consumido por replayFusionSession sem adaptação — está
        construído mas nunca exercitado com gravação real de verdade: falta o teste de campo),
        e revisão adversarial da bancada (§12/Fase 4 do plano).

### Previsões falseáveis registradas (especialista, 2026-07-10 — cobrar depois de medir)

- **(a) FALSEADA — mas por prova matemática, não fraqueza estatística** (`src/fusion/shuffle-baseline.ts`,
  2026-07-10): `shuffleConflictRate` deu **bit-a-bit idêntico** à taxa real em TODOS os cenários testados
  (canonico/multidao/bloco/cruzamento/ruido-alto) e TODOS os seeds (≥6). Motivo provado, não medido: o
  `hadConflict`/`conflictRate` (`associate.ts`) é calculado inteiramente da matriz de scores por
  (pista,tag) — nunca olha nome de tag nem verdade. Renomear tags por bijeção fixa é permutação de
  COLUNAS da matriz; margem top-2 e "houve conflito" são invariantes a qualquer permutação de colunas —
  não existe shuffle desse tipo capaz de mudar o resultado. **O desenho testado é estruturalmente cego
  a essa pergunta.** Um baseline de verdade precisaria quebrar a CORRESPONDÊNCIA FÍSICA RSSI↔trajetória
  (ex.: ruído independente da posição), não só renomear identidade — registrado como direção futura,
  fora do escopo de hoje. As funções (`shuffledScenario`/`meanShuffleConflictRate`) ficam como ferragem
  reusável para esse baseline futuro corrigido.
- **(b)** Alongar a janela de correlação (`windowMs`) derruba a taxa de conflito MAIS do que melhora a
  precisão média — ataca a colisão, não o ruído. Não testado ainda.
- **(c)** A segunda estação, quando existir, derrubará a taxa de conflito desproporcionalmente ao
  ganho de precisão — duplica a dimensão do espaço de assinatura. Gated por hardware.

### Reliability diagram SEM o corte de produção (minMargin:0) — medido 2026-07-10

Comparado à curva de produção (minMargin 0.1) nos 3 cenários mais relevantes: o corte sempre melhora
SÓ o bin mais baixo (bins 1-4 são idênticos entre cru e produção, por construção — a margem não
depende do corte, só a filtragem final depende). Onde o corte MAIS vale: `bloco` — bin 0 cru é
quase cara-ou-coroa (59,3%, n=216); com o corte de produção vira 85,0% (n=40, o maior salto dos três)
— exatamente o caso ambíguo que motivou a guarda originalmente. Em `canonico`/`multidao` o ganho é
mais modesto. `canonico` cru tem uma leve NÃO-monotonicidade nos 3 primeiros bins (80,0%→77,8%→74,3%
antes de subir) — provavelmente ruído de amostra pequena, não inversão estrutural.

### Feito em 2026-07-10 (upgrade medido pelo harness — ver `docs/cientifica/harness-associacao-indoor.md`)

- ✅ **Guarda de ambiguidade top-2** (minMargin 0.1, novo default por torneio com regra a priori):
  erros da suíte −46%, id-switches 59→6, `bloco` 60,8→82,0% de precisão; + fix do furo de oclusão
  (dono ocluso segue vetando — reproduzido e testado).
- ✅ **CameraTile passa `stationPx`** (usa `useCameraTagLabels`, o caminho do fullscreen) — +32 pts medidos.
- ✅ **Calibração não fica mais stale** (rev por câmera via `camcfg-updated {kind:"calibration"}`, ADR-006).
- ✅ **Hungarian medido e rejeitado como default** (wrong +4,9% vs guloso) — knob `optimal` existe, desligado.
- ✅ **Plotagem de tags no chão** (monitoramento, grade+fullscreen): âncoras nos cantos (amarelo, posição
  exata), estação e ANÉIS de distância (ciano, tracejado — honesto: 1 antena = distância, não posição) p/
  tags não-associadas; RSSI→distância **calibrado ao vivo pelas âncoras** (`floor-plot.ts`; span estreito →
  regime `anchors-offset`: offset calibrado, expoente fixo). Anomalia (âncora muda >15 s) em vermelho.
  Revisão adversarial: anel-fantasma no horizonte (cheirality) e identificabilidade do fit corrigidos.
- ✅ **UX das âncoras na calibração**: tag já usada (âncora de outro canto / referência) aparece
  DESABILITADA com o papel visível — não some (sumiria = "fora de alcance") nem confunde.
- ✅ **v4 — evidência de distância absoluta (tags-âncora calibram o RSSI)**: implementada, torneada,
  **revertida pela revisão adversarial** (circularidade sim↔fit provada — com viés corporal real a
  v4 ligada piora drasticamente, precisão 26%/cobertura 1,8%). Decisão final e ADOTADA: **tags-âncora
  nunca são candidatas a pessoa** (`excludeTags`) — captura o ganho real sem modelo de RSSI no
  caminho. Gate (`maxDistRatio`) e blend (`distWeight`) ficam como knobs de PESQUISA desligados,
  com 2 sentinelas de viés permanentes no harness (`ancoras-multidao-bias`, `ancoras-mismatch-n`).
  Detalhes: `docs/cientifica/harness-associacao-indoor.md` §v4.
- ✅ **Orientação de instalação documentada na UI**: passo "Estação BLE" da calibração
  (`CalibrationPanel.tsx`) ganhou dica (`Alert tone="info"`) para fixar a estação BLE junto da
  câmera — texto honesto e escopado ao modo sem calibração (medido: +27 pts, 71,8% vs 44,5%, ver
  `docs/cientifica/harness-associacao-indoor.md`); comentário no código cita a fonte do número.
- ✅ **Geometria pura do set-membership ∩navegável** (`floor-polygon.ts`): point-in-polygon + recorte
  do anel por polígono, 100% testado, ZERO consumidores em produção ainda (falta a UI — recalibrado
  como item de produto, não ciência, ver §Princípios institucionalizados em `status-implementacao.md`).
- ✅ **Mineração das 6h reais** (sem precisar de pessoas): quedas transientes de RSSI por âncora =
  proxy de atenuação corporal (profundidade média ~12 dB, dentro do envelope estimado pelo
  especialista); autocorrelação temporal alta (0,49-0,94 em 2 s) — confirma que o ruído real NÃO é
  independente amostra-a-amostra como o simulador assume; cross-âncora mostra 66-72% das quedas são
  LOCAIS (não evento global) — valida o desenho do resíduo-por-âncora; `…CE:3C` tem o maior nº de
  quedas (490 em 7h) com distribuição de cauda pesada (obstrução intermitente, não multipath
  estrutural constante). Detalhes: `docs/cientifica/relatorio-consolidado-2026-07-10.md` §9.5.

## Limites honestos (não são bugs — física de 1 estação + RSSI)

- Pessoa **parada** ou em **aglomerado** → tende a "não sei" (SNR≈1; sem movimento não há o que correlacionar).
- **Posição em metros vem da CÂMERA** (homografia); o BLE só decide **QUEM**. Marcar estação/referência
  melhora o "quem", não adiciona posição.

## Fora deste arco (ver memória `homolog-estado-deploy`)

- Deploy dos acumulados no homolog (disco ~99% — risco em pé).
- Segurança: rotacionar senha admin/Postgres + `AUTH_SECRET`; instalar poda de backups + sudoers.
- Fine-tune (recall em multidão além do teto S@896) — bloqueado em GPU (Colab/cloud).
