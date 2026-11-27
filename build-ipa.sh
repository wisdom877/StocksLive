#!/usr/bin/env bash
# 一条命令产出未签名 ipa（在 macOS + Xcode 15 上跑）
#   ./build-ipa.sh                 # iPhone，默认 Release，未签名 → build/StocksLive-unsigned.ipa
#   ./build-ipa.sh StocksLiveHD    # iPad HD，独立 target → build/StocksLiveHD-unsigned.ipa
set -euo pipefail
cd "$(dirname "$0")"

SCHEME="${1:-StocksLive}"
PRODUCT="$SCHEME"
if [ "$SCHEME" = "StocksLiveHD" ]; then
  OUT="StocksLiveHD-unsigned"
else
  OUT="StocksLive-unsigned"
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "缺 xcodegen：先跑  brew install xcodegen" >&2
  exit 1
fi
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "缺 Xcode：需要装 Xcode 15 并在 xcode-select -s 指向它" >&2
  exit 1
fi

# CarPlay 配件身份：不入库。CI 用 secret 注入，本地直接用 App/CarPlay/Identity/ 里的文件。
IDENTITY_DIR="App/CarPlay/Identity"
mkdir -p "$IDENTITY_DIR"
decode_b64() { python3 -c 'import sys,base64,pathlib; pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode(sys.stdin.read().strip()))' "$1"; }
if [ -n "${CARPLAY_CERT_B64:-}" ]; then printf '%s' "$CARPLAY_CERT_B64" | decode_b64 "$IDENTITY_DIR/certificate.p7b"; fi
if [ -n "${CARPLAY_LEAF_B64:-}" ]; then printf '%s' "$CARPLAY_LEAF_B64" | decode_b64 "$IDENTITY_DIR/leaf.cer"; fi
if [ -n "${CARPLAY_KEY_B64:-}" ]; then printf '%s' "$CARPLAY_KEY_B64" | decode_b64 "$IDENTITY_DIR/private.x963"; fi
if [ ! -f "$IDENTITY_DIR/certificate.p7b" ] || [ ! -f "$IDENTITY_DIR/leaf.cer" ] || [ ! -f "$IDENTITY_DIR/private.x963" ]; then
  echo "⚠️  App/CarPlay/Identity 缺文件：能编译，但启动 CarPlay 会提示「配件身份缺失」。" >&2
fi

xcodegen generate

rm -rf "build/$SCHEME.xcarchive"
rm -rf build/Payload
rm -f "build/$OUT.ipa"
mkdir -p build

xcodebuild \
  -project StocksLive.xcodeproj \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -archivePath "build/$SCHEME.xcarchive" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  archive

APP="build/$SCHEME.xcarchive/Products/Applications/$PRODUCT.app"
test -d "$APP"

rm -rf build/Payload
mkdir -p build/Payload
cp -R "$APP" build/Payload/

# 手表上（锁屏卡的镜像、表盘列表）取图标走的是包根目录的传统尺寸 PNG + CFBundleIcons，
# Xcode 15 起默认只导出 60x60@2x 一个，手表拿不到就显示通用网格图标。
# 这里把 29 / 40 / 60 三档补到包根目录，并写进 Info.plist（Assets.car 原样保留，手机桌面不受影响）
BUNDLE="build/Payload/$PRODUCT.app"
ICONS="App/Assets.xcassets/AppIcon.appiconset"
for pair in \
  "icon-29-29@2x.png:AppIcon29x29@2x.png" \
  "icon-29-29@3x.png:AppIcon29x29@3x.png" \
  "icon-40-40@2x.png:AppIcon40x40@2x.png" \
  "icon-40-40@3x.png:AppIcon40x40@3x.png" \
  "icon-60-60@2x.png:AppIcon60x60@2x.png" \
  "icon-60-60@3x.png:AppIcon60x60@3x.png"; do
  cp -f "$ICONS/${pair%%:*}" "$BUNDLE/${pair##*:}"
done
PB=/usr/libexec/PlistBuddy
PLIST="$BUNDLE/Info.plist"
"$PB" -c "Add :CFBundleIcons dict" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleIcons:CFBundlePrimaryIcon dict" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconName string AppIcon" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles array" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:0 string AppIcon29x29" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:1 string AppIcon40x40" "$PLIST" 2>/dev/null || true
"$PB" -c "Add :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconFiles:2 string AppIcon60x60" "$PLIST" 2>/dev/null || true
echo "包内图标："; ls "$BUNDLE" | grep -i icon

cd build
ditto -c -k --sequesterRsrc --keepParent Payload "$OUT.ipa"
cd ..

echo "✅ 产物：$(pwd)/build/$OUT.ipa"
echo "   自签：Sideloadly / AltStore / Xcode Devices 都可以；扩展会自动跟着签。"
