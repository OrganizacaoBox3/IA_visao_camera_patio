# Estado atual do projeto — checkpoint 2026-08-03

> Snapshot pontual, não é fonte viva. Complementa (não substitui) `docs/analises/
> implementacao-changelog.md` (processo, cronológico) e `docs/produto/VISAO-GERAL.md`
> (ainda **desatualizado** — descreve a arquitetura anterior ao ADR-009; reescrevê-lo é
> pendência própria, não feita aqui). Este documento existe para responder uma pergunta:
> **depois de tudo que foi feito entre 2026-07-26 e 2026-08-03, o que está de pé, o que
> falta, e quem decide o quê a seguir.**

## 1. Por que este checkpoint existe

A sessão começou com uma queixa concreta do dono — *"está com delay e falhando em
reconhecer pessoas se movimentando"* — e se expandiu, a pedido dele, em três frentes:

1. Diagnóstico e correção do atraso/perda de marcação de pessoas (Onda 1).
2. Auditoria ponta a ponta do produto — o que ele diz ter × o que entrega, contagem e
   marcador validados, informação oculta do motor exposta (Onda 1 de correções + Onda 2).
3. Duas perguntas de arquitetura levantadas no meio do caminho: vale trocar o motor de
   linguagem (Node×Python), e é viável reconhecer partes do corpo para EPI.

23 commits, 3 auditorias/specs formais, 2 sensores de acurácia novos, 1 ADR. Tudo em
`origin/dev`, `verify` verde a cada passo (não só no final).

## 2. O que está SÓLIDO (com sensor, não por afirmação)

| Área | Evidência |
|---|---|
| Motor de detecção/tracking no hub | `npm run eval:counting` — 12 cenários de travessia + suíte estacionária + torneio de TTL, verde |
| Recall do gate de movimento | `npm run eval:gate-recall` (NOVO) — mede a curva, não o ponto; entra no CI |
| Paridade dos dois trackers (hub × front) | golden vector de 18 casos, cross-language, provado por mutação (21/21 detectadas) |
| Contagem de pessoas por zona/linha | corrigida a inflação por rótulo duplicado (medido: era 100% de inflação); 400 contra config inválida |
| LGPD/efemeridade de imagem | reconfirmado na auditoria — zero `createWriteStream` de imagem em todo o servidor |
| Login/RBAC | reconfirmado — front mais estrito que o servidor por princípio, não por acidente |
| `verify` (lint+typecheck+build+test+audit) | verde em **todos** os 23 commits desta sessão, verificados em worktree isolado por SHA — não só no HEAD |

## 3. O que MUDOU nesta sessão (resumo — detalhe no changelog)

- Contrato do socket `analysis-tracks` para de descartar `coasting`/`zonesProibidas` calado.
- `coasting` deixou de virar keyframe (fim do fantasma congelado + teleporte).
- Refutação por realocação (`ghosted`) virou LOCAL — quem pisca em cena movimentada não some.
- Sensor de recall do gate + golden vector de paridade — as duas lacunas de sensor mais
  graves do projeto, fechadas.
- Zonas homônimas não somam mais contagem uma da outra; config inválida vira 400 em vez de
  degradar em silêncio (zona e câmera).
- Relatório para de afirmar 100%/"fluxo normal" sobre ausência de dado ou falha de rede.
- Alarme crítico interrompe (toast), com teto de rajada provado.
- Modos de zona renomeados para dizer o que fazem ("Ignorar área" × "Área restrita"), com
  todo modo declarando onde roda (hub 24/7 × só com a aba aberta).
- Painel de Saúde do motor: o hub media isso tudo desde o ADR-009 e tinha zero consumidor
  no front.
- Estado do modelo de objetos (OWL-ViT × andaime coco × indisponível) deixou de ser
  invisível — "0 caixas" não é mais indistinguível de "modelo nunca carregou".
- Violação de área restrita passa a existir no mosaico (antes só na câmera aberta).
- ADR-020: a pergunta "Python?" respondida por medição, não por preferência.
- Spec de EPI: aritmética de viabilidade por peça, licenças mapeadas, 3 decisões devolvidas.

## 4. Pendências — DECISÃO DO DONO (nada técnico resolve sozinho)

Estas travam trabalho. Sem escolha aqui, a próxima onda não tem por onde continuar.

| # | Decisão | Por que ninguém além do dono decide |
|---|---|---|
| 1 | **EPI — posicionamento** | 6 documentos prometem "sem identificação individual"; EPI é conduta individual por definição |
| 2 | **EPI — evidência visual** | Sem print o produto vira indicador, não prova; exige ADR contra o ADR-002 (frames efêmeros) |
| 3 | **EPI — orçar ~25-45h de anotação humana** | É o custo só para *descobrir* se a acurácia serve, antes de qualquer código de produto |
| 4 | **Número sobre a imagem** | HUD de linha e `Doca · 📦5` violam a regra escrita ("contagem vive no painel"); o gate só protege a caixa de pessoa. Ou a regra muda, ou eles saem |
| 5 | **`syncDelayMs = 2000`** | Maior parcela do atraso percebido; baixar exige cronômetro filmado em campo |
| 6 | **Tile vermelho em zona restrita silenciada (shelving)** | "Imagem é soberana" (defendido pela frente que implementou) × fadiga de alarme (meu contra-argumento) — nenhum dos dois é óbvio |
| 7 | **Contagem de caixas: ocupação ou fluxo?** | "Quantas estão" existe; "quantas passaram" pode ser fisicamente irresolvível na cadência do OWL-ViT (~700ms-3s) |

## 5. Pendências — PRECISA DE CAMPO/HOMOLOG (não dá pra fazer numa máquina de dev)

| # | Item | Onde medir |
|---|---|---|
| 1 | Pool de workers pode estar superdimensionado (satura em K=2; `resolveWorkerCount` escolhe 5) | homolog x86, não Mac de dev |
| 2 | OpenVINO EP — único experimento que reabriria a pergunta do Python | homolog x86 |
| 3 | Replay MOT com GT, gate ON×OFF (a outra metade do CA-9 do sensor de recall) | dataset está em outra máquina (Windows) |
| 4 | Calibração de `refuteMaxDist: 0.6` (valor escolhido, não medido) | campo |
| 5 | Calibração de `syncDelayMs` (item 5 da seção 4, tecnicamente) | campo, cronômetro filmado |

## 6. Pendências — TÉCNICAS, escopo pequeno

- Tile WebRTC sem nome de câmera em lugar nenhum, `<button>` sem nome acessível.
- Auto-máscara agora VISÍVEL (painel de saúde avisa) mas ainda NÃO-ACIONÁVEL (não dá pra
  desfazer/ajustar pela UI).
- Toast de alarme crítico não é clicável (não navega para a câmera).
- Exportação de CSV **sem gate de papel nem log** — sai com nomes de pessoas
  (`ackBy`/`posto`) para qualquer usuário autenticado.
- `armed:boolean` não chegou ao payload — canvas ainda pode dizer ARMADA quando a política
  de turno está calando o alarme (achado da auditoria original, não fechado nesta onda).
- `flow_buckets` sem carimbo de turno — Atividade e Fluxo usam relógios diferentes na mesma
  tela do relatório.
- `people_sum`/`people_samples` não existem — média de pessoas por zona é impossível no
  schema hoje (só o pico).
- Contagem dupla em modo local (sem motor) por falta de dedup entre dashboards abertos.
- Zero teste em `whatsapp.js`/`dispatch.js`/`alerts.js` — o caminho que manda mensagem para
  número de cliente segue sem rede de segurança.
- `git config core.hooksPath` **está vazio neste clone** — o gate pre-push local do CLAUDE.md
  §6 está desligado (o CI cobre, mas a doutrina promete as duas camadas). Comando pronto:
  `git config core.hooksPath .githooks`.
- Repo não uniformemente formatado por Prettier (débito pré-existente, não é gate do
  `verify`).

## 7. EM ABERTO — teste ao vivo do piso de score (modo Objetos)

Estado do working tree neste checkpoint: `src/config.ts` tem `objectScoreThreshold` em
**0.1** (não commitado — o dono ajustou manualmente durante o teste, de um valor
intermediário de 0.15 que eu havia colocado). **Resultado ainda não confirmado.**

Hipótese em teste: o piso de 0.5 (calibrado para coco-ssd) descartava detecções válidas do
OWL-ViT antes de desenhar E de contar — a mesma lista alimenta os dois, então "não marcou
nem contou" era o sintoma esperado da MESMA causa, não dois bugs.

**Próximo passo depende do resultado que o dono ainda vai reportar:**
- Se a contagem passou a funcionar → medir a curva completa (precisão×recall vs. piso) com
  frames reais antes de fixar um valor definitivo — nunca o ponto isolado (doutrina do
  projeto). Decidir também se o perfil `longRange` (hoje 0.3, intocado) precisa do mesmo ajuste.
- Se não funcionou → o problema não é o piso; investigar carregamento do modelo,
  seleção de classe, ou se a cena real do OWL-ViT simplesmente não reconhece papelão nesse
  ângulo/distância.

## 8. Mapa de documentos desta sessão

| Documento | Conteúdo |
|---|---|
| `docs/analises/implementacao-changelog.md` | Entradas `2026-07-26 (7)` a `2026-08-03` — o processo, cronológico, com números verificados |
| `docs/analises/spec-marcacao-tempo-real-v2.md` | Diagnóstico completo do atraso/perda de marcação (M1-M7, D1-D4), ondas, trade-offs |
| `docs/analises/auditoria-produto-2026-07-26.md` | As 5 frentes de auditoria: zonas/alarme, contagem/marcação, informação oculta, front, docs×código |
| `docs/analises/decisoes/ADR-020-runtime-de-inferencia.md` | Node×Python, com critério explícito de reabertura |
| `docs/analises/runtime-motor-medicao-2026-07-27.md` | A medição por trás do ADR-020 (A/B bit-a-bit, EPs, custo da reescrita) |
| `docs/analises/spec-epi-partes-do-corpo.md` | Viabilidade de EPI por parte do corpo — aritmética, licenças, 3 decisões devolvidas |
| `docs/analises/estado-atual-2026-08-03.md` | Este documento |

## 9. Residual declarado

Este checkpoint é ele mesmo uma snapshot — vai ficar desatualizado no primeiro commit
seguinte. Nada aqui substitui rodar `git log`, `npm run verify` e os dois `eval:*` para
saber o estado real no momento em que alguém ler isto. A reescrita completa de
`docs/produto/VISAO-GERAL.md` (identificada na auditoria como o documento mais enganoso do
repo — descreve arquitetura pré-ADR-009) continua **fora do escopo** deste checkpoint e é
tarefa própria, maior, ainda não iniciada.
