#!/bin/bash
# 手工构建 WebView APK（aapt2 + javac + d8 + apksigner），不依赖 Gradle。
set -euo pipefail

SDK=${SDK:-/opt/android-sdk}
BT=$SDK/build-tools/34.0.0
JAR=$SDK/platforms/android-34/android.jar
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}
PATH=$JAVA_HOME/bin:$BT:$PATH

cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
source ./site.conf
: "${SITE_ORIGIN:?site.conf 缺少 SITE_ORIGIN}"
: "${SITE_BASE:?site.conf 缺少 SITE_BASE}"
KEY=$(cat "$ROOT/data/appkey")
KS=astock.keystore
KSPASS=astockjournal

rm -rf build
mkdir -p build/gen build/classes build/dex build/res build/src
python3 make_icons.py

# 源码是模板：复制到 build/src 后注入站点地址和 appkey，再整体编译
cp -r java/com build/src/
sed -i -e "s|__APP_KEY__|$KEY|g" \
    -e "s|__SITE_ORIGIN__|$SITE_ORIGIN|g" \
    -e "s|__SITE_BASE__|$SITE_BASE|g" \
    build/src/com/astock/journal/SiteConfig.java

aapt2 compile --dir res -o build/res.zip
aapt2 link -o build/app-unsigned.apk -I "$JAR" \
  --manifest AndroidManifest.xml -R build/res.zip --auto-add-overlay \
  --java build/gen --min-sdk-version 24 --target-sdk-version 34 \
  --version-code 7 --version-name 2.5

javac --release 17 -encoding UTF-8 -classpath "$JAR" -d build/classes \
  $(find build/src -name '*.java') build/gen/com/astock/journal/R.java
d8 --release --lib "$JAR" --output build/dex $(find build/classes -name '*.class')

cp build/app-unsigned.apk build/app.apk
python3 - <<EOF
import zipfile
with zipfile.ZipFile("build/app.apk", "a", zipfile.ZIP_DEFLATED) as z:
    z.write("build/dex/classes.dex", "classes.dex")
EOF

if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias astock -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KSPASS" -keypass "$KSPASS" \
    -dname "CN=A Stock Journal, OU=Personal, O=Personal, L=Shanghai, C=CN"
fi

zipalign -f -p 4 build/app.apk build/app-aligned.apk
apksigner sign --ks "$KS" --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
  --out build/astock.apk build/app-aligned.apk
apksigner verify --print-certs build/astock.apk | head -6

mkdir -p "$ROOT/static/app"
cp build/astock.apk "$ROOT/static/app/astock.apk"
ls -lh "$ROOT/static/app/astock.apk"
echo "OK: $ROOT/static/app/astock.apk"
