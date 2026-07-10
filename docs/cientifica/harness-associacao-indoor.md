# Harness de associação INDOOR (câmera = ONDE, BLE = QUEM) — o de-risco do motor científico

> Trilha de pesquisa do [ADR-012](../analises/decisoes/ADR-012-abordagem-cientifica-viabilidade.md),
> **reapontada** (2026-07-10) após correção de rumo do dono: o problema real é **pessoas caminhando
> indoor com tags no bolso** — sem GPS. O harness das Fases 0–3 ([fase0-harness-replay.md](fase0-harness-replay.md))
> mediu o modelo AirTag/GPS *outdoor* (trilha de produto, não de pesquisa). ESTE harness mede o modelo
> científico de verdade: a câmera dá a posição (homografia) e o BLE dá a identidade (associação).

## O quê (spec)

Dar **sensor de medição** ao coração da abordagem científica — a **associação tag↔pessoa** — que já
existe em produção (`src/fusion/associate.ts`, correlação RSSI×distância com guardas honestas de
"não sei") mas **nunca foi medida**: knobs hardcoded, só unit test, zero cenários de campo.

1. **Simulador indoor** (`src/fusion/sim.ts`): N pessoas caminhando num chão (verdade conhecida),
   câmera virtual com a **homografia REAL** (`computeHomography`/`worldToPixel` de produção), tracker
   com ruído/dropout/troca-de-ID, estação BLE com RSSI log-distância + ruído. Determinístico (seed).
2. **Métricas de IDENTIDADE** (`src/fusion/identity-metrics.ts`): certo/errado/absteve, precisão,
   cobertura, falsos rótulos (rotular pessoa sem tag), trocas de rótulo. A invariante do dono vira
   métrica: **rótulo errado é pior que nenhum** — a precisão quando FALA é o número mestre.
3. **Harness de replay** (`src/fusion/replay-fusion.ts`): roda o **`TagTrackAssociator` DE PRODUÇÃO**
   (não uma cópia) alimentado **exatamente como o `useTagFusion`** (tick 500 ms, pula tick sem
   readings, `buildFusionFrame` real) sobre uma suíte de cenários nomeados.
4. **Gate Vitest** que pina as métricas do associador atual — a partir daí, qualquer upgrade
   (transporte ótimo, set-membership, multi-estação) é **melhoria medida**, não alegada.

### Critérios de aceite (Given/When/Then)

- **G** um cenário sintético indoor com verdade · **W** `replayFusion(cenário)` · **T** métricas de
  identidade determinísticas (mesmo seed → idênticas).
- **G** o cenário `parado` (pessoas imóveis) · **W** replay · **T** o guarda `minMovement` funciona:
  **zero rótulos errados** (abstém — a honestidade de produção comprovada por medição).
- **G** o cenário `bloco` (2 pessoas lado a lado, o caso fisicamente ambíguo) · **W** replay · **T** o
  harness REVELA a taxa real de erro (não força vitória — se errar, é sinal a preservar).
- **G** a suíte inteira · **W** `npm run verify` · **T** gate verde com pinos medidos.

### Fora de escopo (explícito)

Melhorar o associador (transporte ótimo/Hungarian, set-membership, multi-estação) — o harness vem
ANTES do upgrade. Dados reais de campo (fase seguinte: gravar `bt-readings`+`analysis-tracks` reais).
Métricas MOT completas (MOTA/IDF1 formal) — começamos com as de associação por janela. Homografia de
altura, distorção de lente.

## Como (plan — requisito→arquivo, propriedade exclusiva)

| Arquivo (novo, em `src/fusion/`) | Frente | Responsabilidade |
|---|---|---|
| `sim.ts` + `sim.test.ts` | A | cenário sintético: pessoas, câmera (H real), BLE, verdade |
| `identity-metrics.ts` + `.test.ts` | B | métricas de identidade + tabela |
| `replay-fusion.ts` + `.test.ts` | C (após A+B) | replay fiel à produção + suíte + gate |

Frentes A e B em paralelo (contratos fixados abaixo); C integra; revisão adversarial em paralelo ao
final (fidelidade de produção, determinismo, física/honestidade das métricas).

## Resultado (2026-07-10) — ✅ o associador de produção MEDIDO pela primeira vez

Construído por workflow multi-agente (build paralelo → integração → **revisão adversarial tripla** →
fixes re-medidos). Fidelidade e determinismo auditados sem achados; a lente de física rendeu 4 correções
aplicadas (ruído na caixa, premissa da estação, cenário vivo da grade, pinos em todos os cenários).
Gate no `verify` (698 testes). Warmup de 8 s excluído; 120 s por cenário; pinos justos por determinismo.

### Tabela medida (associador atual: correlação RSSI×distância, guloso, knobs default)

| cenário | precisão % | cobertura % | errado | falso-rótulo | id-switch |
|---|---|---|---|---|---|
| canonico (3p/2tags) | **81,4** | 41,9 | 41 | 33 | 1 |
| parado | **100** (0 fala) | 0 | **0** | 0 | 0 |
| **bloco** (lado a lado) | **60,8** | 33,5 | 93 | 15 | 20 |
| cruzamento (+id-switch do tracker) | 78,4 | 28,3 | 33 | 0 | 1 |
| ruído-alto (σ8 dB) | 68,9 | 21,6 | 42 | 28 | 0 |
| **multidão** (6p/4tags) | **49,8** | 30,6 | 260 | 88 | 31 |
| sem-calibração (proxy caixa, estação junto à câmera) | 71,8 | 30,2 | 51 | 28 | 4 |
| **grade-sem-station** (o CameraTile VIVO de hoje) | **49,2** | 20,7 | 92 | 43 | 2 |

### Os quatro achados (medidos, não alegados)

1. **A honestidade funciona onde foi desenhada:** `parado` = 0 rótulos errados em 428 oportunidades —
   o guarda `minMovement` abstém perfeitamente, mesmo com ruído de pixel.
2. **A invariante é VIOLADA no caso ambíguo:** no `bloco` (2 pessoas ombro a ombro, 0,8 m) o associador
   **fala em vez de abster** — precisão 60,8%, 20 trocas de rótulo. `minMovement` não protege (movimento
   há de sobra; o que falta é **guarda de ambiguidade** — margem entre 1º e 2º melhor score). Na
   `multidão`, pior: 49,8%. **Este é o alvo nº1 de melhoria, agora com número.**
3. **Bug de configuração em produção, quantificado:** o `CameraTile` (grade do dashboard) chama a fusão
   **sem `stationPx`** (cai no default 0.5,1.0) enquanto o fullscreen passa o calibrado. Custo medido:
   precisão 81,4%→**49,2%** (−32 pts), erros 2,2×. Fix barato e de alto impacto: propagar o station da
   calibração ao tile.
4. **A premissa "estação junto da câmera" vale +27 pts** no modo sem calibração (71,8% vs 44,5% com
   estação no canto) — orientação de instalação a documentar para o usuário.

### Próximos (agora mensuráveis pelo harness)

1. **Guarda de ambiguidade top-2** no associador (abster quando 1º≈2º) → deve elevar a precisão do
   `bloco`/`multidão` às custas de cobertura — o trade-off certo pela invariante do dono.
2. **Fix do `CameraTile`** (passar `stationPx` calibrado) — ganho medido de +32 pts esperando.
3. **Associação ótima global** (Hungarian/transporte ótimo — dev.md §3) vs. guloso: medir na `multidão`.
4. **Set-membership** (anel BLE ∩ cone câmera ∩ navegável) e **multi-estação** — gated por hardware.
5. **Dados reais**: gravar `analysis-tracks`+`bt-readings` reais e replayar pelo mesmo harness.
