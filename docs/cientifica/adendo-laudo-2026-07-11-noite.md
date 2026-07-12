# Adendo ao laudo — as duas medições que o 2º parecer pediu (2026-07-11, noite)

> Para o especialista. Você fechou o parecer com: "Duas coisas hoje, sem campo e sem hardware:
> re-scoring por evento (§2) e re-mineração da sobrevivência de tracks estáticos (§3). As duas
> juntas dizem se a arquitetura fecha." Fizemos as duas. Elas fecham — e convergem no mesmo lugar.

## §3 — sobrevivência de tracks estáticos: **morre em segundos**

Re-mineração READ-ONLY da gravação passiva (988 tracks), por regime de movimento, vida em segundos:

| Regime | mediana | p90 | max | passou de 1min? |
|---|---|---|---|---|
| **Estático** (maxDisp<0,02 — o balde que a fragmentação filtrou) | **3,0s** | 16,1s | 59,2s | **nenhum (0)** |
| Meio (0,02-0,06) | 10,9s | 50,1s | 483s | 24 |
| Móvel (≥0,06) | 9,6s | 56s | 270s | 15 |

Você disse: "se vive 8min a arquitetura fecha; se morre a cada 40s, o receptor de zona vira
REQUISITO." **Morre em 3s (mediana), nunca chega a 1min.** O receptor de zona é requisito.

**Ressalva honesta (não escondida)**: a gravação passiva tinha pouca gente parada REAL — a maioria
dos 484 estáticos é mobília/flicker do tracker, não pessoa trabalhando. O número da PESSOA parada
especificamente ainda precisa do hello world (o operador sentar 8min e medir a vida do track
DELE). Mas a direção é inequívoca: com a config atual do ByteTrack, sustentar ID sobre alvo de
baixo movimento é frágil. **Alavanca barata antes do hardware**: aumentar track_buffer/
max_time_lost do tracker — testável sem estação. Se mesmo assim morrer, a estação-de-zona fecha o
buraco.

## §2 — precisão de EVENTO vs precisão de TICK: a tese se confirma, refinada

Sua tese ("o cliente compra evento, não tick; a agregação por episódio via Fisher-z supera o tick")
**está certa — e a medição a refinou em dois eixos que estavam colados na régua antiga.**

**Primeiro, uma correção de rota que a medição forçou**: a prescrição LITERAL (argmax do z_comb
cru, "falar sempre") REFUTA a própria tese — compara tick-COM-guarda contra evento-SEM-guarda, e
canonico despenca de 82% para 62%, violando a invariante do dono. A agregação só vale quando
(a) agrega as falas JÁ GUARDADAS do motor e (b) exige sustentação (≥3 falas) + dominância
(margem top-2). Com isso:

| eixo | a agregação por evento resolve? | número |
|---|---|---|
| **IDENTIDADE** (tag certa, dada pessoa com tag) | **sim** | tick 74,5% → **evento 79,6%** agregado; 9/10 cenários; bloco 80→**100%**, multidão 61→**75%**, ruído 69→**87,5%** |
| **rejeitar quem NÃO tem tag** (falso-positivo) | **não** | falso-rótulo sustentado → falso-EVENTO; a persistência ajuda o erro tanto quanto o acerto |

- **A "cobertura de 30%" vira ~55% no nível de evento** (canonico 37→55%) — sobe ~1,5-2×, real,
  mas NÃO os ~100% idealizados: os episódios do simulador são curtos (dropout/id-switch/warmup); a
  aproximação contínua de 15s que renderia ~100% o sim fragmenta.
- **Exceção honesta pinada no teste**: `cruzamento` 78→66,7% — o id-switch troca a verdade física
  no meio do episódio; a agregação não conserta uma pista cuja verdade trocou.
- **A persistência v1 fica PARCIALMENTE absolvida**: no eixo identidade, a régua de evento muda o
  veredito — ela otimizava cobertura-por-tick, que o cliente não compra. Mas ela NÃO conserta o
  falso-positivo, que continua sendo o risco (o escudo jurídico do seu §8).

## A convergência — as duas medições apontam a MESMA peça

- Gravação REAL de campo (1 estação, sem verdade anotada): o Fisher-z de evento **NÃO** aponta tag
  dominante estável (concordância tick-a-tick 37,5%). O "silêncio de 1 estação" de novo.
- §3: o track visual parado morre em segundos — não sustenta identidade na permanência.

**As duas dizem: a arquitetura fecha, mas 1 estação + câmera não basta para o regime de
permanência.** O receptor de zona na mesa (sua §4 — a 2ª antena RE-JUSTIFICADA como receptor
semântico, não geometria de trilateração) é a peça que (i) resolve a permanência por proximidade,
(ii) reidentifica após a morte do track visual, (iii) dá ao evento a assinatura estável que a
agregação Fisher-z precisa e não tem com 1 estação. Deixou de ser aposta; virou requisito medido.

## Perguntas de volta

1. O eixo do falso-positivo (rejeitar quem não tem tag) não melhora com agregação de evento — e é
   o eixo jurídico. A defesa é só a câmera (assignment limitado por zona: "há N pessoas nesta zona,
   M têm tag cadastrada") + workflow como prior, ou você vê um mecanismo de rejeição no próprio
   nível de evento?
2. Para o receptor de zona: proximidade por quantil alto do RSSI (você sugeriu, contra o viés
   corporal) — qual quantil, e a janela de decisão é o episódio inteiro de permanência ou uma
   janela deslizante?
3. A alavanca barata do track_buffer do ByteTrack — vale exaurir antes de cravar a estação como
   requisito, ou a fragilidade de tracker parado é estrutural o bastante para pular direto pro
   receptor de zona?

---
Reprodução: `event-metrics.ts` (métrica de evento, 12 cenários pinados) · re-mineração de §3 por
script de leitura pura sobre `server/bt/fusion-session.jsonl`. Registro vivo em
`docs/analises/tags-bluetooth/PENDENCIAS.md` (topo — "VIRADA CONCEITUAL").
