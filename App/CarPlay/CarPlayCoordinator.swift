// SPDX-License-Identifier: AGPL-3.0-only
// 待机页 CarPlay 的宿主：负责几何、进出、Wi-Fi 凭据、状态回传与生命周期。
// 接收端本身来自 CarWithin（AGPL-3.0-only），见 App/CarPlay/README.md。
import UIKit
import WebKit

final class CarPlayStageView: UIView {
    let surface = H264Surface()
    /// 网页设置按钮所在的一小块区域不接收车机触控，让点击落到下面的 WKWebView。
    var passthroughRect: CGRect = .null

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if passthroughRect.contains(point) { return nil }
        return super.hitTest(point, with: event)
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        // 卡片底也留空：黑边一旦露出来就和待机页其它卡片对不上，透出网页背景才是一张卡。
        backgroundColor = .clear
        layer.cornerRadius = 26
        layer.cornerCurve = .continuous
        clipsToBounds = true
        surface.frame = bounds
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(surface)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        surface.frame = bounds
    }
}

/// iPhone 投到 iPad 时要允许退到后台：远程主机只跑虚拟配件探针，
/// 前台画面在 iPad 上，iPhone 的会话要靠静音音频保活继续维持。
/// 本机显示和 iPad 接收端仍按前台使用，进后台即停止。
final class CarPlayCoordinator: NSObject {
    private enum Role {
        case local
        case remoteHost
        case receiver
    }

    private weak var host: UIViewController?
    private weak var webView: WKWebView?
    private let receiver = CarPlayReceiver()
    private let probe = SameDeviceProbe()
    private let stage = CarPlayStageView()
    private let heartRail = HeartRateRailView()
    private let ssidReader = WiFiSSIDReader()
    private let closeButton = UIButton(type: .system)
    private var role: Role = .local
    private var remoteTarget: (host: String, port: UInt16)?
    private var remoteTargetName = "iPad"
    private var remoteStatusListener: RemoteStatusListener?
    private var remoteStatusBeacon: RemoteStatusBeacon?
    private var remoteControlListener: RemoteControlListener?
    private var localStallRetries = 0
    private var remoteLostWork: DispatchWorkItem?
    /// iPad 接收端 watchdog 会重启监听，iPhone 的 iAP2 探针不会自动再发
    /// requestSession；如果只看到 listening/waiting，必须由这一侧重新起探针，
    /// 否则就会永远停在「等 iPad 确认」而只能长按。
    private var remoteWaitWork: DispatchWorkItem?
    private var lastHealthyRemoteStatus = ""
    private var foregroundObserver: NSObjectProtocol?
    private var lastRemoteStatus = ""
    private var active = false
    private var resolvingSSID = false
    private var displayedVideo = false
    private var controlConnected = false
    private var railAllowed = false
    /// 网页可以整条关掉右侧心率栏：出画面时右侧只留画面，不再挂心率胶囊。
    private var railShow = true
    private var covered = false
    private var flip = false
    /// 原生画面在屏幕正中时的位置：拖动时只改 center.x，旋转矩阵保持不动。
    private var stageRestCenter = CGPoint.zero
    private var stageGrab = false
    private var stageSettling = false
    private var stageDragOffset: CGFloat = 0
    private var laidOutVideoSize = CGSize.zero
    private var touchVideoSize = CGSize.zero
    private var orientationObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    private var heartObserver: NSObjectProtocol?
    private var lastSSID: String?
    private var videoHealthTimer: Timer?
    private var lastVideoAt: CFTimeInterval = 0
    private var videoStartAt: CFTimeInterval = 0
    private var lastRecoveryAt: CFTimeInterval = 0
    private var recoveryCount = 0
    private var recovering = false
    var onIdleAudio: (() -> Void)?

    private static let ssidKey = "carplaySSID"

    init(host: UIViewController, webView: WKWebView) {
        self.host = host
        self.webView = webView
        super.init()
        lastSSID = UserDefaults.standard.string(forKey: Self.ssidKey)
        heartRail.horizontal = host.traitCollection.userInterfaceIdiom == .pad
        configureStage()
        heartRail.onAvailabilityChanged = { [weak self] _ in
            self?.syncHeartRailVisibility(animated: true)
        }
        orientationObserver = NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification,
            object: nil, queue: .main) { [weak self] _ in self?.relayout() }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            if self.active, self.role == .remoteHost {
                self.log("App 进入后台：远程主机保持连接")
                return
            }
            self.stop(reason: "已进入后台，CarPlay 已停止")
        }
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification,
            object: nil, queue: .main) { [weak self] _ in self?.didEnterForeground() }
        heartObserver = NotificationCenter.default.addObserver(forName: HeartRateCenter.didUpdate,
            object: nil, queue: .main) { [weak self] _ in self?.heartRail.refresh() }
    }

    deinit {
        if let orientationObserver { NotificationCenter.default.removeObserver(orientationObserver) }
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
        if let heartObserver { NotificationCenter.default.removeObserver(heartObserver) }
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        probe.stop(); receiver.stop()
    }

    // MARK: - 桥

    func handle(_ body: [String: Any]) {
        switch body["cmd"] as? String {
        case "start":
            // 原来的同机 CarPlay，保留给 iPhone 本机显示；网页默认会走 startRemote。
            role = .local
            syncCarPlayKeepAlive()
            saveReceiverConfig(body)
            recovering = false; recoveryCount = 0; lastRecoveryAt = 0
            localStallRetries = 0
            let ssid = (body["ssid"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let password = body["password"] as? String
            push(state: "starting", message: "正在准备本机 CarPlay…")
            start(ssid: ssid, password: password)
        case "startLocal":
            // 从「投到 iPad」切回「本机显示」：先让 iPad 关掉接收端，再等 iOS
            // 放下旧的控制连接，最后才起本机探针。否则本机会一直卡在等待 TCP。
            role = .local
            syncCarPlayKeepAlive()
            saveReceiverConfig(body)
            recovering = false; recoveryCount = 0; lastRecoveryAt = 0
            localStallRetries = 0
            let ssid = (body["ssid"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let password = body["password"] as? String
            let peer = remoteTarget?.host
            if let peer { RemoteControlSender.send("stop", host: peer) }
            let needsWait = active || resolvingSSID || peer != nil
            if active || resolvingSSID { stop(reason: "正在切换到本机显示…", keepRecovery: false) }
            push(state: "starting", message: "正在切换到本机 CarPlay…")
            let launch = { [weak self] in
                guard let self, !self.active else { return }
                self.start(ssid: ssid, password: password)
            }
            if needsWait {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6, execute: launch)
            } else {
                launch()
            }
        case "startRemote":
            // iPhone 只做虚拟配件探针，目标指向同一局域网内的 iPad。
            role = .remoteHost
            syncCarPlayKeepAlive()
            saveReceiverConfig(body)
            remoteTarget = parseRemoteTarget(body)
            if let name = body["targetName"] as? String, !name.isEmpty { remoteTargetName = name }
            recovering = false; recoveryCount = 0; lastRecoveryAt = 0
            let ssid = (body["ssid"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let password = body["password"] as? String
            push(state: "starting", message: "正在准备远程 CarPlay…")
            startRemote(ssid: ssid, password: password)
        case "startReceiver":
            // iPad 只做接收端，不启动本机探针。
            role = .receiver
            syncCarPlayKeepAlive()
            saveReceiverConfig(body)
            recovering = false; recoveryCount = 0; lastRecoveryAt = 0
            push(state: "starting", message: "正在准备 iPad 接收端…")
            startReceiver()
        case "config":
            saveReceiverConfig(body)
        case "restart":
            // 画面参数只能在会话建立前生效：停掉当前会话，再用新配置重新握手。
            restartCurrent()
        case "stop":
            stop(reason: nil)
        case "forget":
            if let ssid = lastSSID { try? WiFiCredentials.forget(ssid) }
            UserDefaults.standard.removeObject(forKey: Self.ssidKey)
            lastSSID = nil
            push(state: "credentials", message: "已清除旧凭据，输入要连接的 Wi-Fi", extra: ["ssid": ""])
        case "wifiSettings":
            openWiFiSettings()
        case "geometry":
            flip = (body["flip"] as? Int ?? (body["flip"] as? Bool == true ? 1 : 0)) != 0
            relayout()
        case "chrome":
            // 待机页左上角已经有返回/关闭键，原生右上角那颗叉永远不再出现，避免两颗叉重复，
            // 也避免打开设置、重排、出画面时它被任何一条路径重新显示出来。
            closeButton.isHidden = true
        case "rail":
            // 网页说不要右侧心率栏就整条收掉；以后想放回来发 show:1 即可。
            railShow = (body["show"] as? Int ?? 1) != 0
            syncHeartRailVisibility(animated: true)
        case "hr":
            // 网页里的心率（服务端 / 蓝牙 / 快捷指令）同步进原生中心，
            // 让 CarPlay 底部胶囊和网页健康卡片读同一份最新样本。
            let bpm = (body["bpm"] as? Int) ?? Int((body["bpm"] as? Double) ?? 0)
            guard (25...240).contains(bpm) else { break }
            let rawAt = (body["at"] as? Double) ?? Double(body["at"] as? Int ?? 0)
            let seconds = rawAt > 1_000_000_000_000 ? rawAt / 1000 : rawAt
            let date = seconds > 0 ? Date(timeIntervalSince1970: seconds) : Date()
            HeartRateCenter.shared.ingest(bpm, at: date)
        case "overlay":
            // 网页要压一层整屏设置：先把原生视频层与心率栏收走，关掉设置再放回来。
            covered = (body["covered"] as? Int ?? 0) != 0
            if !covered {
                stageDragOffset = 0
                stage.center = stageRestCenter
            }
            stage.isHidden = covered || !displayedVideo
            closeButton.isHidden = true
            syncHeartRailVisibility(animated: covered)
            relayout()
        case "stageGrab":
            // 手指刚落下：原生画面立刻转为跟手，后面按网页给的位移逐帧跟随。
            guard displayedVideo else { break }
            stageGrab = true
            stageSettling = false
            stageDragOffset = CGFloat(body["x"] as? Double ?? 0)
            stage.isHidden = false
            stage.center = CGPoint(x: stageRestCenter.x + stageDragOffset, y: stageRestCenter.y)
        case "stageMove":
            guard stageGrab else { break }
            stageDragOffset = CGFloat(body["x"] as? Double ?? 0)
            stage.center = CGPoint(x: stageRestCenter.x + stageDragOffset, y: stageRestCenter.y)
        case "stageSettle":
            // 松手：用和网页翻页同一条曲线补完剩下的距离，滑出后自己收起，不再瞬间消失。
            guard stageGrab else { break }
            stageGrab = false
            stageSettling = true
            let target = CGFloat(body["x"] as? Double ?? 0)
            let out = (body["out"] as? Int ?? 0) != 0
            let dur = max(0.15, min(0.42, Double(body["dur"] as? Double ?? 240) / 1000))
            stageDragOffset = target
            UIView.animate(withDuration: dur, delay: 0, options: [.curveEaseOut]) {
                self.stage.center = CGPoint(x: self.stageRestCenter.x + target, y: self.stageRestCenter.y)
            } completion: { _ in
                self.covered = out
                self.stageSettling = false
                self.stageDragOffset = 0
                self.stage.isHidden = out
                self.stage.center = self.stageRestCenter
                self.syncHeartRailVisibility(animated: out)
            }
        default:
            break
        }
    }

    // MARK: - 启动 / 停止

    /// CarPlay 显示参数跟网页设置页保持一致；这里不信任任意值，落盘前先做范围校验。
    private func saveReceiverConfig(_ body: [String: Any]) {
        let defaults = UserDefaults.standard
        if let w = body["width"] as? Int, (320...3840).contains(w), w % 2 == 0,
           let h = body["height"] as? Int, (320...3840).contains(h), h % 2 == 0 {
            defaults.set(w, forKey: "cpWidth")
            defaults.set(h, forKey: "cpHeight")
        }
        if let fps = body["maxFPS"] as? Int, (30...60).contains(fps), fps % 5 == 0 {
            defaults.set(fps, forKey: "cpFPS")
        }
        if let codec = body["codec"] as? String, ["h264", "h265"].contains(codec) {
            defaults.set(codec, forKey: "cpCodec")
        }
        if let audio = body["audio"] as? Int {
            defaults.set(audio != 0, forKey: "cpAudio")
        } else if let audio = body["audio"] as? Bool {
            defaults.set(audio, forKey: "cpAudio")
        }
    }

    private func savedInt(_ key: String, _ fallback: Int) -> Int {
        let v = UserDefaults.standard.integer(forKey: key)
        return v > 0 ? v : fallback
    }

    private func start(ssid: String?, password: String?) {
        if active {
            push(state: "starting", message: "正在重启本机 CarPlay…")
            stop(reason: nil, keepRecovery: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.start(ssid: ssid, password: password)
            }
            return
        }
        if resolvingSSID {
            push(state: "starting", message: "正在读取当前 Wi-Fi…")
            return
        }
        if !recovering { recoveryCount = 0; lastRecoveryAt = 0 }
        if let ssid, !ssid.isEmpty {
            begin(ssid: ssid, password: password ?? "")
            return
        }
        if let saved = lastSSID, saved != "CarPlay" {
            let stored = (try? WiFiCredentials.password(for: saved)) ?? nil
            begin(ssid: saved, password: stored ?? "")
            return
        }
        // 本机 CarPlay 需要真实 Wi-Fi 名称/密码；读 SSID 在部分系统会卡住，
        // 没保存过就直接弹输入层，别让「本机」永远停在启动中。
        requestCredentials(ssid: nil)
    }

    // 凭据交给网页里的弹层输入，不再用系统 Alert；网页负责键盘与主题。
    private func requestCredentials(ssid: String?) {
        let name = (ssid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let note = name.isEmpty ? "未读到当前 Wi-Fi，请手动填写" : "已识别当前 Wi-Fi，输入密码即可"
        let hasWiFi = ReceiverConfiguration.wifiIPv4Address() != nil
        push(state: "credentials", message: note, extra: ["ssid": name, "wifi": hasWiFi])
    }

    // MARK: - 角色
    //
    // local：原来的同机 CarPlay，iPhone 自己既是配件又是接收端。
    // remoteHost：iPhone 只跑虚拟配件探针，把 CarPlay 会话指向同一局域网的 iPad。
    // receiver：iPad 只跑接收端，等 iPhone 连进来。
    //
    // 三条链路共用同一个 CarPlayReceiver / H264Surface，视频、音频、触控不重写。

    private var roleName: String {
        switch role {
        case .local: return "local"
        case .remoteHost: return "host"
        case .receiver: return "receiver"
        }
    }

    private func makeConfiguration(address: String, ssid: String, password: String,
                                   port: UInt16, name: String) -> ReceiverConfiguration {
        let deviceID = ReceiverConfiguration.persistentDeviceID()
        // 分辨率 / 帧率 / 编码 / 音频来自设置页；没有设置过就保持原来的 1280×720@30 H.264。
        var width = savedInt("cpWidth", 1280)
        var height = savedInt("cpHeight", 720)
        if !(320...3840).contains(width) || width % 2 != 0 { width = 1280 }
        if !(320...3840).contains(height) || height % 2 != 0 { height = 720 }
        let fps = savedInt("cpFPS", 30)
        let codec = UserDefaults.standard.string(forKey: "cpCodec") == "h265" ? VideoCodec.h265 : .h264
        let audio = UserDefaults.standard.object(forKey: "cpAudio") == nil
            ? true : UserDefaults.standard.bool(forKey: "cpAudio")
        var config = ReceiverConfiguration(address: address, ssid: ssid, password: password,
                                           width: width, height: height,
                                           maxFPS: (30...60).contains(fps) ? fps : 30,
                                           videoCodec: codec,
                                           audioEnabled: audio, widthPhysicalMM: 200,
                                           oemIconPNG: nil, oemIconLabel: "黄杨工作台",
                                           deviceID: deviceID)
        config.port = port
        config.name = name
        return config
    }

    private func parseRemoteTarget(_ body: [String: Any]) -> (host: String, port: UInt16)? {
        let rawHost = (body["target"] as? String) ?? (body["host"] as? String)
        guard let rawHost else { return nil }
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { return nil }
        let rawPort = body["port"] as? Int ?? 7000
        guard (1...65535).contains(rawPort) else { return nil }
        return (host: host, port: UInt16(rawPort))
    }

    private func startRemote(ssid: String?, password: String?) {
        // 网页/自动重试再发一次 start 时，不能因为 native 里 active 还是 true 就静默丢掉。
        // 先收掉旧会话，再按同一条远程链路重新握手；只多花 0.4 秒，不会卡在“正在启动”。
        if active {
            push(state: "starting", message: "正在重启 CarPlay 会话…")
            stop(reason: nil, keepRecovery: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.startRemote(ssid: ssid, password: password)
            }
            return
        }
        // Wi-Fi SSID 读取在部分系统上会长期不回调；远程主机启动不能被它卡死。
        // 上一次读取还没回来就作废旧请求，直接按已有 SSID 或占位名启动。
        if resolvingSSID {
            resolvingSSID = false
            log("丢弃未完成的 Wi-Fi SSID 读取")
        }
        guard let target = remoteTarget else {
            push(state: "failed", message: "请先填写 iPad 的局域网地址。")
            return
        }
        if !recovering { recoveryCount = 0; lastRecoveryAt = 0 }
        if let ssid, !ssid.isEmpty {
            beginRemote(target: target, ssid: ssid, password: password ?? "",
                        persistCredentials: ssid != "CarPlay")
            return
        }
        if let saved = lastSSID, saved != "CarPlay" {
            let stored = (try? WiFiCredentials.password(for: saved)) ?? nil
            beginRemote(target: target, ssid: saved, password: stored ?? "")
            return
        }
        // 远程链路真正需要的是 iPad 的 IP:7000；SSID/密码只用于配件描述。
        // 没有历史凭据时不再弹“读取 Wi-Fi”，先用 CarPlay 占位把探针发出去。
        beginRemote(target: target, ssid: "CarPlay", password: "", persistCredentials: false)
    }

    private func startReceiver() {
        if active {
            push(state: "starting", message: "正在重启 iPad 接收端…")
            stop(reason: nil, keepRecovery: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
                self?.startReceiver()
            }
            return
        }
        if resolvingSSID { return }
        if !recovering { recoveryCount = 0; lastRecoveryAt = 0 }
        beginReceiver()
    }

    private func restartCurrent(resetRecovery: Bool = true) {
        if resetRecovery { recovering = false; recoveryCount = 0; lastRecoveryAt = 0 }
        let ssid = lastSSID
        var password: String? = nil
        if let ssid, let saved = try? WiFiCredentials.password(for: ssid) { password = saved }
        let target = remoteTarget
        let oldRole = role
        stop(reason: nil, keepRecovery: !resetRecovery)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            switch oldRole {
            case .local:
                self.start(ssid: ssid, password: password)
            case .remoteHost:
                self.remoteTarget = target
                self.role = .remoteHost
                self.startRemote(ssid: ssid, password: password)
            case .receiver:
                self.role = .receiver
                self.startReceiver()
            }
        }
    }

    private func syncCarPlayKeepAlive() {
        // 只有 iPhone → iPad 的远程主机需要后台存活；本机显示和 iPad 接收端
        // 都依赖屏幕/前台，退后台本来就该停。
        (host as? WebViewController)?.setCarPlayKeepAlive(active && role == .remoteHost)
    }

    private func beginRemote(target: (host: String, port: UInt16), ssid: String, password: String,
                             persistCredentials: Bool = true) {
        guard let address = ReceiverConfiguration.wifiIPv4Address() else {
            push(state: "failed", message: "请先连接 Wi-Fi；iPhone 需要一个局域网地址。")
            return
        }
        guard let identity = try? AccessoryIdentityStore.loadFromBundle() else {
            push(state: "failed", message: "配件身份缺失：请确认 App/CarPlay/Identity 已随包打入")
            return
        }
        let config = makeConfiguration(address: target.host, ssid: ssid, password: password,
                                       port: target.port, name: remoteTargetName)
        do { try config.validateRemoteTarget() } catch {
            push(state: "failed", message: error.localizedDescription)
            return
        }
        _ = address   // 只用来确认本机确实在局域网上；目标地址来自网页。
        lastRemoteStatus = ""
        lastHealthyRemoteStatus = ""
        // 先让探针起来：状态回执监听是锦上添花，绝不能挡在真实 CarPlay 握手前面。
        // 以前这里先起 UDP listener，任何监听初始化异常/权限弹层都可能把启动流程卡在
        // 「正在启动」而探针根本没发出去；现在把它挪到 probe.start 之后。
        remoteStatusListener?.stop()
        remoteStatusListener = nil
        // 占位名只用于让探针先发出去，不能写进本机 CarPlay 的凭据；
        // 否则之后切「本机显示」会拿 “CarPlay / 空密码” 去请求，iOS 连不上。
        if persistCredentials, !ssid.isEmpty {
            UserDefaults.standard.set(ssid, forKey: Self.ssidKey)
            lastSSID = ssid
            try? WiFiCredentials.save(password, for: ssid)
        }

        active = true
        syncCarPlayKeepAlive()
        displayedVideo = false
        controlConnected = false
        covered = false
        recovering = false
        lastVideoAt = CACurrentMediaTime()
        videoStartAt = lastVideoAt
        stage.surface.reset()
        stage.isHidden = true
        heartRail.isHidden = true
        closeButton.isHidden = true

        // 远程主机不显示本机画面；这里不把 stage 加进视图，避免黑色空窗盖住网页提示。
        push(state: "caps", message: "stage")
        push(state: "starting", message: "正在创建虚拟配件端点…", extra: ["target": target.host, "port": Int(target.port)])
        log("会话开始 role=remoteHost target=\(target.host):\(target.port)")

        probe.onLog = { [weak self] line in self?.log(line) }
        probe.onStage = { [weak self] message in
            self?.push(state: "auth", message: message)
        }
        probe.onFinished = { [weak self] message in
            self?.stop(reason: message, state: "failed")
        }
        // 先回等待态，再起探针：探针若同步失败会推 failed，不能被后面的 waiting 覆盖。
        push(state: "waiting",
             message: "已向 \(remoteTargetName)（\(target.host):\(target.port)）请求 CarPlay，等待 iPad 连接…",
             extra: ["target": target.host, "port": Int(target.port)])
        probe.start(configuration: config, identity: identity, expectsLocalControl: false)
        scheduleRemoteWaitRecovery(after: 18)

        // 探针已经发出后再挂 UDP 7001；即便监听失败，也只影响“iPhone 显示已连接”，
        // 不影响 iPad 的真实视频链路。
        let listener = RemoteStatusListener()
        listener.onState = { [weak self] state in self?.handleRemoteStatus(state) }
        do { try listener.start(port: RemoteStatusPacket.port) }
        catch { log("远程状态监听失败：\(error.localizedDescription)") }
        remoteStatusListener = listener
    }

    private func beginReceiver() {
        guard let host else { return }
        guard let address = ReceiverConfiguration.wifiIPv4Address() else {
            push(state: "failed", message: "请先连接 Wi-Fi；iPad 需要一个本机局域网地址。")
            return
        }
        guard let identity = try? AccessoryIdentityStore.loadFromBundle() else {
            push(state: "failed", message: "配件身份缺失：请确认 App/CarPlay/Identity 已随包打入")
            return
        }
        let ssid = lastSSID ?? "CarPlay"
        let password = (try? WiFiCredentials.password(for: ssid)) ?? ""
        let config = makeConfiguration(address: address, ssid: ssid, password: password,
                                       port: 7000, name: "黄杨工作台")
        do { try config.validateReceiver() } catch {
            push(state: "failed", message: error.localizedDescription)
            return
        }

        active = true
        syncCarPlayKeepAlive()
        displayedVideo = false
        controlConnected = false
        covered = false
        railShow = true
        recovering = false
        lastVideoAt = CACurrentMediaTime()
        videoStartAt = lastVideoAt
        stage.surface.frameRate = Double(config.maxFPS)
        stage.surface.reset()
        stage.isHidden = true
        heartRail.isHidden = true
        closeButton.isHidden = true
        host.view.addSubview(stage)
        host.view.addSubview(heartRail)
        host.view.addSubview(closeButton)
        relayout()
        push(state: "caps", message: "stage")
        push(state: "starting", message: "正在启动 iPad 接收端…")
        log("会话开始 role=receiver 监听端口 7000")

        receiver.onLog = { [weak self] line in self?.log(line) }
        receiver.onFailure = { [weak self] message in
            self?.stop(reason: message, state: "failed")
        }
        receiver.onControlConnected = { [weak self] peer in
            guard let self else { return }
            self.controlConnected = true
            self.videoStartAt = CACurrentMediaTime()
            self.push(state: "ready", message: "iPhone 已连接，正在协商画面…")
            if let peer, !peer.isEmpty {
                self.remoteStatusBeacon?.stop()
                let beacon = RemoteStatusBeacon()
                beacon.start(peer: peer, state: "connected")
                self.remoteStatusBeacon = beacon
            }
        }
        receiver.onVideoClosed = { [weak self] in self?.videoDidClose("视频通道已关闭") }
        receiver.onVideoStalled = { [weak self] reason in self?.videoDidClose(reason) }
        receiver.onVideo = { [weak self] data, codec in
            guard let self, self.active else { return }
            do {
                try self.stage.surface.enqueue(accessUnit: data, codec: codec)
                self.lastVideoAt = CACurrentMediaTime()
                let pixels = self.stage.surface.pictureSize
                if pixels.width > 1, pixels.height > 1, pixels != self.touchVideoSize {
                    self.touchVideoSize = pixels
                    self.receiver.setDisplaySize(width: Int(pixels.width), height: Int(pixels.height))
                }
                if !self.displayedVideo {
                    self.displayedVideo = true
                    self.stage.isHidden = self.covered
                    self.closeButton.isHidden = true
                    self.heartRail.refresh()
                    self.relayout()
                    self.push(state: "video", message: "CarPlay 画面已就绪")
                    self.remoteStatusBeacon?.update("video")
                }
            } catch {
                self.log("视频显示失败：\(error.localizedDescription)")
                self.receiver.requestKeyFrame(reason: "视频显示失败")
            }
        }
        stage.surface.onLog = { [weak self] in self?.log($0) }
        stage.surface.onKeyframeNeeded = { [weak self] reason in self?.receiver.requestKeyFrame(reason: reason) }
        stage.surface.onTouches = { [weak self] points in self?.receiver.touches(source: "local", points) }

        receiver.onListening = { [weak self] port in
            guard let self, self.active else { return }
            self.push(state: "listening",
                      message: "等待 iPhone 连接 · \(address):\(port)",
                      extra: ["ip": address, "port": Int(port)])
        }
        receiver.start(configuration: config, identity: identity)
        startVideoHealthTimer()
    }

    private func begin(ssid: String, password: String) {
        role = .local
        guard let host else { return }
        guard let address = ReceiverConfiguration.wifiIPv4Address() else {
            push(state: "failed", message: "请先连接 Wi-Fi；CarPlay 需要一个本机局域网地址。")
            return
        }
        guard let identity = try? AccessoryIdentityStore.loadFromBundle() else {
            push(state: "failed", message: "配件身份缺失：请确认 App/CarPlay/Identity 已随包打入")
            return
        }
        let config = makeConfiguration(address: address, ssid: ssid, password: password,
                                       port: 7000, name: "黄杨工作台")
        do { try config.validate() } catch {
            push(state: "failed", message: error.localizedDescription)
            return
        }

        UserDefaults.standard.set(ssid, forKey: Self.ssidKey)
        lastSSID = ssid
        try? WiFiCredentials.save(password, for: ssid)

        active = true
        syncCarPlayKeepAlive()
        displayedVideo = false
        controlConnected = false
        covered = false
        railShow = true
        recovering = false
        lastVideoAt = CACurrentMediaTime()
        videoStartAt = lastVideoAt
        stage.surface.frameRate = Double(config.maxFPS)
        stage.surface.reset()
        stage.isHidden = true
        heartRail.isHidden = true
        closeButton.isHidden = true
        host.view.addSubview(stage)
        host.view.addSubview(heartRail)
        host.view.addSubview(closeButton)
        relayout()
        // 能力位：网页据此决定用「原生跟手滑出」还是退回一把收起的旧路径。
        // 旧壳不认识这三条消息，网页也就不能盲目依赖它们。
        push(state: "caps", message: "stage")
        push(state: "starting", message: "正在创建本机配件端点…")

        receiver.onLog = { [weak self] line in self?.log(line) }
        receiver.onFailure = { [weak self] message in
            self?.stop(reason: message, state: "failed")
        }
        receiver.onControlConnected = { [weak self] _ in
            self?.controlConnected = true
            self?.localStallRetries = 0
            self?.videoStartAt = CACurrentMediaTime()
            self?.push(state: "ready", message: "已连接，正在协商画面…")
            self?.probe.didConnectControl()
        }
        receiver.onVideoClosed = { [weak self] in self?.videoDidClose("视频通道已关闭") }
        receiver.onVideoStalled = { [weak self] reason in self?.videoDidClose(reason) }
        receiver.onVideo = { [weak self] data, codec in
            guard let self, self.active else { return }
            do {
                try self.stage.surface.enqueue(accessUnit: data, codec: codec)
                self.lastVideoAt = CACurrentMediaTime()
                if !self.displayedVideo {
                    self.displayedVideo = true
                    self.stage.isHidden = self.covered
                    self.closeButton.isHidden = true
                    self.heartRail.refresh()
                    self.relayout()
                    self.push(state: "video", message: "CarPlay 画面已就绪")
                }
            } catch {
                self.log("视频显示失败：\(error.localizedDescription)")
                self.receiver.requestKeyFrame(reason: "视频显示失败")
            }
        }
        stage.surface.onLog = { [weak self] in self?.log($0) }
        stage.surface.onKeyframeNeeded = { [weak self] reason in self?.receiver.requestKeyFrame(reason: reason) }
        stage.surface.onTouches = { [weak self] points in self?.receiver.touches(source: "local", points) }

        probe.onLog = { [weak self] line in self?.log(line) }
        probe.onStage = { [weak self] message in
            guard let self else { return }
            self.push(state: "auth", message: message)
            if message.contains("等待 TCP 连接") {
                // 从远端切回本机时，iOS 偶尔还握着旧会话；本机探针发出请求后
                // 迟迟没有 TCP 回来，就整段重来一次，逼 iOS 放下旧控制连接。
                DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
                    guard let self, self.active, self.role == .local,
                          !self.controlConnected, self.localStallRetries < 2 else { return }
                    self.localStallRetries += 1
                    self.log("本机 TCP 未建立，重启本机会话（第 \(self.localStallRetries) 次）")
                    self.restartCurrent(resetRecovery: false)
                }
            }
        }
        probe.onFinished = { [weak self] message in
            self?.stop(reason: message, state: "failed")
        }

        receiver.onListening = { [weak self] port in
            guard let self, self.active else { return }
            var live = config; live.port = port
            self.probe.start(configuration: live, identity: identity)
        }
        // iPad 接收端额外监听 iPhone 的切换指令：iPhone 改回本机显示时，
        // 先让 iPad 主动收掉控制/媒体连接，iOS 才会放下远端会话。
        remoteControlListener?.stop()
        let control = RemoteControlListener()
        control.onCommand = { [weak self] command in
            guard let self else { return }
            if command == "stop" {
                self.stop(reason: "iPhone 已切换到本机显示")
            }
        }
        do { try control.start(port: RemoteControlPacket.port) }
        catch { log("切换指令监听失败：\(error.localizedDescription)") }
        remoteControlListener = control
        receiver.start(configuration: config, identity: identity)
        startVideoHealthTimer()
    }

    private func stop(reason: String?, state: String = "idle", keepRecovery: Bool = false) {
        guard active || !stage.isHidden || resolvingSSID else { return }
        // 收会话前先把这一轮日志发出去：断开之后再发就没上下文了。
        CarPlayLog.shared.upload(webView: webView, reason: "stop:\(reason ?? "-")")
        resolvingSSID = false
        active = false
        syncCarPlayKeepAlive()
        remoteLostWork?.cancel(); remoteLostWork = nil
        remoteWaitWork?.cancel(); remoteWaitWork = nil
        displayedVideo = false
        controlConnected = false
        covered = false
        if !keepRecovery { recovering = false }
        videoHealthTimer?.invalidate(); videoHealthTimer = nil
        remoteStatusBeacon?.update("disconnected")
        remoteStatusBeacon?.stop(); remoteStatusBeacon = nil
        remoteStatusListener?.stop(); remoteStatusListener = nil
        remoteControlListener?.stop(); remoteControlListener = nil
        lastRemoteStatus = ""
        lastHealthyRemoteStatus = ""
        probe.stop()
        receiver.stop()
        stage.surface.reset()
        touchVideoSize = .zero
        laidOutVideoSize = .zero
        stage.removeFromSuperview()
        heartRail.isHidden = true
        heartRail.removeFromSuperview()
        closeButton.removeFromSuperview()
        onIdleAudio?()
        push(state: state, message: reason ?? "CarPlay 已停止")
    }

    // A frozen last frame is indistinguishable from a healthy paused picture at the
    // UI layer. Keep a cheap 1s heartbeat and restart the whole receiver only after
    // 8s without a decoded frame, so a Wi-Fi or keyframe stall cannot stay forever.
    private func startVideoHealthTimer() {
        videoHealthTimer?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.checkVideoHealth() }
        RunLoop.main.add(timer, forMode: .common)
        videoHealthTimer = timer
    }

    private func checkVideoHealth() {
        guard active, !covered, !recovering else { return }
        // 接收端还在等 iPhone 连入时没有控制连接，不能按“20 秒没画面”去重连，
        // 否则会每 20 秒重启一次监听，永远等不到第一台手机。
        guard role != .remoteHost, controlConnected || displayedVideo else { return }
        let now = CACurrentMediaTime()
        if displayedVideo {
            // 第一帧的像素尺寸往往比画面晚到几毫秒，这里按尺寸变化补一次布局，
            // 让卡片从 16:9 直接收成画面本身的比例，不留黑边。
            let pixels = stage.surface.pictureSize
            if pixels != laidOutVideoSize, pixels != .zero {
                laidOutVideoSize = pixels
                relayout()
                if role == .receiver, pixels != touchVideoSize {
                    touchVideoSize = pixels
                    receiver.setDisplaySize(width: Int(pixels.width), height: Int(pixels.height))
                }
            }
            // 每秒一行运行状态：既是验收口径，也替代必须连 Xcode 看 Console 的现状。
            push(state: "stats", message: stage.surface.statsLine())
            guard now - lastVideoAt > 8 else { return }
            requestRecovery("8 秒没有新画面")
        } else if now - videoStartAt > 20 {
            requestRecovery("启动后 20 秒没有画面")
        }
    }

    private func videoDidClose(_ reason: String) {
        guard active else { return }
        log("CarPlay 画面中断：\(reason)")
        requestRecovery(reason)
    }

    private func requestRecovery(_ reason: String) {
        guard active, !recovering else { return }
        // 远程主机没有本机画面，不能走“画面中断就重连”的接收端 watchdog。
        guard role != .remoteHost else { return }
        let now = CACurrentMediaTime()
        if now - lastRecoveryAt > 60 { recoveryCount = 0 }
        guard recoveryCount < 3 else {
            stop(reason: "CarPlay 连续中断，请检查 Wi-Fi 后重试", state: "failed")
            return
        }
        recoveryCount += 1
        lastRecoveryAt = now
        recovering = true
        log("正在自动重连 CarPlay（第 \(recoveryCount) 次）：\(reason)")
        stop(reason: "画面中断，正在重连", state: "starting", keepRecovery: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self, !self.active, self.recovering else { return }
            self.restartCurrent(resetRecovery: false)
        }
    }

    private func openWiFiSettings() {
        guard let url = URL(string: "App-Prefs:root=WIFI") else { return }
        UIApplication.shared.open(url, options: [:]) { ok in
            guard !ok, let fallback = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(fallback, options: [:], completionHandler: nil)
        }
    }

    // MARK: - 布局

    private func configureStage() {
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        closeButton.layer.cornerRadius = 19
        closeButton.layer.cornerCurve = .continuous
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        closeButton.accessibilityLabel = "停止 CarPlay"
        closeButton.isHidden = true
    }

    @objc private func closeTapped() { stop(reason: "已停止 CarPlay") }

    func relayout() {
        // 远程主机没有本机舞台；不要在一张没加进视图的 stage 上量坐标。
        guard active, let host, stage.superview != nil else { return }
        let bounds = host.view.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        let short = min(bounds.width, bounds.height)
        // 卡片跟着真实画面宽高比走：16:9 只是没拿到像素尺寸之前的默认值。
        // 车机常见 19.5:9 / 21:9，硬塞进 16:9 就会在左右各留一条黑边。
        let pixels = stage.surface.pictureSize
        let aspectKnown = pixels.width > 1 && pixels.height > 1
        let aspect: CGFloat = aspectKnown ? pixels.width / pixels.height : 16.0 / 9.0
        // 卡片按真实比例排好后让画面直接铺满，免得涂层自己又等比内缩出细黑边。
        stage.surface.matchCard(aspectKnown: aspectKnown)
        var height = short
        var width = height * aspect
        if width > max(bounds.width, bounds.height) {
            width = max(bounds.width, bounds.height)
            height = width / aspect
        }
        let rotation: CGFloat
        switch host.view.window?.windowScene?.interfaceOrientation {
        case .portrait, .portraitUpsideDown: rotation = .pi / 2
        default: rotation = flip ? .pi : 0
        }
        stage.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        let rest = CGPoint(x: bounds.midX, y: bounds.midY)
        stageRestCenter = rest
        // 跟手 / 补完动画期间不要改 center，否则会把拖动或滑出动画拽回正中。
        if !stageGrab && !stageSettling { stage.center = rest }
        stage.transform = CGAffineTransform(rotationAngle: rotation)
        // iPhone 的设置键仍在左上角，需要一小块透传区；HD 的四颗键已经移到底部黑边，
        // 车机画面不再需要为它们让出触控，整块画面都可以直接操作车机。
        if host.traitCollection.userInterfaceIdiom == .pad {
            stage.passthroughRect = .null
        } else {
            stage.passthroughRect = stage.convert(CGRect(x: 8, y: 46, width: 56, height: 84), from: host.view)
        }

        let inset = host.view.safeAreaInsets
        if heartRail.horizontal {
            // HD：底部黑边里，四颗操作键靠在最左；余下整条空白都留给心率胶囊。
            // 左边距 24 + 四键总宽 242 + 12 的间隔，刚好和网页底部操作条的右缘对齐。
            let leftInset = max(inset.left, 24)
            let controlsWidth: CGFloat = 242
            let railLeft = leftInset + controlsWidth + 12
            let railRight = bounds.width - max(inset.right, 24)
            let railHeight: CGFloat = 42
            let railBottom = bounds.maxY - 8
            let railWidth = max(0, railRight - railLeft)
            heartRail.bounds = CGRect(x: 0, y: 0, width: railWidth, height: railHeight)
            heartRail.center = CGPoint(x: railLeft + railWidth / 2,
                                       y: railBottom - railHeight / 2)
            // 窄到放不下区间/走势时不要硬挤，宁可先收起来。
            railAllowed = railWidth >= 520
        } else {
            // iPhone：心率卡贴屏幕最右侧悬浮，像左边按钮一样留出边距；整张卡只在 CarPlay 舞台之外的黑边里。
            let stageFrame = stage.frame
            let safeRight = bounds.maxX - inset.right
            let bandWidth = max(0, safeRight - stageFrame.maxX)
            // 右侧黑边在 16:9 画面之外通常只有 120pt 左右：右边留 12、卡与画面之间留 6，
            // 卡宽就按这条带子实际可用宽度来收，不能再用固定 8pt 间隙把自己挤出画面外。
            let railSide: CGFloat = 12
            let railGap: CGFloat = 6
            let railWidth = min(112, max(76, bandWidth - railSide - railGap))
            let railTop = inset.top + 58          // 给右上角关闭键留出安全距离
            let railBottom = bounds.maxY - inset.bottom - 12
            let railHeight = min(228, max(180, railBottom - railTop))
            let railRight = safeRight - railSide
            let railCenterX = railRight - railWidth / 2
            heartRail.bounds = CGRect(x: 0, y: 0, width: railWidth, height: railHeight)
            heartRail.center = CGPoint(x: railCenterX, y: railTop + railHeight / 2)
            // 右侧带子真的太窄时才收起，避免压住 CarPlay 画面。
            railAllowed = (rotation == 0 || rotation == .pi)
                && (railCenterX - railWidth / 2) >= stageFrame.maxX + railGap - 1
        }
        // 翻转时内容跟着转 180°，但始终留在物理顶部/右侧。
        heartRail.transform = CGAffineTransform(rotationAngle: flip ? .pi : 0)
        syncHeartRailVisibility()

        // 和左上返回键对称：叉号放在 CarPlay 圆角界面之外的右侧留白，右 16、上 10
        let side: CGFloat = 16
        let top: CGFloat = 10
        closeButton.frame = CGRect(x: bounds.maxX - inset.right - side - 38,
                                   y: inset.top + top,
                                   width: 38, height: 38)
        // 重排是最容易被漏掉的一条路径：这里再钉死一次，原生叉不会因设置开关/旋转而复活。
        closeButton.isHidden = true
    }

    /// 没出画面、或不在横向留白里时收起。心率暂时为空也保留胶囊：
    /// 网页会把最新样本同步进来，先显示「—」比整条消失更像一个稳定的仪表。
    private func syncHeartRailVisibility(animated: Bool = false) {
        let visible = active && displayedVideo && railAllowed && railShow && !covered
        if visible {
            heartRail.isHidden = false
            if animated {
                heartRail.alpha = 0
                UIView.animate(withDuration: 0.22, delay: 0,
                               options: [.allowUserInteraction, .beginFromCurrentState]) {
                    self.heartRail.alpha = 1
                }
            } else {
                heartRail.alpha = 1
            }
        } else {
            if animated && !heartRail.isHidden {
                UIView.animate(withDuration: 0.18, delay: 0,
                               options: [.allowUserInteraction, .beginFromCurrentState]) {
                    self.heartRail.alpha = 0
                } completion: { _ in
                    self.heartRail.isHidden = true
                }
            } else {
                heartRail.isHidden = true
                heartRail.alpha = 1
            }
        }
    }

    // MARK: - 状态回传

    private func log(_ line: String) {
        NSLog("[CarPlay] %@", line)
        // 同时进诊断环形缓冲：真机出问题时，服务器 logs/carplay/ 才拿得到当时发生了什么。
        CarPlayLog.shared.record(line)
        // 日志不逐条推到网页，避免连接过程里刷屏；只看最后一条错误。
    }

    private func handleRemoteStatus(_ state: String) {
        guard role == .remoteHost, active else { return }
        let normalized = state.hasPrefix("lost") ? "lost" : state
        guard normalized != lastRemoteStatus else { return }
        let previous = lastRemoteStatus
        lastRemoteStatus = normalized
        switch normalized {
        case "connected":
            remoteLostWork?.cancel(); remoteLostWork = nil
            remoteWaitWork?.cancel(); remoteWaitWork = nil
            lastHealthyRemoteStatus = normalized
            push(state: "connected", message: "iPad 已连接，CarPlay 正在显示", extra: ["remote": 1])
        case "video":
            remoteLostWork?.cancel(); remoteLostWork = nil
            remoteWaitWork?.cancel(); remoteWaitWork = nil
            lastHealthyRemoteStatus = normalized
            push(state: "connected", message: "CarPlay 已连接 · iPad 正在显示", extra: ["remote": 1])
        case "disconnected":
            // iPad 是主动收掉接收端，不是 UDP 漏包；直接进入自动重连，
            // 不能停在 waiting，否则网页会清掉重试计时器，只能人工长按。
            lastHealthyRemoteStatus = ""
            push(state: "failed", message: "iPad 接收端已断开，正在自动重连", extra: ["remote": 1])
            scheduleRemoteWaitRecovery(after: 8)
        case "lost":
            if previous == "connected" || previous == "video" {
                // 心跳丢包但会话不一定断：先保持“已连接”，不清空网页的 Want，
                // 也不把状态降级成「等待 iPad 确认」；15 秒仍无包才重建。
                log("iPad 心跳短暂丢失，保持当前连接状态")
                push(state: "connected", message: "CarPlay 已连接 · iPad 正在显示（同步中）", extra: ["remote": 1])
                scheduleRemoteLostRecovery()
            } else {
                push(state: "waiting", message: "等待 iPad 确认连接…", extra: ["remote": 1])
            }
        case "listening", "starting", "auth", "ready", "waiting":
            // iPad 接收端重启后只会回 listening；iPhone 侧必须自己再发 requestSession，
            // 否则会一直停在“等 iPad 确认”，只能人工长按。
            scheduleRemoteWaitRecovery(after: 12)
        default:
            break
        }
    }

    private func didEnterForeground() {
        guard active, role == .remoteHost else { return }
        remoteStatusListener?.markFresh()
        // WKWebView 在后台可能收不到 evaluateJavaScript；回前台补一次当前状态，
        // 避免页面停在进入后台前的“正在启动/等待”。
        if !lastHealthyRemoteStatus.isEmpty {
            push(state: "connected", message: "CarPlay 已连接 · iPad 正在显示", extra: ["remote": 1])
        }
    }

    /// iPad 的接收端 watchdog 重启后，iPhone 侧主动重发 requestSession。
    /// 只在「还没连上/还没出画面」时生效，已连接状态由心跳和 15 秒 lost 负责。
    private func scheduleRemoteWaitRecovery(after delay: TimeInterval) {
        guard active, role == .remoteHost, !recovering else { return }
        remoteWaitWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active, self.role == .remoteHost, !self.recovering,
                  self.lastRemoteStatus != "connected", self.lastRemoteStatus != "video" else { return }
            self.log("iPad 接收端尚未确认会话，重发 CarPlay 请求")
            self.recovering = true
            self.stop(reason: "iPad 接收端重启，正在重新请求 CarPlay", state: "starting", keepRecovery: true)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                guard let self, !self.active, self.recovering else { return }
                let savedSSID = self.lastSSID == "CarPlay" ? nil : self.lastSSID
                var password: String? = nil
                if let savedSSID, let stored = try? WiFiCredentials.password(for: savedSSID) {
                    password = stored
                }
                self.startRemote(ssid: savedSSID, password: password)
            }
        }
        remoteWaitWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func scheduleRemoteLostRecovery() {
        remoteLostWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.active, self.role == .remoteHost,
                  self.lastRemoteStatus == "lost", !self.recovering else { return }
            self.log("iPad 心跳持续丢失，重建远程 CarPlay 会话")
            if let peer = self.remoteTarget?.host {
                RemoteControlSender.send("stop", host: peer)
            }
            self.recovering = true
            self.stop(reason: "iPad 状态中断，正在自动重连", state: "starting", keepRecovery: true)
            // iPad 收到 stop 后网页退避约 4 秒才重启接收端；等它重新 listen 再发探针，
            // 否则新探针会打在一个还没起来的端口上，又白等一轮。
            DispatchQueue.main.asyncAfter(deadline: .now() + 4.5) { [weak self] in
                guard let self, !self.active, self.recovering else { return }
                let savedSSID = self.lastSSID == "CarPlay" ? nil : self.lastSSID
                var password: String? = nil
                if let savedSSID, let stored = try? WiFiCredentials.password(for: savedSSID) {
                    password = stored
                }
                self.startRemote(ssid: savedSSID, password: password)
            }
        }
        remoteLostWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }

    private func push(state: String, message: String, extra: [String: Any] = [:]) {
        guard let webView else { return }
        // 每秒一行的 stats 不进诊断缓冲，否则 200 条环形会被读数刷满
        if state != "stats" {
            CarPlayLog.shared.record("state=\(state) role=\(roleName) msg=\(message)")
        }
        var payload = extra
        payload["state"] = state
        payload["msg"] = message
        payload["role"] = roleName
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.wkCarPlayState && window.wkCarPlayState(\(json));"
        DispatchQueue.main.async { webView.evaluateJavaScript(js, completionHandler: nil) }
    }
}
