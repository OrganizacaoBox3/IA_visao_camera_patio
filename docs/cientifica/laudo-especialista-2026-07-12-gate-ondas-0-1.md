# Laudo — Gate das Ondas 0 e 1 medido na bancada (2026-07-12)

> **Para o especialista.** Fecho do arco do gate que o seu parecer final desenhou (ADR-014). Tudo
> medido sem hardware novo, no simulador calibrado + na gravação de campo. Regra da casa: sem
> evidência não há "pronto"; achado negativo tem o mesmo status que positivo; separo medição de
> inferência; declaro a circularidade onde ela existe. Números reproduzíveis por seed/comando.

## 0. Estado em uma frase

**As duas hipóteses do gate (H1 identidade-por-visita, H2 conservação-por-fronteira) NÃO foram
refutadas, mas a Onda 1 mudou o diagnóstico: o gargalo da identidade por rádio NÃO é o span radial
(que o receptor-no-destino resolve, 3-4×) — é o `n_eff` (independência temporal), governado pela
CADÊNCIA DE ADVERTISING da tag, e limitado estruturalmente pela DURAÇÃO do episódio. Isso não
derruba a arquitetura de 5 camadas — ela a valida quantitativamente: a identidade RSSI só contribui
na aproximação LONGA observada, e a conservação topológica (camada 3) carrega o resto.**

## 1. Onda 0 — o gate sem hardware

### H1 — identidade por visita (janela única honesta)
Reescrevi a métrica na unidade da sua prescrição: UMA correlação de Pearson sobre a janela do
episódio inteiro, `n_eff = nDistinct·(1−ρ)/(1+ρ)` com ρ=0,7 (o AR(1) medido em campo), UMA decisão
por visita com significância Fisher-z contra `n_eff` (não contra n bruto).

- **A agregação de ticks da métrica anterior INFLAVA** (confirmado): somar Fisher-z sobre ticks de
  janela deslizante que compartilham 15/16 da amostra fabricava um n aparente. A janela única
  decide **0** episódios onde a agregação decidia **133**. Retratei o "evento 79,6%" que eu havia
  reportado antes — era o n inflado.
- **MAS o sinal é físico** — controle negativo pelo **deslocamento temporal circular** (o correto:
  preserva valores/distribuição/autocorrelação, destrói só o alinhamento; não o embaralhamento de
  nomes que já provamos ser cego): precisão real **82,6%** vs surrogate **7,7%** (Δ **74,9 pp**).
- **Veredito**: abstém nos dados atuais por falta de SPAN, não de sinal. Condicional à geometria.

### H2 — conservação por fronteira
Detector de cruzamento (`classifyCrossing` + histerese N=2): cruzamento genuíno limpo em **58-100%**,
oscilação de borda zerada. **MAS** a maioria dos tracks NASCE E MORRE dentro da zona (fragmentação),
então a fronteira raramente testemunha a transição. **Cura barata (medida, #27)**: `ttlMs=6000` faz
o track parado viver ~8 min como UM id → para de fragmentar → a fronteira passa a testemunhar
entrada E saída. **H2 fecha pela engenharia grátis, sem hardware.** Bônus: geometria de bbox NÃO
separa mobília de operador parado (aspect ~2,5 vs 2,8) — só duração separa.

## 2. Onda 1 — o que decide o receptor de zona (bancada, o achado central)

### θ (Δ2) — REFUTADO como 2º discriminador
Medi a distribuição empírica de θ (a inclinação de `RSSI = β + θ·(−log₁₀d)`) — NÃO fixei em 22, como
você ressalvou. θ_verdadeiro é largo/instável (mediana ~21 dB/déc, IQR [8,6; 31]; e DENTRO do gate
|r|≥0,7 sobe para [27; 62] porque selecionar por |r| alto premia retas íngremes). θ_espúrio-perigoso
espalha (IQR de largura 86). Nenhuma banda de θ supera o baseline só-|r| (55,6%); o peso heterocedástico
(1/d²) empata. **A sua ressalva anti-v4 se provou certa** — o viés corporal direcional infla o slope.

### Geometria do span + uma correção de métrica que muda a leitura
Cálculo NÃO-CIRCULAR (trajetória × distância euclidiana, sem o modelo de rádio): mover o receptor da
câmera para o destino ganha **3-4× no span** (std 0,09→0,29). **Porém achei uma confusão de métrica
no nosso próprio gate**: os limiares "0,42/0,9 década" são **RANGE** (`log10(8/3)=0,426`;
`log10(8/1)=0,903`), enquanto o código media **STD** (cujo teto numa aproximação reta idealizada é
~0,33). Corrigi (`visit-metrics.ts` agora reporta os dois). O que importa não é o std absoluto — é o
ganho relativo de gradiente, que é o que move |r| acima do ruído.

### A medição decisiva — estação no destino DECIDE H1? (metade circular/indicativa, declarada)
O sim gera `RSSI = f(dist→estação) + ruído`, então |r| é alto por construção; o que testo é se o
RUÍDO, no span maior, ainda deixa a significância honesta passar. Knob aditivo `stationWorldOverride`
(cenários bit-a-bit intactos, 58 testes de pinning verdes). ρ=0,7, pooled/325 visitas-com-tag:

| receptor | span std | decididas | cobertura | precisão |
|---|---|---|---|---|
| baseline (canto) | 0,13 | 0/325 | 0,0% | — |
| **destino** | 0,27 | 1/325 | 0,3% | 100% |
| ótimo de sala | ~0,30 | 2/325 | 0,6% | 100% |

**O span sobe como a geometria previu, mas a cobertura fica colada no chão.** Diagnóstico: o `n_eff`
MÁXIMO da suíte inteira é **6,88** — mal supera o piso 3. A variância de Fisher `√(1/(n_eff−3))`
explode aí e o gate exige **|r| ≥ 0,76**; o ganho de span não vence essa barra. **O gargalo é a
independência temporal, não o span radial.** Mover o receptor não toca o `n_eff`.

### Varredura de cadência — a alavanca real, e a nuance
O `n_eff` é governado pela cadência de refresh REAL do RSSI (advertising da tag), NÃO pelo POST (a
correção Δ4 de 500 ms não cria leituras distintas se a tag anuncia devagar — o dedup consecutivo
absorve). Dobrando 1 Hz → 2 Hz:

| cadência | n_eff máx | eps c/ n_eff>3 | cobertura | precisão |
|---|---|---|---|---|
| 1 Hz (atual) | 6,88 | 42/325 | 0,3% | 100% |
| **2 Hz** | 15,88 | 122/291 | **15,5%** | **97,8%** |

**Cadência de advertising é a alavanca de maior impacto — abre o gate 0,3%→15,5% a ~98% de precisão.**
Mas o ganho vem da DURAÇÃO do episódio, não da aproximação: `n_eff` mediano por regime a 2 Hz —
aproximação 3-8 s = **1,76** (abaixo do piso), longo 8-16 s = 3,88, muito-longo ≥16 s = 7,59. Alcançar
`n_eff>3` exige >17 leituras distintas ≈ **9 s a 2 Hz** (17 s a 1 Hz) — mais que uma aproximação real.
Cuidado honesto: os episódios que decidem são observações LONGAS EM MOVIMENTO (têm span + leituras);
o cenário `parado` (span 0) NUNCA decide — logo o operador estacionário não fecha por RSSI, a
identidade tem de ser fixada na chegada e conservada pela topologia.

## 3. Síntese — não é pivô contra a arquitetura; é a sua validação quantificada

As 5 camadas do seu parecer saem CONFIRMADAS, agora com os números de cada elo:
1. **Identidade RSSI (camada 2)** só contribui na **aproximação longa observada**, e só com tag de
   **advertising rápido (≥2 Hz)**. Per-visita por aproximação breve é estruturalmente inalcançável
   (`n_eff` curto demais) → a identidade **acumula entre visitas**, não fecha por uma.
2. **Conservação por zona (camada 3)** é o elo que carrega a permanência — e a alavanca é grátis
   (`ttlMs`), não hardware.
3. **Duração/HSMM + conformance (camadas 4-5)** são quem lê trabalho/ocioso — independem da
   identidade métrica.

## 4. A bifurcação que precisa da sua decisão (é resource/hardware, não medição)

- **#26 (2ª antena/ESP32) deixa de ser "o experimento decisivo" isolado.** O eixo decisivo virou
  **cadência de advertising × duração de observação**. Recomendação da bancada: se o alvo comercial
  é permanência observada no posto, **uma tag de advertising rápido (≥2 Hz) tem ROI maior que a 2ª
  antena** — o receptor no destino ajuda o span, mas o span não é o gargalo. Se o alvo é fluxo de
  passagem breve, nenhum receptor/cadência fecha per-visita → priorizar as camadas de acúmulo.
- **Perguntas para você**: (a) as tags do piloto suportam advertising ≥2 Hz sem matar a bateria? (b)
  o caso comercial primário é permanência-no-posto (favorável) ou passagem breve (desfavorável)? (c)
  seguimos para a Onda 2 (zonas de posto + Petri + workflow como prior) — que este resultado tornou
  a camada **load-bearing** — ou você quer um teste de campo com tag rápida antes?

## 5. Fontes primárias (reproduzíveis)

- `src/fusion/visit-metrics.ts` (+test) — H1, janela única, `n_eff`, controle circular, span std/range.
- `src/fusion/zone-crossing.ts` (+test) — H2, fronteira + histerese.
- `src/fusion/receiver-geometry.ts` (+test) — span por posição de receptor (não-circular).
- `src/fusion/theta-discriminator.ts` (+test) — Δ2 refutado.
- `src/fusion/receiver-at-destino.test.ts` + knob `stationWorldOverride` em `sim.ts` — a medição
  decisiva + varredura de cadência.
- `docs/analises/tags-bluetooth/PENDENCIAS.md` — os vereditos com os números completos.
- `docs/analises/decisoes/ADR-014-…md` — atualização 2026-07-12.
