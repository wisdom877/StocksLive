# App/CarPlay · 待机页 CarPlay 接收端

这是待机第 7 页「CarPlay」的原生层。现在有三种角色，共用同一套接收/解码/音频/触控：

- **iPhone 本机模式**（`cmd:"start"`）：原来的同机 CarPlay，iPhone 自己既是配件又是接收端。
- **iPhone 远程主机**（`cmd:"startRemote"`）：iPhone 只跑虚拟配件探针，把 CarPlay 会话指向同一局域网的 iPad。
- **iPad 接收端**（`cmd:"startReceiver"`）：iPad 只跑 `CarPlayReceiver`，等 iPhone 连进来，负责显示/声音/触控。

远程主机的链路：iPhone 的 `SameDeviceProbe` 用 `expectsLocalControl=false`，在 `0x4300` 后向目标 iPad 的 IP/端口请求会话；视频、音频、触控仍由 iPad 本机的 `CarPlayReceiver`/`H264Surface` 处理，不需要自建 H.264 中继。

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

## 自动恢复与日志（2026-11-28 加）

画面存活不再由「8 秒没帧就拆」判定，会话存活也不再由「待机页是否打开」决定：

- **看门狗分级**（`CarPlayCoordinator.checkVideoHealth`）：1 秒心跳；`video` 状态下 3 秒无新帧写一行「画面 N 秒无新帧，等待对端补帧」（同一句 3 秒内不重复），**8 秒**仍无帧才 `requestRecovery("8 秒没有新画面")`。启动后 12 秒仍无画面直接重建。20 秒那版太钝：真断时人对着冻屏要等半分钟。
- **lost 宽限**：`RemoteStatusListener` 对端每 2 秒一包，**5 秒**无包即报 `lost`；`remoteHost` 再留 **6 秒**宽限（期间任何一包回来就取消），到点发 `recover`。
- **`recover` 指令（新）**：`RemoteControlPacket` 除 `stop` 外新增 `recover`。`stop` 仍是「iPhone 切回本机显示、iPad 下线」；`recover` 表示「会话已死、立刻重建」——iPad 侧 `startReceiver()` 本地 **0.4 秒**重启监听，iPhone 等 **1.6 秒**再发探针。以前靠网页退避 4 秒才重启（`sbCpRetryArm` 首档），白等近 4 秒。
- **日志**：`CarPlayLog` 环形 200 条 + 沙盒 512KB，`stop()` 时上报，另外会话期每 **5 分钟** `reason="periodic"` 补传一次（在 `beginRemote` / `beginReceiver` 等会话入口挂 `startLogFlush()`，`stop()` 里收掉）。iPhone 远程主机常年不断连，以前只在 stop 才写服务器，等于对端永远没有记录；现在两端都有。落盘见 `logs/carplay/`，接口 `POST /api/v1/diag/carplay`（走 `sk` cookie，内部还有 60 秒节流）。
- **前端契约**（`stock-site/static/app-standby.js`，改这里要同时看两端）：
  - `sbCpWant` 表示「用户这一轮想把车机连上」，不等于「待机页开着」；
  - iPhone 远程主机退出待机**不拆会话**：`sbClose()` 不发 `stop`、不清 `sbCpWant`、不清重试计数，只是收起待机页；
  - `sbCpRetryArm()` 不再要求 `s.on`（仅 iPad 接收端保留），另有 `sbCpBeat` **4 秒**兜底节拍：`want && auto && !cpClosing && 不在车机页 && 非 HD` 时触发重连；卡在 `starting/auth/ready/waiting` 超 15 秒（`page.dataset.cpat` 记进入时间）也当断了处理；退避前 8 次 3–10 秒、9–12 次 20 秒、之后 60 秒；
  - **端到端时间账**（改这些数之前先算一遍）：真断 ≈ 心跳 5 秒 + 宽限 6 秒 + iPad 重启 0.4 秒 + iPhone 等 1.6 秒 + 握手，**14 秒内**该出画面；iPad 侧硬断（控制连接关闭 / 视频通道关闭）走 `videoDidClose` 立即重建，不等看门狗。
  - iPad 接收端退出待机仍然直接拆：画面只存在于待机第 7 页，拆掉才是对的。

## 后台存活与自动重连（2026-11-28 21:00 加）

连着过一次之后，中途断了要靠两端原生自己拉回来，不等人打开 App：

- **进后台不再停会话**：`didEnterBackground` 原来对 iPad 接收端直接 `stop("已进入后台")`，现在两端都只记一行日志、保持会话，`isBackground = true`。
- **两端都借 audio 后台模式保活**：`syncCarPlayKeepAlive()` 的条件从「仅 remoteHost」扩到「remoteHost 或 receiver」，靠 `App/WebViewController.swift` 的静音循环（`standby.wav`，音量 0.01，mix 会话）让进程不在后台被挂起。否则定时器一停，心跳和重连都成摆设。
- **后台不解码**：`onVideo` 在后台只更新 `lastVideoAt` 就返回，不 `enqueue`；回前台 `requestKeyFrame("回前台补帧")` 补一帧。省掉 30fps 解码，后台才不至于把 iPad 烤热。
- **后台的存活判据换成控制连接**：`checkVideoHealth` 在后台不看「无帧」（本来就不渲染），只看 `controlConnected`，断了才 `requestRecovery("后台控制连接已断开")`。

**做不到的部分（iOS 硬限制，别当 bug 查）**：从 App 切换器把卡片划掉＝进程被终止，系统不给任何后台复活机会，两端都一样；iPad 退出待机页（`sbClose` 对 HD 仍拆）也还是会收会话，因为 CarPlay 画面只存在于待机页，没有容器可画。

依赖与风险：保活开关本体在 `App/WebViewController.swift`（非本目录），本席只改 `CarPlayCoordinator` 里的调用条件，该文件里「iPad 接收端不沿用」的注释待主流程/07 席同步；iPad 后台会长期挂一条几乎无声的循环，耗电略增；后台 `CNCopyCurrentNetworkInfo` 可能取不到 SSID，重建时靠 `lastSSID` 兜底，需出包真机验。

音频 `OSStatus -50`（每包一报、两端都能复现）本轮**没有改**：它牵涉 `AVAudioSession` 与壳的保活静音循环（`App/WebViewController.swift`，非本目录文件），需真机或台架验证后再动。

> 现状（2026-11-28 20:30 二轮提速）：Swift 侧改动在本地工作副本、**未提交、未进 0.0.5 包**；前端改动已于 19:21:22 随 0.0.5 补号的 `deploy2 all` 全量 static 上线（线上 md5 `23fd5447f59fc17477f19551f1f89734`（本轮新版 `0db89ac187336d5849493c334fdde052` 待上线），旧版 `a340658eb454c551f39f6176763c3518`），项目经理 19:48 已认定「前端跟随线上、不随包走」，故不做回滚。出包后先看两件事：日志里有没有「等待对端补帧」这行，以及是否出现 `reason=periodic` 的上报。

## 与上游的差异（维护时看这里）

1. `NativeReceiver` → `CarPlayReceiver`：删掉 CarLife、极核/九号/春风/台铃仪表、BMS、浏览器投屏、AirPlay 输出、诊断统计；只留 RTSP/配对/媒体/触控/关键帧。
2. `ReceiverConfiguration`：删掉所有外部输出字段，默认名改「黄杨工作台」、默认 1280×720@30。
3. `CarPlayAudio`：保留原文件；`BackgroundKeepAlive` 换成恒 false 的桩，避免前台应用做静音保活。
4. `AirPlayCredentials`：钥匙串不可用（免费签名常见 -34018）时退回进程内身份，保证本次运行能配对。
5. 新增 `CarPlayCoordinator` / `CarPlayStageView`：桥、几何、进出、状态回传。
6. `CarPlayInfo`：能力声明原样保留，只改显示名/型号字符串。

## 本机画面独占音频（2026-11-28 22:20 加）

本机模式（设置页「CarPlay 画面」= 本机，`role == .local`）音频由本机 CarPlay 会话输出。
壳里那条 0.01 音量静音循环（`standbyOn || carPlayKeepAlive`）会一直占 `AVAudioSession`，把它压掉。

- 原生侧：`syncCarPlayKeepAlive()` 本来就是 `active && (remoteHost || receiver)`，本机不挂保活。
- 网页侧：`sbCpLocalOn()` 启动 `startLocal` 前调 `sbCpAudioYield(true)`——若待机保活原为开，发壳已有的 `{cmd:"standby", on:false}` 临时关掉；会话收尾（`idle/failed` 且 `sbCpWant()` 为假）、或切到 iPad/接收端时 `sbCpAudioYield(false)` 按原状态还回去。
- 边界：`sbCpAudioYield` 读的是 `app-base.js` 的全局 `state.wkStandby`（经典脚本共享全局词法作用域），不改 `app-work.js`；若该字段改名会静默失效（整体包在 try 里，不会报错）。本机模式不再依赖静音循环，切后台会话会被系统挂起属预期。

## 连接信息可改（2026-11-28 21:20 加）

以前只有长按 Hello 弹出的连接 sheet 能填 SSID / 密码 / iPad 地址·端口，连过一次就没入口改。
现在「CarPlay 设置」多一张「连接信息」卡：

- 字段：Wi-Fi（SSID）、密码、iPad 地址、端口；iPad 接收端只显示前两项（`sbCpHd()` 为真时隐藏地址端口）。
- 保存：前端 `cmd: "cpLink"` → 原生 `CarPlayCoordinator` 的 `cpLink` 分支，SSID 写 `UserDefaults(carplaySSID)`、密码写钥匙串 `WiFiCredentials.save`、地址端口同时覆盖 `remoteTarget`；密码留空表示沿用钥匙串里的旧密码。
- 读取：打开设置页发 `cpLinkInfo`，原生回 `state: "link"` + `ssid/host/port`，前端只填显示、不覆盖用户正在输入的内容。
- 清除：`cpLinkClear` 清 SSID、钥匙串与 `remoteTarget`，前端同步清 `cpSSID/cpHost/cpPort`；不清 `sbCpWant`，正在跑的会话不会因此被叫停。
- 生效点：下次 `sbCarPlayStartNow` / 自动重连读 `localStorage` 的 `cpHost/cpPort`，SSID 走原生 `lastSSID`，所以改完不用重装也不用重走连接 sheet。
- 版本边界：0.0.6 及以前的包没有 `cpLink` 分支，前端保存后只有地址端口（localStorage）生效，SSID / 密码要等带这三个 case 的包（0.0.7 起）才真正写进钥匙串。

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
