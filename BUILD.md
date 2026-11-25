# StocksLive：纯 Swift 壳 + Live Activity（一条命令出未签名 ipa）

和上一版 Capacitor 方案的区别：**没有 npm、没有 CocoaPods、没有 SPM 依赖**，两个 target、五个 Swift 文件，XcodeGen 生成工程，构建脚本直接吐 ipa。远程构建（GitHub Actions macOS）也能跑。

## 一、本机一条命令（有 Mac）

```bash
brew install xcodegen           # 只装一次
open .                          # 先改 bundle id，见下
./build-ipa.sh
# 产物：build/StocksLive-unsigned.ipa
```

**签名前必须改 bundle id**：`project.yml` 里两处

```yaml
PRODUCT_BUNDLE_IDENTIFIER: com.example.stocks              # App
PRODUCT_BUNDLE_IDENTIFIER: com.example.stocks.DndLiveWidget # 扩展，必须是 App id + 后缀
```

改成你证书/描述文件里那个 App ID。扩展的 id 不能和 App 相同，也不能缺这一段，否则自签后锁屏卡片不出现。

## 二、云端构建（没有 Mac 时）

仓库推到 GitHub → Actions → `build-unsigned-ipa` → Run workflow，跑完在 Artifacts 里下 `StocksLive-unsigned-ipa`。macos-14 runner 自带 Xcode 15，`brew install xcodegen` 约 20 秒，整条流水线 3–5 分钟。

## 三、自签

ipa 里是**未签名**的 `Payload/StocksLive.app`，两种常见做法：

- **Sideloadly / AltStore**：拖 ipa 进去，Apple ID 或 p12 + mobileprovision 签，注意勾选「注入扩展/所有嵌套包」；免费 Apple ID 签出来 7 天有效，开发者证书 1 年。
- **Xcode**：新建一个空 App 工程 → Window → Devices and Simulators → 把 ipa 解压出的 `.app` 拖进去（或用 `ios-deploy`），用你的 Team 重签；扩展会一并签。

真机首次运行要去「设置 → 通用 → VPN 与设备管理」信任证书。

## 四、代码结构

| 文件 | 作用 |
|---|---|
| `App/AppDelegate.swift` | 起一个 window + WKWebView 控制器 |
| `App/WebViewController.swift` | 加载 `http://106.53.132.252/stocks/`；文档开始前注入 `window.Capacitor.Plugins.DndLive` shim（网页代码零改动）；收 WK 消息起停 Activity |
| `Shared/DndActivityAttributes.swift` | ActivityKit 属性（endAt / title / subtitle / kind），两个 target 共用 |
| `Widget/DndLiveWidget.swift` | 锁屏卡片 + 灵动岛三形态，`Text(timerInterval:)` 系统自己走秒 |
| `build-ipa.sh` | xcodegen + xcodebuild archive + 打 Payload |

换站点地址改 `WebViewController.swift` 里的 `homeURL`，同时在 `App/Info.plist` 的 `NSExceptionDomains` 加对应域名（站点是 HTTP，必须留 ATS 例外，否则白屏）。

## 五、验收

- 打开工作页 → 熄屏 → 锁屏出现倒计时，秒数每秒走
- 息屏 5 分钟再亮，秒数仍然准（系统在走，不是 App 在算）
- 灵动岛机型紧凑态显示分钟数，展开有标题副标题
- 杀掉 App，卡片仍走完并在到点 5 分钟后消失
- 任务完成/改时间，回 App 后卡片跟着变或消失

## 六、已知边界

- Live Activity 只能前台 start/update；后台靠系统按 endAt 走（这正是要的效果）。
- iOS 16.1+，灵动岛要 iPhone 14 Pro 及以上。
- 站点 HTTP + ATS 例外，上架审核可能被问；自签/TestFlight 不影响。
- 免费 Apple ID 签名 7 天过期，需重签。

## 七、为什么这里没有现成 ipa

构建 ipa 必须有 Xcode 和 iOS SDK（只能在 macOS 上跑）。当前这台是 Linux 云主机，没有 Swift/Xcode 工具链，所以这里给的是「一条命令就能出 ipa」的完整工程 + 云端流水线，而不是产物本身。真要产物，走第二节的 Actions，或把工程拷到任意一台 Mac 上跑 `./build-ipa.sh`。
