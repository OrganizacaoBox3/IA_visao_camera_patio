#!/usr/bin/env bash
# Build manual do APK (sem gradle — evita o conflito gradle 7.5.1 × JDK 21). Offline, determinístico.
# javac → d8 → aapt2 link → jar(add dex) → zipalign → apksigner → adb install/grant/run.
set -e
SDK="C:/Users/crist/AppData/Local/Android/Sdk"
BT="$SDK/build-tools/36.0.0"
AJAR="$SDK/platforms/android-34/android.jar"
JDK="C:/Program Files/Java/jdk-21"
ADB="$SDK/platform-tools/adb.exe"
PKG="com.grendene.btscan"
cd "$(dirname "$0")"
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

echo "== 8. adb install (uninstall antes: assinatura pode ter mudado de builds anteriores) =="
"$ADB" uninstall "$PKG" 2>/dev/null || true
"$ADB" install build/aligned.apk

echo "== 9. concede permissões de scan (Android 14) =="
"$ADB" shell pm grant "$PKG" android.permission.BLUETOOTH_SCAN || true
"$ADB" shell pm grant "$PKG" android.permission.BLUETOOTH_CONNECT || true

echo "== 10. abre o app =="
"$ADB" shell am start -n "$PKG/.MainActivity"
echo "OK — app rodando no TC22. Leia as tags com: adb logcat -s BTSCAN"
