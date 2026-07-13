# Laudo — "estou em cena com a tag e o sistema não associa"

> Data: 2026-07-13 · Origem: queixa do dono · Método: 3 auditorias read-only + medição sobre a
> **gravação real de campo** (`server/bt/fusion-session-*.jsonl`, 40 segmentos, 39 h).
> Toda proporção sai com **n e intervalo de Wilson 95%** (Regra: 13/13 não é 100%).

## 1. O veredito, numa linha

**O sistema está calando CORRETAMENTE — porque você está PARADO.** O associador correlaciona
RSSI × distância; pessoa parada tem distância constante; correlação de série constante é
**matematicamente indefinida**. Não há o que consertar no cálculo. **O método é estruturalmente cego
para o caso de uso principal do produto** (mesa de trabalho, operador que chega e fica).

## 2. A medição (corpus ouro: câmera com pessoa + tag audível, n = 129 episódios)

| gate que produz o silêncio | fatia | IC 95% (Wilson) |
|---|---|---|
| **C — `minMovement`: pessoa PARADA** (rádio OK) | **41,9%** | 33,7–50,5% |
| A — `constantSeries`: RSSI não muda (n_dist ≤ 1) | 31,0% | 23,7–39,4% |
| B — n_eff ≤ 3: Fisher-z indefinido | 21,7% | 15,5–29,6% |
| **D — evidência suficiente: o sistema PODE falar** | **5,4%** | **2,7–10,8%** |

> **A + B + C = 94,6% (IC 89,2–97,3%) do silêncio é PREVISTO pela física/geometria.**

**O número que fecha o caso:** a variância da distância tem **mediana 0,003** contra o limiar
`minMovement = 0,15` — **50× abaixo**. Em 2 das 3 horas auditadas o **máximo** de variância da hora
inteira **nunca alcançou o gate**. Não é limiar mal calibrado; é a sala não entregar movimento.

### A dependência de T (a espec de instalação aparece sozinha no dado)

| duração do episódio | n_distinct > 3 |
|---|---|
| T < 4 s | **0/27 = 0,0%** (IC 0–12,5%) |
| 4 ≤ T < 8 s | **0/25 = 0,0%** (IC 0–13,3%) |
| 8 ≤ T < 18 s | 13/25 = 52,0% (33,5–70,0%) |
| **T ≥ 18 s** | **48/52 = 92,3%** (81,8–97,0%) |

**Nenhum episódio abaixo de 8 s jamais atinge o piso de evidência** (0/52; IC 0–6,9%).

### O teto do rádio (Regra 8, confirmada por contagem no dado real)

Δt entre leituras **DISTINTAS** da tag: **2,2 s** (mediana, n = 30.267 intervalos).
Quadruplicar a taxa de POST do celular (2063 ms → 546 ms) **NÃO moveu esse número** (2101 → 2303 ms).
O gargalo é o **advertising da TAG**, não a estação. Teto: **≤ 3,6 leituras distintas** na janela de
8 s do associador.

## 3. A REFUTAÇÃO da alavanca que a doutrina rankeava em 1º

O ADR-014 e o `PENDENCIAS.md` cravam: *"a alavanca real é a cadência de advertising da tag"*.
**Medido agora, isso é falso para a queixa do dono.**

- A cadência destrava **só o bloco B (21,7%)** — e **só se a pessoa se mexer**.
- O bloco C (41,9%) é τ→∞ (alvo parado): a lei `n_eff ≤ min(T/Δt, T/2τ)` **satura no segundo termo**.
  Tag a 2 Hz **não move esse ponteiro um milímetro**.
- **Mesmo com uma tag infinitamente rápida, um associador por correlação ficaria mudo em ≥ 89%**
  deste corpus, porque só 5,4% dos episódios têm movimento suficiente.

**A alavanca dominante não é a tag. É que a pessoa não anda.** (E o dono já havia dito: *"são mesas
de trabalho"*, *"ele só chega e trabalha"* — o caso dominante É o ponto cego.)

## 4. O PIVÔ DE MÉTODO (a consequência real)

Para **pessoa parada**, correlação é o instrumento errado. O que funciona **sem movimento**:

1. **Distância ABSOLUTA (path-loss calibrado pelas âncoras).** RSSI −55 dBm + modelo calibrado ⇒ "a
   tag está a ~2 m da estação". A câmera diz "esta pessoa está a 2,1 m da estação". Isso é evidência
   **sem exigir movimento nenhum**. **O código já tem `distM`** — e está **DESLIGADO** em produção
   (`distWeight: 0`, `useLogDistance` ausente do `DEFAULTS`).
2. **2ª antena (multilateração).** Com 2 estações, uma tag parada tem um par (d₁, d₂) **fixo** que a
   localiza. Também **não exige movimento**. É exatamente para isto que a 2ª estação serve — e a
   razão pela qual ela vale mais do que a doutrina anterior supunha.
3. **ReID visual** (ADR-015) — ortogonal, mais caro, fica para depois.

**Correlação continua valendo para quem ANDA** (o corredor, a empilhadeira). Não se joga fora: ela
vira **uma** evidência, não a única. A soma honesta é o objetivo — respeitando a Regra 13 (erro
correlacionado: dado independente ≠ erro independente).

## 5. Os BUGS encontrados (reais, mas nenhum deles explica a queixa)

Registrados porque são verdadeiros e caros — não porque resolvem o silêncio.

| # | bug | evidência |
|---|---|---|
| **B1** | **Sample-and-hold no celular.** `buildJson()` serializa o mapa inteiro e **nunca o limpa**; a tag só sai após `DROP_MS = 20 s`. **81,2% do que o hub recebe é CÓPIA** do valor anterior. Pior: tag que **saiu de cena** segue sendo postada por até 20 s (app) + 15 s (pool) = **fantasma de ~35 s** oferecido como candidata presente. | `tc22-scanner/…/MainActivity.java:437-448, 1052-1060` |
| **B2** | **O hold é ATIVO contra o par verdadeiro.** ~80% dos pontos da correlação afirmam *"RSSI parado enquanto a distância muda"* — pontos que empurram \|r\| **para baixo** justamente na pessoa real em movimento, contra `minConfidence = 0,5`. Parte do silêncio é **fabricada pelo hold**. | `associate.ts:713` |
| **B3** | **`minSamples = 5` conta CÓPIAS, não medições.** O motor acredita ter 16 amostras quando tem ~3,6. O antídoto (`distinctConsecutive`) **existe, está testado** — e vive atrás do `significanceGate`, que está **OFF por default**. O gate de evidência mede a taxa de POST, não a taxa de informação. | `associate.ts:701, 390-395, 290-312` |
| **B4** | **Comentário FALSO no código:** justifica 2000→500 ms com *"≈ 4× leituras distintas"*. **Medido: 1,4×.** O ganho está saturado; o resto é banda/CPU/disco puros. | `MainActivity.java:97-104` |
| **B5** | **Colisão âncora × tag de pessoa.** As tags-âncora são excluídas da fusão (correto). Mas há ~5 tags no total e **4 estão presas como âncora em cada câmera**. Na `cam-8a95ac6090` sobra **1 candidata** (`…CE:8B`); e na `cam-5c08215dce` essa mesma `…CE:8B` **é âncora** ⇒ ali ela **nunca associa, em silêncio, para sempre**. | `camcfg.json` × `frame.ts:122` |
| **B6** | **Estação cega não gera alarme.** 22 h consecutivas postando `readings: []` — o painel de saúde a via **VIVA** (ela estava postando). | `fusion-session-2026-07-10_20 → 07-11_17` |
| **B7** | **PORTA ZERO: com `analysisEngine = "local"`, a fusão nunca roda.** `useTagFusion` exige tracks do **hub**; sem eles, `labelFor` fica vazio para sempre. Nas gravações `_00`–`_08`: **`trk = 0` em 9 h seguidas**, com `ble ≈ 6.500/h`. | `useTagFusion.ts:62` |
| **B8** | **O sistema não diz POR QUE calou.** `diagnoseFunnel()` existe, é excelente — e tem **ZERO consumidor de UI**. Nem o Replay mostra veredito. O operador vê "Pessoa" e não tem como saber se falta rádio, falta movimento ou a tag é âncora. | `associate.ts:1039` |

## 6. O PLANO

### Onda 1 — PARAR DE DESTRUIR EVIDÊNCIA (barato, não cria informação; para de perdê-la)
- **P1.** O app manda **só o que MUDOU** desde o último POST (ou carimba `ts` de borda por leitura).
  Mata B1/B2/B4 na origem: acaba o fantasma de 35 s e a série segurada.
- **P2.** O gate conta **medições distintas** (`distinctConsecutive`), não cópias. Liga o
  `significanceGate`. Mata B3 — o motor passa a **medir honestamente o quanto não sabe**.
- **P3.** **Alarme de estação cega** ("postando, mas 0 leituras há N min"). Mata B6.
- **P4.** **A tela do porquê** (mata B8, e é o que responde a queixa do dono no dia a dia): o funil
  já calculado vira UI — por pessoa em cena: *rádio ✓/✗ · movimento ✓/✗ · evidência n=X · veredito*.
  **O produto não é só acertar; é dizer por que não sabe.**

### Onda 2 — VER A PESSOA PARADA (o pivô — é aqui que mora o conserto da queixa)
- **P5.** **Ligar a distância absoluta** (`distM`/path-loss calibrado pelas âncoras) como evidência
  independente do movimento. O código existe e está desligado. **Torneio com régua a priori** contra
  o corpus ouro: precisão(dist) e precisão(corr+dist) ≥ precisão(corr), cobertura ≥ 1,5×.
  **Reportar a precisão do DELTA isolada** (Regra 11 — o agregado mente).
- **P6.** **2ª antena de verdade** (o S24): multilateração de tag parada. Hoje o multi-antena está
  **morto no caminho vivo** — `useCameraTagLabels` **não passa `stationsPx`**, então `distByStation`
  nunca é emitido, e com 2 estações no pool o `align()` **descarta em silêncio** o RSSI da segunda.
  Ligar isso é pré-requisito, e a `agreementOnFailure` entre estações roda **antes** de somar (Regra 13).

### Onda 3 — GEOMETRIA (grátis, e a doutrina já apontava)
- **P7.** Estender **T** = geometria de câmera (task #36). O dado mostra o degrau: **T < 8 s ⇒ 0%**
  de evidência; **T ≥ 18 s ⇒ 92%**. Reposicionar/reangular a câmera para alongar a permanência no FOV
  é a alavanca mais barata que existe — e ela **não depende de comprar nada**.
- **P8.** **Separar as tags-âncora das tags de pessoa** (mata B5). Âncora é infraestrutura fixa;
  não pode ser a mesma tag que vai no crachá. Comprar/dedicar 4 tags só para âncora, e **avisar na UI**
  quando alguém tentar usar uma âncora como tag de pessoa.

### Ordem
P4 e P3 primeiro (visibilidade — sem elas, todo o resto é adivinhação). P1/P2 em seguida (param a
sangria). P5/P6 são o coração. P7/P8 são ação do dono.

## 7. O que este laudo NÃO pode afirmar (Regra 9)

- **As DECISÕES do associador não são gravadas** (o `assign()` roda no navegador). Medi a
  **OPORTUNIDADE** (D = 5,4%), **não a saída realizada**. Não posso afirmar "o sistema calou tendo
  evidência" — só que em 94,6% dos episódios **ele não deveria falar**.
- **Não há verdade-terreno** (qual MAC em qual pessoa). Usei "melhor tag" = máximo sobre os MACs ⇒
  **limite superior, favorável ao sistema**. O número real de D é ≤ 5,4%.
- Para fechar o caso: gravar `AssignmentTick` + motivo do veto por tick (**o tipo já existe**), e
  fazer a **caminhada anotada** (task #4) — o único dado não-circular que valida H1.
