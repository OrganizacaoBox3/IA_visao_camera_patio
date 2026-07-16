# Estabilidade da Planta BLE — diagnóstico dos sumiços/saltos e plano

> Data: 2026-07-15 · Origem: queixa do dono ("às vezes todas as tags simplesmente somem da tela,
> ou mudam de lugar"). Diagnóstico por inspeção da cadeia inteira (app → hub → front), com os
> endereços de código. Doc vivo desta correção.

## 1. A pista que resolve o caso: os sintomas são COLETIVOS

Tags que somem/saltam TODAS AO MESMO TEMPO não são ruído por tag — são falha de FONTE (estação).
A cadeia: tag anuncia → celular escaneia → POST ~500 ms → hub (`bt-readings`, poda por medição
mais velha que 15 s, por estação) → poll 2 s do front → vetor vivo (frescor 6 s / sincronismo 3 s)
→ classificação/WKNN → motion-filter → mapa. Quando UMA estação cala, todas as tags perdem aquela
antena do vetor ao mesmo tempo; quando TODAS calam, o hub poda tudo em 15 s e a lista fica vazia.

## 2. Causas, por ordem de probabilidade × evidência

**C1 — O scan Android morre com a tela desligada (a causa raiz mais provável do sumiço coletivo).**
`tc22-scanner/.../MainActivity.java:407` faz `scanner.startScan(null, settings, cb)` — **sem
`ScanFilter`**. Desde o Android 8.1, o framework **suprime resultados de scan NÃO-FILTRADO com a
tela apagada**. O watchdog do app (linha 395) religa o scan mudo, mas religar um scan sem filtro com
tela apagada continua mudo — o watchdog não cura, só insiste. O app segue vivo e POSTando
`readings: []`; o hub poda tudo em 15 s; **todas as tags somem**. Alguém acende a tela → tudo volta.
**Prova de campo antiga no próprio projeto**: o bug B6 do laudo de 2026-07-13 registrou uma estação
**22 h postando `readings: []`** sem alarme — é exatamente esta assinatura. O `FLAG_KEEP_SCREEN_ON`
(linha 978) mitiga enquanto o app está em foreground com a tela JÁ ligada, mas não sobrevive a
botão power/política de tela da ROM (Samsung é agressiva).

**C2 — Uma estação caindo/voltando muda TODAS as posições (o "mudam de lugar" coletivo).**
O vetor vivo exige medições frescas (≤6 s) e sincronizadas entre si (≤3 s)
(`useFingerprints.buildFreshLiveVectors`). Quando uma antena atrasa/cai (C1, Wi-Fi power save,
batch atrasado), ela sai do vetor de TODAS as tags de uma vez → a distância em dB muda de base → o
WKNN recalcula com outro conjunto → **todas mudam de lugar juntas** (e voltam quando a antena
volta). O motion-filter limita a 1,8 m/s, então vira deriva coletiva, não teleporte — exceto C4.

**C3 — Não existe "última posição conhecida" no front: rádio calou = tag DESAPARECE.**
`deriveFloorplanView` só produz tags a partir das leituras vivas; quando o hub poda, a tag sai da
LISTA — e `deriveContinuousFloorplan` itera `view.tags`, então o hold de 10 s do motion-filter
(`holdMs`) nunca chega a valer para tag que saiu da lista. O requisito R10 e o guia §15.2 pedem o
oposto: manter a última posição com estado incerto/halo crescendo. Hoje o sumiço é abrupto.

**C4 — Teleporte pós-gap.** Quando o hold de 10 s expira (pos → null) e a tag volta,
`createMotionTrack` recria o track do zero **sem limite de velocidade** — a tag rematerializa
longe. Fonte secundária de salto: alternância fingerprint ↔ two-circle/multilateração no
`selectPositionCandidate` (geometrias muito diferentes) sem histerese de fonte.

**C5 — (Operacional) Config de tela/energia dos celulares-estação.** Se a tela apaga por timeout,
C1 dispara. Mitigação de 2 minutos, sem código, já em campo: manter os 3 aparelhos com
"Permanecer ativo durante o carregamento" (Opções do desenvolvedor), ou
`adb shell settings put global stay_on_while_plugged_in 7`.

## 3. Plano

- **F0 — Confirmar em campo (5 min, sem código).** Na próxima ocorrência, abrir `/tags-ble?aba=estacoes`:
  se a(s) estação(ões) estiverem "sem sinal" junto com o sumiço, é C1/C5 confirmado. Aplicar C5
  (stay-awake) nos 3 celulares JÁ — se os sumiços cessarem, C1 confirmada por intervenção.
- **F1 — App da estação (a correção estrutural, ~1–2 h).**
  (a) **`ScanFilter` por OUI/MAC das tags** (o app já sincroniza a lista de MACs cadastrados via
  `GET /api/bt/tags` — usar como filtro; fallback: prefixo OUI `48:87:2D`): scan filtrado **continua
  entregando resultados com a tela desligada** — mata a C1 na raiz;
  (b) POST ganha campo `scanning`/contagem de callbacks (saúde honesta da fonte);
  (c) manter watchdog + KEEP_SCREEN_ON como defesa em profundidade.
- **F2 — Front: última posição conhecida + fim do teleporte (~1–2 h).**
  (a) manter tag recém-calada na view por um TTL (~60 s) com estado `incerto`, posição congelada e
  halo crescendo (o motion-filter já modela; a view é que descarta — C3);
  (b) re-entrada pós-gap curto (<30 s) limitada por `moveTowards` a partir da última posição (C4);
  (c) histerese de FONTE no `selectPositionCandidate` (só troca fingerprint↔geometria após K
  observações consecutivas da outra fonte);
  (d) aviso no mapa quando o nº de antenas vivas cai ("antena X sem sinal — precisão reduzida") —
  torna a C2 visível em vez de misteriosa.
- **F3 — Hub: alarme de estação cega (~30 min).** "Postando, mas 0 leituras há N min" → estado
  distinto de "sem sinal" na aba Estações (o B6 do laudo, ainda aberto — vira o sensor permanente
  da C1).
- **F4 — Gate de validação (15 min de campo).** Derrubar uma estação de propósito (apagar tela /
  fechar app) e verificar: tags NÃO somem (viram incertas com halo), nenhum salto acima do limite,
  alarme de estação aparece; religar e verificar retorno suave. Repetir com duas estações.

Ordem: **C5 hoje (operação) → F1 (app) → F2 (front) → F3 (hub) → F4 (gate)**. F1 e F2 são
independentes (dono-de-arquivo distinto) e podem andar em paralelo.

## 3.1 STATUS DA IMPLEMENTAÇÃO (2026-07-15, mesma noite — 3 frentes paralelas por dono-de-arquivo)

- **F1 (app) ✅ — com CORREÇÃO após auditoria no ar (2026-07-15, tarde).** A 1ª versão do filtro
  (iBeacon Apple 0x004C + Eddystone 0xFEAA) deixou o app com **0 tags**: o formato REAL das DX-CP27,
  auditado por dump RAW dos advertisements (log "RAW" no `onScanResult`, permanente/throttled), é
  **(a) frame proprietário DX** — service UUID **0xFDA5** na lista + service data 0xFEAB (bateria+MAC)
  e 0xFEAC + nome — e **(b) frame iBeacon com company ID 0x4458 ("DX" em ASCII), NÃO 0x004C**.
  `buildScanFilters()` corrigido: FDA5 + manufacturerData 0x4458 (02 15) + os dois genéricos como
  futuro-proof. **VALIDADO EM CAMPO no S24: 53 leituras de tag em 20 s COM A TELA APAGADA** (antes:
  zero — a causa C1 está morta). Payload ganhou `"scanning": <bool>`. APK final:
  `tc22-scanner/build/aligned.apk`.
  Status por aparelho: **S24 (.103) ✅** instalado+stay-awake+validado screen-off; **.111 ✅**
  instalado+stay-awake (123 leituras/12 s); **.102 ⬜** aguarda pareamento ADB wireless ou instalação
  manual do APK. Avisos operacionais: o S24 está com o armazenamento 100% cheio (515 MB livres) —
  risco para uma estação 24/7; e o hub (192.168.68.110:4000) estava INACESSÍVEL durante os testes
  (POSTs falhando) — subir o hub antes do gate F4.
- **F2 (front) ✅** — `motion-filter.ts`: `lastPos` + `recoverMs:30s` (re-entrada pós-gap ancorada
  na última posição, passo limitado — fim do teleporte C4); `continuous-position.ts`: `TagRuntime`
  com histerese de fonte (downgrade fingerprint→geometria só após 3 polls — fim do ping-pong) e
  **tags-fantasma** (tag calada permanece 60 s como "última posição conhecida · incerta", halo
  crescendo — fim do sumiço abrupto C3); banner "antena X sem sinal — posições menos precisas" no
  mapa operacional (C2 visível); painel diferencia "Última posição conhecida (sem sinal novo)".
- **F3 (hub/UI) ✅** — `bt_stations` ganha `ultima_leitura_em`/`scanning` (aditivo/idempotente,
  mesmo write-behind de 60 s); `seen()` retrocompat; rota repassa `hadReadings`+`scanning`; aba
  Estações ganha o estado **"cega"** (badge warn: "postando, sem ler tags há X — verifique a
  tela/scan do aparelho") — o B6 virou sensor permanente.
- **Validação combinada**: typecheck/lint/build ✓ · **1.754 testes verdes** (+20 das frentes),
  43 ignorados · e2e `/planta-ble` ✓ (4,0 s).
- **F4 (gate de campo) ⬜ — ação do dono**: (1) instalar o APK novo nos 3 celulares; (2) aplicar
  `adb shell settings put global stay_on_while_plugged_in 7` (C5, defesa em profundidade);
  (3) teste de intervenção: apagar a tela de uma estação → as leituras devem CONTINUAR (F1);
  fechar o app de uma estação → tags NÃO somem (viram "última posição conhecida"), aba Estações
  mostra sem-sinal/cega, mapa avisa a antena caída; religar → retorno suave, sem teleporte.

## 4. O que este diagnóstico NÃO afirma (Regra 9)

Sem gravação do momento exato de um sumiço, C1/C5 é a causa mais provável por mecanismo + prova
histórica (B6), não por captura do evento. O F0 fecha essa lacuna em uma ocorrência. C2–C4 são
lidas diretamente do código (endereços acima) e valem independentemente de qual gatilho derruba a
fonte.
