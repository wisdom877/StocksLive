// SPDX-License-Identifier: AGPL-3.0-only
// 待机页 CarPlay 的宿主：负责几何、进出、Wi-Fi 凭据、状态回传与生命周期。
// 接收端本身来自 CarWithin（AGPL-3.0-only），见 App/CarPlay/README.md。
import UIKit
import WebKit

final class CarPlayStageView: UIView {
    let surface = H264Surface()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
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

/// 只在前台使用：进入待机第 7 页才启动，离开页面 / 进后台 / 锁屏即停止。
final class CarPlayCoordinator: NSObject {
    private weak var host: UIViewController?
    private weak var webView: WKWebView?
    private let receiver = CarPlayReceiver()
    private let probe = SameDeviceProbe()
    private let stage = CarPlayStageView()
    private let ssidReader = WiFiSSIDReader()
    private let closeButton = UIButton(type: .system)
    private var active = false
    private var resolvingSSID = false
    private var displayedVideo = false
    private var flip = false
    private var orientationObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    private var lastSSID: String?
    var onIdleAudio: (() -> Void)?

    private static let ssidKey = "carplaySSID"

    init(host: UIViewController, webView: WKWebView) {
        self.host = host
        self.webView = webView
        super.init()
        lastSSID = UserDefaults.standard.string(forKey: Self.ssidKey)
        configureStage()
        orientationObserver = NotificationCenter.default.addObserver(forName: UIDevice.orientationDidChangeNotification,
            object: nil, queue: .main) { [weak self] _ in self?.relayout() }
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in self?.stop(reason: "已进入后台，CarPlay 已停止") }
    }

    deinit {
        if let orientationObserver { NotificationCenter.default.removeObserver(orientationObserver) }
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
        probe.stop(); receiver.stop()
    }

    // MARK: - 桥

    func handle(_ body: [String: Any]) {
        switch body["cmd"] as? String {
        case "start":
            let ssid = (body["ssid"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let password = body["password"] as? String
            start(ssid: ssid, password: password)
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
        default:
            break
        }
    }

    // MARK: - 启动 / 停止

    private func start(ssid: String?, password: String?) {
        guard !active, !resolvingSSID else { return }
        if let ssid, !ssid.isEmpty {
            begin(ssid: ssid, password: password ?? "")
            return
        }
        if let saved = lastSSID {
            let stored = (try? WiFiCredentials.password(for: saved)) ?? nil
            begin(ssid: saved, password: stored ?? "")
            return
        }
        resolvingSSID = true
        push(state: "starting", message: "正在读取当前 Wi-Fi…")
        ssidReader.currentSSID { [weak self] name in
            guard let self, self.resolvingSSID else { return }
            self.resolvingSSID = false
            guard !self.active else { return }
            self.requestCredentials(ssid: name)
        }
    }

    // 凭据交给网页里的弹层输入，不再用系统 Alert；网页负责键盘与主题。
    private func requestCredentials(ssid: String?) {
        let name = (ssid ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let note = name.isEmpty ? "未读到当前 Wi-Fi，请手动填写" : "已识别当前 Wi-Fi，输入密码即可"
        let hasWiFi = ReceiverConfiguration.wifiIPv4Address() != nil
        push(state: "credentials", message: note, extra: ["ssid": name, "wifi": hasWiFi])
    }

    private func begin(ssid: String, password: String) {
        guard let host else { return }
        guard let address = ReceiverConfiguration.wifiIPv4Address() else {
            push(state: "failed", message: "请先连接 Wi-Fi；CarPlay 需要一个本机局域网地址。")
            return
        }
        guard let identity = try? AccessoryIdentityStore.loadFromBundle() else {
            push(state: "failed", message: "配件身份缺失：请确认 App/CarPlay/Identity 已随包打入")
            return
        }
        let deviceID = ReceiverConfiguration.persistentDeviceID()
        var config = ReceiverConfiguration(address: address, ssid: ssid, password: password,
                                           width: 1280, height: 720, maxFPS: 30, videoCodec: .h264,
                                           audioEnabled: true, widthPhysicalMM: 200,
                                           oemIconPNG: nil, oemIconLabel: "黄杨工作台", deviceID: deviceID)
        do { try config.validate() } catch {
            push(state: "failed", message: error.localizedDescription)
            return
        }

        UserDefaults.standard.set(ssid, forKey: Self.ssidKey)
        lastSSID = ssid
        try? WiFiCredentials.save(password, for: ssid)

        active = true
        displayedVideo = false
        stage.surface.reset()
        stage.isHidden = true
        closeButton.isHidden = true
        host.view.addSubview(stage)
        host.view.addSubview(closeButton)
        relayout()
        push(state: "starting", message: "正在创建本机配件端点…")

        receiver.onLog = { [weak self] line in self?.log(line) }
        receiver.onFailure = { [weak self] message in
            self?.stop(reason: message, state: "failed")
        }
        receiver.onControlConnected = { [weak self] in
            self?.push(state: "ready", message: "已连接，正在协商画面…")
            self?.probe.didConnectControl()
        }
        receiver.onVideo = { [weak self] data, codec in
            guard let self, self.active else { return }
            do {
                try self.stage.surface.enqueue(accessUnit: data, codec: codec)
                if !self.displayedVideo {
                    self.displayedVideo = true
                    self.stage.isHidden = false
                    self.closeButton.isHidden = false
                    self.push(state: "video", message: "CarPlay 画面已就绪")
                }
            } catch {
                self.log("视频显示失败：\(error.localizedDescription)")
            }
        }
        stage.surface.onLog = { [weak self] in self?.log($0) }
        stage.surface.onKeyframeNeeded = { [weak self] reason in self?.receiver.requestKeyFrame(reason: reason) }
        stage.surface.onTouches = { [weak self] points in self?.receiver.touches(source: "local", points) }

        probe.onLog = { [weak self] line in self?.log(line) }
        probe.onStage = { [weak self] message in
            self?.push(state: "auth", message: message)
        }
        probe.onFinished = { [weak self] message in
            self?.stop(reason: message, state: "failed")
        }

        receiver.onListening = { [weak self] port in
            guard let self, self.active else { return }
            var live = config; live.port = port
            self.probe.start(configuration: live, identity: identity)
        }
        receiver.start(configuration: config, identity: identity)
    }

    private func stop(reason: String?, state: String = "idle") {
        guard active || !stage.isHidden || resolvingSSID else { return }
        resolvingSSID = false
        active = false
        displayedVideo = false
        probe.stop()
        receiver.stop()
        stage.surface.reset()
        stage.removeFromSuperview()
        closeButton.removeFromSuperview()
        onIdleAudio?()
        push(state: state, message: reason ?? "CarPlay 已停止")
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
        guard active, let host else { return }
        let bounds = host.view.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        let short = min(bounds.width, bounds.height)
        var height = short
        var width = short * 16 / 9
        if width > max(bounds.width, bounds.height) {
            width = max(bounds.width, bounds.height)
            height = width * 9 / 16
        }
        let rotation: CGFloat
        switch host.view.window?.windowScene?.interfaceOrientation {
        case .portrait, .portraitUpsideDown: rotation = .pi / 2
        default: rotation = flip ? .pi : 0
        }
        stage.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        stage.center = CGPoint(x: bounds.midX, y: bounds.midY)
        stage.transform = CGAffineTransform(rotationAngle: rotation)

        let inset = host.view.safeAreaInsets
        // 和左上返回键对称：叉号放在 CarPlay 圆角界面之外的右侧留白，右 16、上 10
        let side: CGFloat = 16
        let top: CGFloat = 10
        closeButton.frame = CGRect(x: bounds.maxX - inset.right - side - 38,
                                   y: inset.top + top,
                                   width: 38, height: 38)
    }

    // MARK: - 状态回传

    private func log(_ line: String) {
        NSLog("[CarPlay] %@", line)
        // 日志不逐条推到网页，避免连接过程里刷屏；只看最后一条错误。
    }

    private func push(state: String, message: String, extra: [String: Any] = [:]) {
        guard let webView else { return }
        var payload = extra
        payload["state"] = state
        payload["msg"] = message
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.wkCarPlayState && window.wkCarPlayState(\(json));"
        DispatchQueue.main.async { webView.evaluateJavaScript(js, completionHandler: nil) }
    }
}
