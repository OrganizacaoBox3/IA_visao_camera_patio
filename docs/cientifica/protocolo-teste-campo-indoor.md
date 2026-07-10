# Protocolo — teste de campo INDOOR da associação tag↔pessoa

> Objetivo: medir o associador de produção (`src/fusion/associate.ts`) com **dados reais** — pessoas
> caminhando indoor com tags no bolso — replayados pelo **mesmo harness** do sintético
> ([harness-associacao-indoor.md](harness-associacao-indoor.md)). Ferramenta: gravador `FUSION_RECORD`
> (`server/bt/session-recorder.js`) + loader (`src/fusion/session-loader.ts`).
> Data do protocolo: 2026-07-10.

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
