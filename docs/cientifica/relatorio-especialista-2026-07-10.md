# Relatório para reavaliação — o que fizemos com as suas sugestões

> **Para:** o especialista/consultor científico que redigiu `base.md`, `exploracao.md`, `dev.md`,
> `pedido_caderno.md` e o `caderno-provas-visuais.html` — o brainstorm associativo que fundamenta
> esta trilha de pesquisa (fusão BLE+visão, factor graphs, GP/kriging, transporte ótimo etc.).
> **De:** a implementação (2026-07-10), depois de um dia inteiro de construir, medir, e **reverter**
> uma peça do que foi tentado. **Pedido:** reavaliar as decisões e as perguntas abertas ao final.
>
> **Como ler isto:** cada seção mapeia de volta ao documento/seção que sugeriu a técnica. Números são
> medidos (harness determinístico, reproduzível), não estimados. Onde revertemos algo, dizemos por quê
> — "documentar até o que não funciona" é regra da casa (`CLAUDE.md` §2.5).

## 0. Resumo executivo

- **Corrigimos o alvo primeiro.** As primeiras 3 fases de trabalho (não detalhadas aqui — ver
  `fase0-harness-replay.md`) mediam um modelo de localização por **GPS** (estilo "AirTag" para
  veículo/pátio externo). O dono corrigiu o rumo: o problema real é **pessoas caminhando indoor, sem
  GPS** — exatamente o que os seus documentos descrevem. Reapontamos para o modelo certo:
  **câmera = posição** (homografia), **BLE = identidade** (associação).
- **O associador de produção existia mas nunca tinha sido medido.** Construímos um harness
  determinístico (simulador + replay + métricas de identidade) que mede o algoritmo REAL rodando em
  produção, não uma cópia. Isso abriu a porta para tudo o que vem a seguir.
- **Testamos sua tese central mais ambiciosa até agora — evidência de distância absoluta via
  tags-âncora (o análogo de LANDMARC/fingerprinting) — e ela FALHOU sob viés realista.** A
  revisão adversarial provou circularidade entre o simulador e o modelo de calibração. Isto é o
  achado mais importante deste relatório (§4).
- **O que sobreviveu e foi adotado:** um mecanismo mais simples e comprovadamente imune a viés
  (excluir âncoras da candidatura à identidade), a guarda de ambiguidade top-2, e um
  auto-diagnóstico por âncora (data-snooping de geodésia, `base.md:351`).
- **O que está pronto mas não decidido:** a ferramenta de coleta de campo real está pronta e já
  acumulou ~6h de gravação contínua hoje (`server/bt/fusion-session.jsonl`, não commitado/LGPD) —
  mas é captura "deixada ligada" durante o trabalho normal, **não** o roteiro deliberado de ~6 min
  com verdade anotada (trackId→MAC) que o protocolo pede. Nenhum replay com verdade real foi feito
  ainda. Essa é a peça que falta para decidir se os mecanismos revertidos merecem uma segunda chance.

## 1. O que existia antes de hoje (contexto rápido)

`src/fusion/associate.ts` já implementava, em produção, a física que `base.md` descreve como o único
sinal viável com 1 antena e sem IMU: correlacionar a série de RSSI de cada tag com a série de
distância-à-estação de cada pessoa rastreada pela câmera (via homografia). Isto é o "caminho C" —
mencionado no cabeçalho do próprio arquivo desde antes desta rodada. O que faltava: **medição**.

## 2. O harness de medição (a fundação que `dev.md` §3 pede primeiro)

`dev.md` é explícito: *"o contrato de evidência e o harness de replay vêm antes de qualquer algoritmo
sofisticado, porque tudo o mais se constrói sobre eles."* Foi exatamente a ordem seguida:

| Peça | Arquivo | O que faz |
|---|---|---|
| Simulador do galpão | `src/fusion/sim.ts` | Pessoas caminhando (parado/bloco/cruzamento/waypoint), câmera virtual com a **homografia real** de produção, tracker com ruído/dropout/troca-de-ID, BLE log-distância + ruído |
| Motor puro medido | `src/fusion/replay-fusion.ts` | Roda o `TagTrackAssociator` **de produção** (não uma cópia), alimentado **exatamente** como `useTagFusion.ts` faz (tick 500 ms, pula tick sem leituras) |
| Métricas de identidade | `src/fusion/identity-metrics.ts` | certo/errado/absteve/falso-rótulo/id-switches — a invariante do dono ("rótulo errado é pior que nenhum") virou número: **precisão quando fala** é o número mestre |
| Gate no CI | `src/fusion/replay-fusion.test.ts` | Pinos medidos por cenário; qualquer regressão de knob/algoritmo quebra o teste |

Isto é o "embrião conceitual" que `dev.md` §3 previu que o caderno de provas visuais seria — só que
rodando sobre o algoritmo real, não uma demonstração isolada.

## 3. O que a medição revelou sobre o associador atual (guarda + Hungarian)

Suíte sintética de 8 cenários (canônico, parado, bloco, cruzamento, ruído-alto, multidão,
sem-calibração, grade-sem-station). **Baseline (guloso puro, sem guarda de ambiguidade):**
wrong=612, correct=1014, precisão média 70,0%.

**Guarda de ambiguidade top-2** (`minMargin`, análoga a um teste de significância entre os dois
melhores candidatos — não está nomeada nos seus documentos, mas seu espírito é o mesmo dos "axiomas"
que você lista, como a Navalha de Occam aplicada à decisão "falar ou abster"): torneio com regra a
priori (reduzir erro ≥30% mantendo acerto ≥70%) → **wrong 612→332 (−46%), precisão média 70,0%→73,8%**,
pagando cobertura (o trade-off certo, dado a invariante do dono). Virou default.

**Hungarian/atribuição ótima global** (`optimal`, o degrau clássico antes do seu Sinkhorn, §3 do
`base.md`): medido e **rejeitado** como default — sozinho, wrong=642, **pior** que o guloso (612).
Achado honesto: maximizar a soma dos scores força pares medíocres que o guloso deixava de fora.
**Isto muda a leitura do seu roadmap**: Sinkhorn/transporte ótimo (`base.md` §3, "a peça
patenteável") só parece fazer sentido **combinado com um modelo de ambiguidade** — não como
substituto direto do guloso+guarda. Fica registrado como pergunta aberta (§6).

## 4. O experimento que mais importa: distância absoluta via tags-âncora (e por que foi revertido)

Esta era a tentativa mais direta de operacionalizar a sua tese (nossa, na verdade — o dono formulou
"as tags fixas são sensores de calibração, não só a antena", e nós fomos atrás de como os SEUS
documentos sustentam isso): **A2 (GP/kriging: âncoras calibram o mapa de propagação, `caderno` §5)**
e **A4 (cold-start físico + auto-auditoria via data-snooping, `dev.md` §1 / `base.md:351`)**.

### O que foi construído

- `src/fusion/floor-plot.ts`: `fitPathLoss` — ajusta o modelo log-distância (RSSI = rssi0 − 10·n·log₁₀(d))
  usando as 4 tags-âncora da calibração, cujas posições-mundo são conhecidas. Gate de
  identificabilidade honesto: com as âncoras do campo real do dono (span de distância à estação de
  apenas ~0,7–1,6 m — um retângulo de calibração pequeno), o expoente `n` não é identificável; o fit
  cai num regime **`anchors-offset`** que calibra só o offset do ambiente, com `n` físico fixo — mais
  honesto que fingir calibrar os dois graus de liberdade com dado insuficiente.
- Contrato aditivo no associador: `TagReading.distM?` (distância absoluta estimada) +
  `TrackDist.metric?` (a pista está em metros reais, não proxy). Dois mecanismos opcionais: **gate**
  (veta par cuja distância RSSI diverge da distância-câmera, em log-espaço — o erro de RSSI é
  multiplicativo) e **blend** (repondera a confiança por consistência física).

### O torneio disse "sim"

Regra a priori (erro da suíte ≤85% do baseline E acerto ≥90%): a config **gate 2,5 + blend 0,3**
venceu — precisão média (suíte com âncoras) **70,8%→75,4%**, erro total **−24,7%**.

### A revisão adversarial disse "não" — e provou por quê

Duas falhas estruturais, ambas **reproduzidas experimentalmente**, não hipotéticas:

1. **Circularidade sim↔fit.** O simulador gera RSSI com o **mesmo modelo log-distância** que o fit
   assume — o torneio media o mecanismo no único mundo onde ele é ótimo por construção. Ao injetar
   **−6 dB de atenuação corporal** só nas tags carregadas por pessoas (um viés real — o corpo humano
   absorve 2,4 GHz — que o simulador honesto original não tinha), a v4 ligada **despencou para 26% de
   precisão / 1,8% de cobertura** — pior que desligada.
2. **Decomposição do ganho.** Ao separar `wrong` em "erro em âncora" vs. "erro pessoa↔pessoa", TODO o
   ganho medido pelo torneio vinha de **âncoras deixando de ser confundidas com pessoas** (falsos-
   rótulos de âncora 73→1 e 78→0 nos dois cenários). O erro pessoa↔pessoa — a coisa que a evidência de
   distância deveria resolver — **piorou** com o mecanismo ligado. A narrativa "distância absoluta
   separa pessoas a distâncias diferentes" não se sustentava nos dados que a sustentavam.

### Decisão final (o que ficou)

- ✅ **Adotado:** tags-âncora cadastradas **nunca são candidatas a identidade de pessoa**
  (`excludeTags`, aplicado antes da associação). Captura o ganho real (o que estava genuinamente
  quebrado) sem depender de nenhum modelo de RSSI — **imune ao viés por construção**, não por sorte.
- 🟡 **Gate/blend de distância absoluta**: implementados corretamente (semântica corrigida: o blend
  nunca resgata um par que a correlação recusaria; o gate em log-espaço; um par vetado continua
  concorrendo na guarda de ambiguidade, não libera a tag para o vizinho) — mas **desligados por
  default**. Ficam como knobs de pesquisa.
- ✅ **Duas sentinelas de viés permanentes** entraram na suíte (`ancoras-multidao-bias`,
  `ancoras-mismatch-n`) — qualquer futura re-adoção terá que sobreviver a elas. Isto é o "teste de
  data-snooping" que você cita (`base.md:351`) aplicado ao **próprio processo de validação**, não só
  aos dados de campo.

## 5. Auto-diagnóstico por âncora (fechando o A4 que sobrou)

Como cada âncora tem posição-mundo conhecida, ela pode **conferir o modelo que ela mesma ajuda a
calibrar**: prevista (RSSI invertido pelo modelo) vs. real (geometria). Resíduo alto numa âncora só,
com as demais batendo, é o sintoma local de multipath/obstrução — a aplicação literal do
"data-snooping" da geodésia que você citou. Limiar de 1,5 m (mesma ordem de grandeza do erro que
~4 dB de ruído de RSSI já induz no modelo). Na UI, a âncora "discordante" ganha um indicador visual
próprio (anel laranja pontilhado), distinto de "âncora sem leitura" (vermelho) — três estados, três
cores, sem ambiguidade para o operador.

## 6. Perguntas abertas para sua reavaliação

1. **Sinkhorn/transporte ótimo (`base.md` §3):** dado que o Hungarian *puro* piorou o guloso+guarda,
   faz sentido investir em transporte ótimo **sem** antes ter um modelo de ambiguidade explícito
   (mixture factors, `exploracao.md`)? Ou o seu instinto original — Sinkhorn como parte de um laço
   EM associação↔localização — já pressupunha isso e nós pulamos uma etapa?
2. **GP/kriging completo (`caderno` §5):** com o span de distância das âncoras do campo real sendo tão
   estreito (~0,7–1,6 m), o campo de incerteza calibrado que você propõe teria informação real pra
   aprender, ou o problema é geométrico (retângulo de calibração pequeno demais) antes de ser
   estatístico? Vale orientar o dono a espalhar fisicamente as âncoras antes de investir num GP?
3. **Set-membership (`caderno` §3, anel BLE ∩ setor câmera ∩ navegável):** implementamos só o anel
   (1/3 da interseção). A câmera única faz a interseção "∩ setor" quase redundante (tudo visível já
   está no FOV). A interseção "∩ navegável" (paredes/obstáculos) é o próximo degrau que `pedido_caderno.md`
   chama de "provavelmente o maior salto de precisão por esforço" — concorda que essa é a prioridade
   antes de multi-estação (que depende de hardware que o dono ainda não tem)?
4. **O viés corporal medido no simulador (−6 dB) foi uma escolha arbitrária para provar o ponto.**
   Qual seria uma faixa realista a validar em campo? Já há ~6h de gravação real acumulada (captura
   contínua, não o roteiro anotado do protocolo) — vale extrair viés/deriva dela mesmo sem verdade de
   identidade completa (ex.: comparando as 4 âncoras — que TÊM posição conhecida — contra o modelo),
   antes de pedir ao dono o roteiro deliberado de 6 min com verdade anotada?
5. **A calibração pelas âncoras hoje é "cold start físico" (`dev.md` §6) sem nunca migrar para
   modelo aprendido** — não há ainda o "smoother gerador de pseudo-labels" que fecharia o ciclo de
   aprendizado contínuo que você descreve. Isso depende de dado de campo acumulado; é prematuro
   discutir a arquitetura disso agora, ou vale desenhar o contrato de antemão?

## 7. Onde tudo está (para auditoria)

- Harness e código: `src/fusion/` (associate, sim, replay-fusion, identity-metrics, floor-plot,
  useFloorTags), `src/camera/draw.ts` (plotagem visual).
- Números e decisões, com histórico completo: `docs/cientifica/harness-associacao-indoor.md`.
- Matriz sugerido×feito×pendente cruzando todos os seus documentos: `docs/cientifica/status-implementacao.md`.
- Backlog priorizado e limites honestos: `docs/analises/tags-bluetooth/PENDENCIAS.md`.
- Protocolo de coleta de campo (pronto, aguardando execução): `docs/cientifica/protocolo-teste-campo-indoor.md`.

Tudo medido é reproduzível: `npx vitest run src/fusion/replay-fusion.test.ts --reporter=verbose`
imprime a tabela completa da suíte atual.
