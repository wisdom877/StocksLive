# App/CarPlay · 待机页 CarPlay 接收端

这是待机第 7 页「CarPlay」的原生层。它让同一台 iPhone 把自己当作无线 CarPlay 配件：
系统把 CarPlay 画面/声音推给本 App，本 App 解码后显示在待机页，触控原路回传。

上游：[xmz28/CarWithin](https://github.com/xmz28/CarWithin)（1.0.5，AGPL-3.0-only）。
本目录是**裁剪移植**，不是子模块，也不跟随上游自动更新。

## 目录

```
App/CarPlay/
├── CarPlay-Bridging-Header.h      # ObjC/C 桥接入口
├── CarPlayCoordinator.swift       # 桥、几何、启停、状态回传、生命周期
├── Protocol/                      # 与 UI 无关的 CarPlay/AirPlay 协议栈
│   ├── IAP2 / MFiSAP / PairSetup / Pairing / RTSP
│   ├── ScreenStream / AudioStream / VideoCodec / AnnexB / OPACK
│   ├── AccessoryIdentity / AccessoryMessages / Binary / BLEFrame / Localization
│   ├── Crypto/                    # AES-CTR C shim（被桥接头引用）
│   └── Vendor/BigInt/             # MIT，SRP 需要
├── Receiver/
│   ├── DirectAccessoryTransport.h/.m  # CoreAccessories 私有端点
│   ├── SameDeviceProbe.swift          # iAP2 会话状态机
│   ├── CarPlayReceiver.swift          # 精简后的 RTSP/配对/媒体接收
│   ├── CarPlayMediaSession.swift      # 媒体 TCP、解密、HID
│   ├── CarPlayAudio.swift             # 音频输出 + Opus/AAC 解码
│   ├── H264Surface.swift              # AVSampleBufferDisplayLayer
│   ├── CarPlayInfo.swift              # 能力声明 / HID 描述符
│   ├── MediaSockets.swift             # TCP/UDP 时隙
│   ├── AirPlayCredentials.swift       # 接收端 pairing 身份 + Wi-Fi 密码
│   ├── AccessoryIdentityStore.swift   # 读包内 MFi 身份
│   ├── ReceiverConfiguration.swift    # 只保留本机需要的配置
│   └── BackgroundKeepAlive.swift      # 本项目不做后台保活，恒 false
├── Identity/                      # certificate.p7b / leaf.cer / private.x963（不进 git）
└── Licenses/                      # AGPL / GPL / 第三方声明
```

## 数据流

```
待机第 7 页点「启动」
  → JS 发 {cmd:"start"} 给 wkCarPlay
  → Coordinator 读 Wi-Fi 地址 + 包内身份
  → CarPlayReceiver 起 RTSP 监听
  → SameDeviceProbe 建虚拟配件端点，走 iAP2 认证/识别/0x4300
  → 请求 CarPlay 会话（SSID/密码/端口）
  → iPhone 回连 RTSP → Pair-Setup / Pair-Verify → 加密媒体
  → H.264 送入 H264Surface；触控归一化后回 HID
```

画面几何：待机舞台 852×393，CarPlay 按 16:9 取 699×393 居中，左右各 76.5 留黑。
原生图层按舞台方向旋转（横屏 0°/180°，竖屏 90°），触控坐标因此不用二次换算。

## 与上游的差异（维护时看这里）

1. `NativeReceiver` → `CarPlayReceiver`：删掉 CarLife、极核/九号/春风/台铃仪表、BMS、浏览器投屏、AirPlay 输出、诊断统计；只留 RTSP/配对/媒体/触控/关键帧。
2. `ReceiverConfiguration`：删掉所有外部输出字段，默认名改「黄杨工作台」、默认 1280×720@30。
3. `CarPlayAudio`：保留原文件；`BackgroundKeepAlive` 换成恒 false 的桩，避免前台应用做静音保活。
4. `AirPlayCredentials`：钥匙串不可用（免费签名常见 -34018）时退回进程内身份，保证本次运行能配对。
5. 新增 `CarPlayCoordinator` / `CarPlayStageView`：桥、几何、进出、状态回传。
6. `CarPlayInfo`：能力声明原样保留，只改显示名/型号字符串。

## Wi-Fi

首次启动会先尝试读系统当前 Wi-Fi：`Access WiFi Information` 能力 + 「使用期间」定位授权都在时，只弹密码框；缺任一项就退回手填 SSID/密码。密码存钥匙串，SSID 存 UserDefaults。

## Identity（重要）

`Identity/` 里是 Apple 签发的 MFi 配件证书与私钥，**不属于开源许可**：

- 不入库（`.gitignore`），CI 通过 `CARPLAY_CERT_B64 / CARPLAY_LEAF_B64 / CARPLAY_KEY_B64` 注入；
- 随 ipa 一起分发，等于把这套身份交给拿到 ipa 的人；
- 不要把这个 ipa 放到公开静态目录，也不要提交到公开仓库。

## 维护

- 上游协议改动时，按上面的差异表逐文件替换，别整体覆盖。
- `Protocol/` 与 `Receiver/` 里的 SPDX 头必须保留；修改过的文件在提交说明里注明。
- 私有 API（`CoreAccessories`）随 iOS 版本可能失效；失败时页面会停在「启动失败」，不会影响其它待机页。

许可：本目录整体按 AGPL-3.0-only 使用；`Vendor/BigInt` 为 MIT；`CarPlayInfo`/`Pairing` 等文件含 GPL-3.0-or-later 来源，详见 `Licenses/`。
