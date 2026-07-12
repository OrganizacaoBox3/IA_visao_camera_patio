# Protocolo — teste de campo INDOOR da associação tag↔pessoa

> 🔴 **ATENÇÃO — ESTE PROTOCOLO ESTÁ DESATUALIZADO EM DOIS PONTOS CRÍTICOS (2026-07-12).**
> **Se você for a campo com o setup abaixo, GRAVA O DADO ERRADO e perde a ida.** Leia primeiro:
>
> **1. A CÂMERA NÃO VAI PARA A MESA — VAI PARA O CORREDOR DE APROXIMAÇÃO.**
> Medimos (Regra 8, contagem pura) que a identidade por rádio exige **T ≥ 18 s de aproximação
> observada** com a tag atual (2,5 s de advertising) — ou seja, **~20 m de corredor** a 1,2 m/s.
> Uma área de 4×3 m dá T ≈ 3-4 s → **3-5 leituras distintas → o teste de Fisher é INDEFINIDO**
> (não "difícil": indefinido — o denominador é √(n_eff−3)). **Um retângulo de 4×3 m NÃO PODE
> produzir identidade, com algoritmo nenhum.** A "aproximação de 3-8 s" é artefato do FOV, não física.
>
> **2. A ESTAÇÃO NÃO VAI JUNTO DA CÂMERA — VAI NO FIM DO CORREDOR (o DESTINO), sobre o eixo da
> caminhada.** O "+27 pts junto da câmera" da tabela abaixo é medição ANTIGA e superada: o receptor
> no destino entrega **100% de precisão contra 55,6% (≈ cara-ou-coroa) do baseline**. Receptor AO LADO
> do caminho = aproximação tangencial = gradiente radial ≈ 0 = **a identidade nunca fecha, e o modo
> de falha é SILENCIOSO** (a equipe investiga o algoritmo enquanto o bug está no suporte da parede).
>
> **O desenho novo é o PORTAL DE IDENTIFICAÇÃO**: câmera cobrindo o corredor de entrada + receptor no
> fim dele. O operador é identificado com alta confiança 2-4× por turno (entrada, volta de intervalo);
> as outras camadas carregam a identidade pelo resto do turno. **Grave a caminhada NO CORREDOR DE
> ENTRADA, não perto da mesa.**
>
> *(Motivo da mudança: o dono informou que os postos são mesas VIZINHAS e o operador CIRCULA LIVRE —
> logo o movimento cotidiano é mesa→mesa (3-5 m, 2-4 s), curto demais para o rádio por CONTAGEM. Ver
> `docs/analises/tags-bluetooth/PENDENCIAS.md` e as Regras 8/9 do `CLAUDE.md`.)*
>
> **Esta ida paga CINCO contas de uma vez** (verdade anotada · viés corporal real · teste direcional ·
> τ do resíduo móvel · ACF sub-segundo, se houver tag rápida). Vale planejar com calma.

> Objetivo: medir o associador de produção (`src/fusion/associate.ts`) com **dados reais** — pessoas
> caminhando indoor com tags no bolso — replayados pelo **mesmo harness** do sintético
> ([harness-associacao-indoor.md](harness-associacao-indoor.md)). Ferramenta: gravador `FUSION_RECORD`
> (`server/bt/session-recorder.js`) + loader (`src/fusion/session-loader.ts`).
> Data do protocolo: 2026-07-10 (⚠️ ver o bloco de correção acima, 2026-07-12).

## Hardware

| Item | Papel | Nota |
|---|---|---|
| 1 PC na LAN | hub com análise D-FINE | `$env:FUSION_RECORD = "1"; npm run hub` |
| 1 câmera **FIXA** | apontada p/ chão plano ~4×3 m livre | pés das pessoas visíveis; tripé/prateleira |
| 1 TC22 | estação BLE **FIXA** (é a antena — **não anda**) | de preferência **junto da câmera** (+27 pts medidos) |
| 2–3 tags BLE | uma no bolso de cada pessoa | nomeadas no hub/app |
| Trena + fita crepe | retângulo de calibração | dimensão MEDIDA, não estimada |

## Setup (uma vez, ~15 min)

1. Hub com `FUSION_RECORD=1` (sem a flag, **nada** é gravado — opt-in/LGPD; só metadados: caixas/MAC/RSSI, jamais frames).
2. Câmera fixa; conferir **caixas de pessoa** no dashboard.
3. **Calibrar ANTES de gravar**: retângulo medido no chão → 4 cantos em ordem + dimensões no painel; a grade projetada deve "assentar" no chão.
4. **Marcar o ponto da ESTAÇÃO** na calibração (onde o TC22 está). Não mover o TC22 depois.
5. Anotar no papel a **tabela de verdade**: `pessoa → MAC da tag` (ex.: João → AA:AA).

## Coleta (~6 min, roteirizada)

**Regra de ouro:** entrar em cena **UM de cada vez**, ~5 s de intervalo, **anotando a ordem de
entrada** — é assim que se mapeia trackId→pessoa na anotação.

| Fase | ~1 min | O que mede |
|---|---|---|
| 1 | Solo A (só a pessoa A anda) | sanidade |
| 2 | Solo B | sanidade |
| 3 | Dupla livre (independentes) | caso normal |
| 4 | Cruzamentos (linhas opostas, repetidos) | troca-de-ID do tracker |
| 5 | **Bloco** (lado a lado ~1 m) | o caso ambíguo → esperamos **abstenção**, não erro |
| 6 | **Parado** (imóveis 30–45 s) | guarda `minMovement` → esperamos zero fala |

Evitar gente extra na cena. Roupas iguais não atrapalham (tracker usa posição, não aparência).

## Entrega p/ análise

1. `server/bt/fusion-session.jsonl` (a gravação).
2. Tabela de verdade (pessoa→MAC) + ordem de entrada por fase.

A análise: anotar trackId→MAC (`SessionTruth`), rodar `replayFusionSession(lines, truth)` → métricas
de identidade reais, comparadas lado a lado com a tabela sintética do harness.

## Limites honestos declarados

- O RSSI real (multipath, corpo humano absorvendo 2,4 GHz) é **pior** que o sintético (σ4 dB gaussiano)
  — esperamos precisão/cobertura menores; o valor do teste é MEDIR o quanto.
- 1 estação: pessoas em bloco continuam fisicamente indistinguíveis — a vitória ali é **abster**.
- Tracks re-nascem com id novo após oclusão longa; a anotação deve cobrir os ids novos (o resumo de
  tracks da gravação ajuda a mapear).
