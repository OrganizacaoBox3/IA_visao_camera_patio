# Spike (Fase 0) — resultados da física do BLE

> Medições reais com as tags do projeto (família OUI `48:87:2D:9D`, nomes `CPxx-<final do MAC>`) e o PC
> como scanner (bleak). Decide qual Tier é viável (00-avaliacao §4/§9). Registrar tudo (doutrina).

## Hardware identificado (2026-07-08)
- **Estação-alvo: Zebra TC22** (Android) — conecta por USB/ADB, autorizado. Será a antena real.
- **Tags: ≥9** da família `48:87:2D:9D:xx` — nomes `CP27-*/CP28-*` = `CP<lote>-<final do MAC>`. O nome vem
  INTERMITENTE (várias só apareceram no 2º/3º scan); **o MAC é sempre estável → cadastrar por MAC** (feito:
  5 já no `bt_tags`, `match()` por MAC OK).

## Medida 1 — estabilidade do RSSI (tag PARADA, 30s)

| tag | MAC (final) | média dBm | desvio | min | max | pkts |
|---|---|---|---|---|---|---|
| CP-CE3C | CE:3C | -56,1 | **1,4** | -58 | -54 | 10 |
| CP-CE5D | CE:5D | -59,8 | **1,1** | -62 | -57 | 14 |
| CP-CE83 | CE:83 | -61,2 | 2,9 | -64 | -57 | 4 |
| CP28-C564 | C5:64 | -61,9 | 2,5 | -66 | -56 | 29 |
| CP-CE89 | CE:89 | -62,3 | 2,2 | -65 | -59 | 6 |
| CP28-C573 | C5:73 | -63,1 | **4,7** | -77 | -58 | 36 |
| CP27-CE6E | CE:6E | -64,0 | **0,8** | -65 | -63 | 6 |
| CP27-CE8D | CE:8D | -64,9 | 3,3 | -75 | -58 | 33 |
| CP27-CE9D | CE:9D | -69,1 | 4,2 | -77 | -62 | 23 |

## Veredito da Medida 1
- **Ruído: 0,8-4,7 dB** parado (mediana ~2-3 dB). Aceitável, não trivial.
- **Outliers de até ~19 dB** (C5:73: -77↔-58) parado → **suavização por MEDIANA numa janela é obrigatória**;
  RSSI instantâneo engana.
- **Separação por RSSI:** pessoas em distâncias distintas (≥~10-15 dB) separam; **próximas (~1-2 m) embolam**.
  Confirma: 1 estação + RSSI-only para 3-6 pessoas fica **no limite** — precisa da correlação-no-tempo
  (movimento que a câmera vê) + "não sei" honesto quando aglomeram.

## Próximas medidas (precisam de você mover as tags)
- **Medida 2 — RSSI × distância:** 1 tag a 1m, 2m, 3m, 5m (parar ~15s em cada). Confirma a curva e quanto
  1 m vale em dB (define a resolução de distância).
- **Medida 3 — 2-3 tags andando diferente:** o teste real da correlação — separa quem se move distinto?
- Rodar a estação no **TC22** (não o PC) — o RSSI da antena real pode diferir.

## Medida 2 — RSSI × distância (tag andando 1m→2m→4m→6m, 90s)

Tag identificada pelo TREND (as tags são fisicamente indistinguíveis — só o padrão de queda revela qual
se moveu). `CE:6E` (a carregada): **-66 → -75 dBm = 9 dB** de queda 1m→6m. Estacionárias: 0-3 dB (ruído).

| | valor | implicação |
|---|---|---|
| **Sinal** (1m→6m) | ~9 dB | distância REGISTRA, mas modesto |
| **Ruído em movimento** | 5-9 dB (desvio) | corpo/orientação add muito ruído ao andar |
| **SNR** | **≈ 1** | separa PERTO×LONGE; NÃO separa 1-4m (dentro do ruído) |

## VEREDITO do spike (Fase 0) — medido

**1 estação + RSSI-only NÃO separa 3-6 pessoas de forma confiável.** O sinal de distância (9 dB) mal
supera o ruído de movimento (5-9 dB). Distingue extremos, não posições finas. Confirma o alerta do
`00-*` §9 — agora com número.

**Achado prático:** tags fisicamente indistinguíveis → precisam de **etiqueta física** (MAC/nome); o
sistema tem que auto-descobrir a associação (não dá pra confiar que o operador sabe qual tag é de quem).

## Bifurcação (decisão do dono, guiada pelo dado)
| Opção | O que muda | Viabilidade p/ 3-6 |
|---|---|---|
| **A — tags com IMU** (upgrade barato) | acelerômetro = sinal de movimento INDEPENDENTE do RSSI | **Sólida** — o de-risco recomendado |
| **B — 3 estações** (trilateração) | XY por interseção de 3 anéis + homografia | Sólida, mais infra/calibração |
| **C — seguir com 1 estação (correlação RSSI×distância-da-câmera)** | fusão marginal + "não sei" frequente | **Marginal** — só pessoas bem separadas/movendo diferente |
| **D — voltar pro facial** | (o que o dono queria evitar por custo) | precisa/preciso mas caro |

**Recomendação:** **A (tags com IMU)** — o menor custo que torna 3-6 pessoas viável de verdade. Se A não
for possível, **C como piloto honesto** (assumindo poucos acertos com aglomeração), medindo antes de prometer.
