# SPEC — Multi-antena BLE (N estações; a 2ª é outro celular com o app)

> Status: **proposta aguardando aval do dono** · Data: 2026-07-12
> Insumos: pesquisa de mercado RTLS multi-gateway (Quuppa, Kontakt.io, Moko/Minew, HID, Zebra,
> Lansitec — fontes na pesquisa) + auditoria do caminho completo estação→motor (7 mapas,
> arquivo:linha). Fundação prévia: ADR-013 (motor universal) + rito de homologação PINADO em
> `docs/cientifica/checklist-entrada-sensor.md`.

## 0. O estado real (auditado) — o motor está pronto; o encanamento não

**O que JÁ existe (dormante, testado):** `RawReading.sourceId` + `multiSourceFisher` no
`associate.ts` de produção — particiona RSSI por fonte, aplica os MESMOS gates por fonte e combina
por soma ponderada de Fisher-z (com 1 fonte reduz bit-a-bit ao caminho atual). A gravação já é
multi-fonte-ready (`stationId` + `sourceKind:"ble-rssi"` no JSONL). **Previsão do ADR-013: zero
linhas no motor — e a auditoria confirma.**

**Os 3 elos quebrados (onde o trabalho mora):**
1. **O app**: `STATION_ID = "tc22"` é constante de compilação (`MainActivity.java:76`) — dois
   celulares postariam o MESMO id. E **não manda `x-station-token`** → leva 401/503 contra o hub
   de produção pós-faxina.
2. **O store colapsa por MAC** (`bt-readings.js:10`): duas estações vendo a mesma tag **se
   sobrescrevem** (last-writer-wins) — as duas séries de RSSI colidem no mesmo slot. A partição
   por fonte do motor nunca receberia as duas.
3. **`sourceId` nunca é preenchido ao vivo**: as leituras de produção carregam `stationId`, mas
   ninguém mapeia para `sourceId` no `buildFusionFrame` — só o replay faz. No cliente ao vivo o
   pool é sempre único.

## 1. Decisões de design (mercado + física medida no arco)

| # | Decisão | Fundamento |
|---|---|---|
| **M1** | **Gateway burro + fusão central.** O celular só encaminha `(mac, rssi)` com seu `stationId`; NADA de fusão/média na borda. Streams independentes por estação; o motor combina. | Padrão unânime (Quuppa/Kontakt/Minew/Zebra). Anti-padrão explícito: média de RSSI entre receptores. |
| **M2** | **N livre desde o dia 1** — o id da estação vira configurável no app; o servidor trata estação como dado, não como singleton. | Pedido do dono ("deixe livre"). |
| **M3** | **Timestamp do SERVIDOR na chegada** (como hoje) — não confiar no relógio dos celulares. A defasagem entre fontes fica limitada ao batching (~0,5–1s), suficiente para correlação de movimento humano (dinâmica de segundos). `deviceTs` opcional no payload fica como extensão de diagnóstico. | Prática de mercado; NTP em celular é não-confiável. |
| **M4** | **Posicionamento: NÃO-COLINEAR, na diagonal, 2,5–3 m, longe de metal, com walk-test antes de fixar.** A razão é a física MEDIDA no arco: os erros de identidade vêm do **rival radialmente confundível** (vizinho que espelha meu perfil de distância à estação A). Dois eixos radiais distintos quebram o espelho — **desde que não-colineares com o eixo de movimento dominante** (colinear = mesmo eixo = não quebra nada). | Pesquisa (disparidade entre 2 receptores discrimina pessoas próximas ≥ RSSI absoluto) + `error-geometry` do arco (AUC 0,92 do rivalDistCorr). |
| **M5** | **Fusão de identidade em DUAS fases honestas** (a limitação já documentada no próprio motor): **Fase A** — estações como dimensões extras de assinatura, correlacionando cada fonte contra a série de distância existente (válido, ganho limitado); **Fase B** — `dist` POR estação (o contrato `TrackDist` ganha distâncias por fonte; RSSI_B × dist_B) — é AQUI que os 2 eixos radiais atacam o rival. Fase B é o valor real; Fase A é o degrau de validação. | `associate.ts:242-251` (limitação de escopo explícita); ADR-013. |
| **M6** | **Falha de estação = degradação natural, não failover especial.** Fonte muda → contribuição zero no gate de n_eff → o motor volta a operar como 1-fonte sozinho. Health por estação via heartbeat (a ausência do stream É o sinal) + chip por estação na UI. | Pesquisa (heartbeat/timeout padrão) + design do gate existente. |
| **M7** | **NADA vira default sem o TORNEIO já pinado**: precisão(A+B) ≥ máx(A,B) · cobertura ≥ 1,5× · conflito ≤ 0,6× — critérios cravados ANTES do resultado, rito de 6 passos do checklist (gravação de campo → replay → torneio → sentinela adversarial → decomposição por tipo de erro → default). E a **Regra 13 vale**: medir `agreementOnFailure` ENTRE estações (dado independente ≠ erro independente — já nos queimou). | `checklist-entrada-sensor.md` §3; Regra 13 do CLAUDE.md. |

## 2. Modelo (tudo aditivo)

```ts
// App (Java): STATION_ID vira pref persistida + dialog (molde do promptHubUrl já existente)
//             + header x-station-token (pref) em postOnce/postTagName/syncTagNames.
// Payload inalterado: {stationId, readings:[{mac,name,rssi}]} — só o id passa a variar.

// Store (server/bt/bt-readings.js): chave composta
latest: Map<`${stationId}|${mac}`, { mac, stationId, rssi, ts, rotulo }>
snapshot(): rec[]                    // TODAS as fontes vivas (não mais 1/MAC)
snapshotByStation(): Map<stationId, rec[]>   // p/ health e UI

// Calibração (camcfg cleanCalibration): aditivo
calibration.stations?: Record<stationId, { x: number; y: number }>  // N pontos
// `station` legado permanece = fallback da estação principal (retrocompat)

// Frame (src/fusion/frame.ts): o elo que falta
reading.sourceId = reading.stationId   // o mapeamento trivial que ninguém fazia
// Fase B: TrackDist ganha distByStation?: Record<stationId, number>
```

## 3. Fases

**F1 — App multi-estação [P, isolado — é Java]:** `STATION_ID` configurável+persistido (dialog no
molde do `promptHubUrl`), header `x-station-token`, id default derivado do device (ex.
`tc22-<serial4>`) para dois celulares nunca colidirem de fábrica. Instalável no 2º celular no fim
desta fase.

**F2 — Store/transporte por fonte [P]:** chave `(stationId, MAC)` no store + snapshot completo +
socket/GET preservando fonte + `BtTagsPage` agrupando por estação (hoje descarta `stationId` no
merge) + **health por estação** (`useStationHealth`/`StationHealthChip` viram lista — hoje a
tag-âncora mediria o RSSI de quem postou por último, misturando fontes silenciosamente).

**F3 — Calibração N pontos [S após F2]:** `calibration.stations` (aditivo, allowlist
`cleanCalibration`) + UI no CalibrationPanel para marcar o ponto de CADA estação + walk-test
guiado (M4: aviso se os pontos ficarem colineares com o eixo dominante).

**F4 — Motor Fase A [S após F2]:** o mapeamento `stationId→sourceId` no caminho vivo
(`frame.ts`/`useTagFusion`) + correção do replay (o resample hoje SUBSTITUI o snapshot por evento
ble em vez de UNIR fontes — mesmo bug do store, já anotado no código) + `multiSourceFisher`
ligável em bancada. **Nenhuma linha no algoritmo de fusão.**

**F5 — Motor Fase B [S após F3+F4]:** `dist` por estação no `buildFusionFrame` (stationWorld por
fonte via homografia) + `multiSourceScore` correlacionando cada fonte contra a SUA distância. É a
única fase que toca o motor — e é a que ataca o rival.

**F6 — Homologação [GATE, S]:** gravação de campo com 2 estações (o session-recorder já grava
certo) → replay → **torneio com a regra pinada (M7)** → sentinela adversarial → decomposição por
tipo de erro → só então default. Medir `ρ_AB` (correlação entre fontes) e `agreementOnFailure`
entre estações — os números que dizem quanto a 2ª antena REALMENTE soma.

## 4. Critérios de aceite

- **CA-1 (coexistência):** Given 2 celulares com ids distintos postando; Then o store guarda as
  DUAS séries por MAC (nenhuma sobrescrita) e o socket entrega ambas — teste com POSTs
  intercalados.
- **CA-2 (elo sourceId):** Given leituras ao vivo com stationId; Then os `RssiSample` do motor
  carregam `sourceId` e `partitionBySource` vê 2 grupos (hoje: sempre 1).
- **CA-3 (retrocompat 1 estação):** com UMA estação, todo o pipeline (motor, health, UI, replay) é
  **bit-idêntico** ao atual — regressão explícita.
- **CA-4 (app):** id configurável sobrevive a restart; POST leva token; dois devices com id
  default NÃO colidem.
- **CA-5 (health por fonte):** estação B morta → chip B "sem sinal"; motor segue operando com A
  (degradação M6) sem código especial.
- **CA-6 (replay multi-fonte):** gravação com 2 estações → resample UNE as fontes por tick (não
  substitui) → `replayFusionSession` produz partição de 2 grupos.
- **CA-7 (gate de promoção):** `multiSourceFisher` só vira default se o torneio F6 passar a regra
  pinada — assert no harness de que a promoção sem torneio é impossível (flag documentada).

## 5. Fora de escopo v1

Trilateração/posição métrica por RSSI (refutado no arco — regra nº 6); média de RSSI entre
receptores (anti-padrão de mercado); separação de canal BLE (o Android não expõe — segue sendo a
razão do ESP32-instrumento, frente própria); NTP/deviceTs nos celulares (M3); mais de 1 câmera por
replay (limitação atual do loader, inalterada); auto-descoberta de posição das estações.

## 6. Riscos e mitigações (das armadilhas auditadas)

| risco | mitigação |
|---|---|
| Store colapsando fontes (o bug central) | F2 chave composta + CA-1; poda por staleness POR FONTE |
| sourceId ausente ao vivo | F4 mapeamento explícito + CA-2 |
| Fase A prometendo o ganho da Fase B | M5 separa as fases; F6 mede cada uma; nada promovido sem torneio |
| Replay substitui snapshot por evento ble | correção na F4 + CA-6 (o comentário no código já avisa) |
| App sem token (401 em produção) | F1; e o chip "Hub ✗" do app já denuncia |
| Health misturando fontes | F2 health por estação + CA-5 |
| Relógios defasados entre celulares | M3 server-side timestamp (defasagem ≤ batching, tolerável p/ dinâmica humana) |
| Instalação colinear (não quebra o rival) | M4 no walk-test + aviso na calibração F3 |
| Erro correlacionado entre fontes (Regra 13) | F6 mede agreementOnFailure entre estações ANTES de promover |
