#!/usr/bin/env bash
# Build manual do APK (sem gradle — evita o conflito gradle 7.5.1 × JDK 21). Offline, determinístico.
# javac → d8 → aapt2 link → jar(add dex) → zipalign → apksigner → adb install/grant/run.
#
# USO (multi-estação — a partir de 2026-07-13 há mais de um aparelho plugado):
#   bash build.sh                 # 1 aparelho conectado: usa ele
#   bash build.sh <serial>        # escolhe o alvo (veja `adb devices -l`)
#   bash build.sh --all           # instala em TODOS os aparelhos conectados (a frota inteira)
#   bash build.sh --build-only    # só gera o APK (build/aligned.apk), não instala
# Sem alvo e com N>1 conectados o script PARA e lista — instalar no aparelho errado é pior que falhar.
set -e
SDK="C:/Users/crist/AppData/Local/Android/Sdk"
BT="$SDK/build-tools/36.0.0"
AJAR="$SDK/platforms/android-34/android.jar"
JDK="C:/Program Files/Java/jdk-21"
ADB="$SDK/platform-tools/adb.exe"
PKG="com.grendene.btscan"
cd "$(dirname "$0")"

# ── alvo(s) do deploy ────────────────────────────────────────────────────────
TARGET="${1:-}"
DEVICES=$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')
NDEV=$(printf '%s\n' "$DEVICES" | grep -c . || true)

if [ "$TARGET" = "--build-only" ]; then
  TARGETS=""
elif [ "$TARGET" = "--all" ]; then
  TARGETS="$DEVICES"
elif [ -n "$TARGET" ]; then
  TARGETS="$TARGET"
elif [ "$NDEV" -eq 1 ]; then
  TARGETS="$DEVICES"
elif [ "$NDEV" -eq 0 ]; then
  echo "ERRO: nenhum aparelho conectado. Ligue o USB, ou pareie a depuração sem fio:"
  echo "  adb pair <ip>:<porta-de-pareamento>   (o código de 6 dígitos aparece na tela do celular)"
  echo "  adb connect <ip>:<porta-de-conexão>   (é OUTRA porta — a que fica na tela principal)"
  echo "Ou gere só o APK: bash build.sh --build-only"
  exit 1
else
  echo "ERRO: $NDEV aparelhos conectados — diga em QUAL instalar (instalar no errado é pior que falhar):"
  "$ADB" devices -l | sed 's/^/  /'
  echo "  bash build.sh <serial>   |   bash build.sh --all   |   bash build.sh --build-only"
  exit 1
fi

rm -rf build && mkdir -p build/classes

echo "== 1. javac =="
# -XDstringConcat=inline: concatena com StringBuilder (o Android NÃO tem java.lang.invoke.StringConcatFactory,
# que o javac moderno usaria via invokedynamic → crash em runtime).
"$JDK/bin/javac" --release 11 -g -XDstringConcat=inline -cp "$AJAR" -d build/classes src/com/grendene/btscan/MainActivity.java

echo "== 2. d8 (dex) =="
# SEM --no-desugaring: o d8 PRECISA desugarar o acesso nestmate (campo privado lido da classe
# anônima, Java 11+) num accessor sintético — senão IllegalAccessError no ART em runtime.
"$BT/d8.bat" --lib "$AJAR" --min-api 26 --output build build/classes/com/grendene/btscan/*.class

echo "== 3. aapt2 link (sem recursos) =="
"$BT/aapt2.exe" link -o build/base.apk -I "$AJAR" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 34 --no-version-vectors

echo "== 4. adiciona classes.dex ao APK =="
( cd build && "$JDK/bin/jar" uf base.apk classes.dex )

echo "== 5. zipalign =="
"$BT/zipalign.exe" -f 4 build/base.apk build/aligned.apk

echo "== 6. keystore (ESTÁVEL — fora de build/ p/ a assinatura não mudar entre builds) =="
[ -f debug.keystore ] || "$JDK/bin/keytool" -genkeypair -keystore debug.keystore \
  -storepass android -keypass android -alias dbg -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Android Debug,O=Grendene,C=BR"

echo "== 7. apksigner sign =="
"$BT/apksigner.bat" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias dbg build/aligned.apk

if [ -z "$TARGETS" ]; then
  echo
  echo "OK — APK pronto (sem instalar): build/aligned.apk"
  echo "Para instalar: bash build.sh <serial>   (veja os alvos com: adb devices -l)"
  exit 0
fi

# ── 8-10. deploy em CADA alvo ────────────────────────────────────────────────
# O id da estação é DERIVADO do ANDROID_ID no 1º boot (tc22-<4 chars>), então cada aparelho
# nasce com um id único — não há colisão ao instalar o mesmo APK na frota inteira (CA-4).
for DEV in $TARGETS; do
  echo
  echo "════ deploy em $DEV ════"
  "$ADB" -s "$DEV" shell getprop ro.product.model 2>/dev/null | sed 's/^/  modelo: /' || true

  echo "== 8. adb install (uninstall antes: assinatura pode ter mudado de builds anteriores) =="
  "$ADB" -s "$DEV" uninstall "$PKG" 2>/dev/null || true
  "$ADB" -s "$DEV" install build/aligned.apk

  echo "== 9. concede permissões de scan (Android 14) =="
  "$ADB" -s "$DEV" shell pm grant "$PKG" android.permission.BLUETOOTH_SCAN || true
  "$ADB" -s "$DEV" shell pm grant "$PKG" android.permission.BLUETOOTH_CONNECT || true

  echo "== 10. abre o app =="
  "$ADB" -s "$DEV" shell am start -n "$PKG/.MainActivity"
done

echo
echo "OK — app rodando. Leia as tags: adb -s <serial> logcat -s BTSCAN"
echo "No app: toque no TÍTULO p/ editar o id da estação · no SUBTÍTULO p/ apontar o hub (URL + token)."
