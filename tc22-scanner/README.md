# tc22-scanner — estação BLE do TC22 (identidade aumentada)

App Android mínimo que roda no coletor **Zebra TC22** (Android 14): varre anúncios BLE e mostra/loga as
tags do projeto (família `48:87:2D` / nome `CP*`). É a **antena real** da fusão tag↔câmera
(`docs/analises/tags-bluetooth/`). Passo atual: **provar que o coletor acha todas as tags** (logca `BTSCAN`).
Responsabilidade única: varrer + exibir. (Reporte HTTP ao hub = próximo passo.)

## Build + deploy (sem gradle — offline, evita o conflito gradle 7.5.1 × JDK 21)
```bash
bash build.sh
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
