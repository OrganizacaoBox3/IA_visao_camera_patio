# tc22-scanner — estação BLE (qualquer Android ≥8; TC22, S24, etc.)

App Android mínimo que transforma um celular fixo na **antena/estação BLE** do projeto: varre os
anúncios das tags (família `48:87:2D` / nome `CP*`) e POSTa `{stationId, scanning, readings:[…]}`
ao hub a cada ~500 ms. É a fonte de dados da Planta BLE e da fusão tag↔câmera.

## Instalar num aparelho NOVO (o caminho rápido)

**APK pronto e assinado**: `build/btscan-estacao-2026-07-15.apk` (idêntico a `build/aligned.apk`).

1. **Com PC**: `adb install -r build/aligned.apk` (mesma assinatura — instala por cima sem perder
   config). **Sem PC**: mande o APK por Drive/WhatsApp, toque nele e aceite "fontes desconhecidas".
2. Abra o app 1× e conceda as permissões (Bluetooth/Localização). Ele acha o hub sozinho na LAN
   (broadcast UDP :41234); o id da estação nasce único (`tc22-<4 chars do ANDROID_ID>`).
3. **Config recomendada do aparelho-estação** (fixo, na tomada):
   - `adb shell settings put global stay_on_while_plugged_in 7` (tela nunca apaga carregando) —
     defesa em profundidade; o scan FILTRADO já sobrevive à tela apagada (ver abaixo);
   - desativar otimização de bateria para o app (Configurações → Bateria);
   - Wi-Fi fixo na rede do hub.
4. Confirme que está lendo: `adb logcat -s BTSCAN` → linhas `TAG <mac> <nome> <rssi>`; e a estação
   aparece na aba Estações da central (auto-descoberta no 1º POST — batize o nome por lá).

## O que este build tem (2026-07-15 — estabilidade C1)

- **Scan SEMPRE filtrado** (`buildScanFilters`): o Android ≥8.1 suprime scan não-filtrado com a
  tela apagada — era a causa das estações "cegas". Filtros auditados NO AR contra as DX-CP27:
  service UUID **0xFDA5** (frame proprietário DX) + manufacturer data **0x4458** ("DX", frame
  iBeacon deles) + 0x004C/0xFEAA como futuro-proof. **Se reconfigurar o formato de advertising das
  tags, re-audite com o log `RAW`** (o app despeja o advertisement cru por tag a cada ~10 s).
- **Campo `scanning` no POST**: o hub distingue "estação viva" de "estação CEGA" (postando sem ler)
  e a aba Estações alarma.
- Watchdog de scan mudo + `FLAG_KEEP_SCREEN_ON` seguem como defesa em profundidade.

## Build + deploy (sem gradle — offline, evita o conflito gradle 7.5.1 × JDK 21)
```bash
bash build.sh                 # build + instala no device conectado
bash build.sh --build-only    # só gera build/aligned.apk
```
Faz: javac (`-XDstringConcat=inline`) → **d8 do build-tools 36** (o do 34 tem bug de R8 com JDK 21;
**sem** `--no-desugaring` — o d8 precisa desugarar o acesso nestmate) → aapt2 link → jar (add dex) →
zipalign → apksigner (keystore **estável** `debug.keystore`) → `adb uninstall` + install → grant das
permissões (Android 14: `BLUETOOTH_SCAN neverForLocation`) → abre o app.

## Ver as tags que o TC22 achou
```bash
adb logcat -s BTSCAN     # linhas "TAG <mac> <nome> <rssi>"
```

## Multi-estação: id + token (spec-multi-antena-ble §F1)
- **Id da estação**: pref persistida; **toque no TÍTULO** p/ editar (1–32 chars `[a-zA-Z0-9_-]`).
  Default de 1º boot: `tc22-` + 4 últimos chars do **ANDROID_ID** — dois celulares recém-instalados
  não colidem (CA-4). `Build.SERIAL` foi descartado: na API 26+ (o minSdk) exige `READ_PHONE_STATE`.
- **Token do hub**: campo opcional no dialog do hub (**toque no SUBTÍTULO**); quando preenchido vai
  em `x-station-token` em todo request (ingest, tag-name, sync de nomes). Vazio = LAN aberta (dev).
- O id atual aparece no título E no subtítulo — o operador vê qual id o device usa.

## Lições do build manual (pra não repetir)
- **StringConcatFactory**: o Android não tem — `"a"+b` via invokedynamic CRASHA. Use StringBuilder
  explícito (ou `-XDstringConcat=inline`, que no JDK 21 aqui NÃO bastou; StringBuilder é à prova de bala).
- **IllegalAccessError (nestmate)**: campo privado lido de classe anônima precisa do desugaring do d8 —
  NÃO passe `--no-desugaring`.
- **INSTALL_FAILED_UPDATE_INCOMPATIBLE**: keystore tem que ser ESTÁVEL entre builds (fora de `build/`);
  `adb uninstall` antes se a assinatura mudou.
- **d8 do build-tools 34** (R8 8.2.2) NPE com class do JDK 21 → usar o do **36**.
