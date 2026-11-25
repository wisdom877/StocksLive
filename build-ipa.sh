#!/usr/bin/env bash
# 一条命令产出未签名 ipa（在 macOS + Xcode 15 上跑）
#   ./build-ipa.sh            # 默认 Release，未签名
# 产物：build/StocksLive-unsigned.ipa
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "缺 xcodegen：先跑  brew install xcodegen" >&2
  exit 1
fi
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "缺 Xcode：需要装 Xcode 15 并在 xcode-select -s 指向它" >&2
  exit 1
fi

xcodegen generate

rm -rf build
mkdir -p build

xcodebuild \
  -project StocksLive.xcodeproj \
  -scheme StocksLive \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -archivePath build/StocksLive.xcarchive \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  archive

APP="build/StocksLive.xcarchive/Products/Applications/StocksLive.app"
test -d "$APP"

rm -rf build/Payload
mkdir -p build/Payload
cp -R "$APP" build/Payload/
cd build
ditto -c -k --sequesterRsrc --keepParent Payload StocksLive-unsigned.ipa
cd ..

echo "✅ 产物：$(pwd)/build/StocksLive-unsigned.ipa"
echo "   自签：Sideloadly / AltStore / Xcode Devices 都可以；扩展会自动跟着签。"
