import UIKit
import WebKit
import ActivityKit
import UserNotifications
import AVFoundation
import AudioToolbox

final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, AVAudioPlayerDelegate {
    /// 站点自己的域名：只有这些留在壳里，其余 http(s) 链接一律交给系统 Safari，否则跳出去就回不来
    private let ownHosts: Set<String> = ["api.wisdomhqq.top", "106.53.132.252"]

    private func isOwn(_ url: URL?) -> Bool {
        guard let url = url, let host = url.host?.lowercased() else { return false }
        return ownHosts.contains(host)
    }

    /// 用系统浏览器打开外链
    private func openExternal(_ url: URL?) {
        guard let url = url, let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        DispatchQueue.main.async { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
    }

    private var webView: WKWebView!
    // 优先走有证书的域名（HTTPS），证书有效，不会被 ATS 拦、也不吃运营商对 80 端口的限制
    private let homeURL = URL(string: "https://api.wisdomhqq.top/stocks/")!
    private let fallbackURL = URL(string: "http://106.53.132.252/stocks/")!
    private var triedFallback = false
    private var autoRetry = 0
    private var retryTask: DispatchWorkItem?
    private var pendingAlarmID: String?
    private var failedURL = URL(string: "https://api.wisdomhqq.top/stocks/")!

    /// 站点里的 dndLockSync() 只认 window.Capacitor.Plugins.DndLive；
    /// 这里在文档开始前塞一个同名 shim，把调用转成 WK 消息，网页代码一行不用改。
    private static let bridgeJS: String = """
    (function () {
      if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.dndLive) return;
      // 告诉网页这一版壳支持哪些能力，网页据此决定怎么响应铃，老壳自动降级
      window.wkNativeCap = { ring: 1, vibe: 1 };
      window.Capacitor = window.Capacitor || {};
      window.Capacitor.Plugins = window.Capacitor.Plugins || {};
      if (!navigator.vibrate) {
        navigator.vibrate = function () {
          try { window.webkit.messageHandlers.wkNative.postMessage({ cmd: "vibe" }); } catch (e) {}
          return true;
        };
      }
      window.Capacitor.Plugins.DndLive = {
        start: function (o) {
          try { window.webkit.messageHandlers.dndLive.postMessage(Object.assign({ cmd: "start" }, o || {})); } catch (e) {}
          return Promise.resolve({ id: "wk" });
        },
        update: function (o) {
          try { window.webkit.messageHandlers.dndLive.postMessage(Object.assign({ cmd: "update" }, o || {})); } catch (e) {}
        },
        end: function () {
          try { window.webkit.messageHandlers.dndLive.postMessage({ cmd: "end" }); } catch (e) {}
          return Promise.resolve();
        },
        isSupported: function () { return Promise.resolve({ supported: true }); }
      };
    })();
    """

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        pushSafeArea()
    }

    override func viewDidLoad() {
        // 启动时**不要**激活播放类会话：以前这里 .playback + .duckOthers + setActive(true)，
        // 一进 App 就把别的 App 的音乐压低且一直压着。平时用 ambient（不抢、不 duck），
        // 只有真要响铃的那一刻才临时切成 playback。
        idleAudioSession()

        NotificationCenter.default.addObserver(self, selector: #selector(enterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(enterForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()          // cookie / localStorage 全部持久化，登录一次就够
        conf.mediaTypesRequiringUserActionForPlayback = []   // 到点自动响铃，不用先点一下页面
        conf.allowsInlineMediaPlayback = true
        conf.userContentController.add(self, name: "dndLive")
        conf.userContentController.add(self, name: "wkNative")
        conf.userContentController.addUserScript(
            WKUserScript(source: Self.bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        conf.allowsInlineMediaPlayback = true

        webView = WKWebView(frame: view.bounds, configuration: conf)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.underPageBackgroundColor = .systemBackground
        view.addSubview(webView)
        HealthBridge.shared.attach(webView)
        addLoading()
        NotificationCenter.default.addObserver(self, selector: #selector(onActive),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
        load()
    }

    @objc private func onActive() {
        guard errorBox != nil else { return }
        autoRetry = 0
        triedFallback = false
        errorBox?.removeFromSuperview()
        errorBox = nil
        addLoading()
        load()
    }

    private func load() {
        failedURL = triedFallback ? fallbackURL : homeURL
        webView.load(URLRequest(url: failedURL))
    }

    // MARK: - 载入状态（黑屏时能看见原因，不用连 Xcode）

    private var loading: UIActivityIndicatorView?
    private var errorBox: UIView?

    private func addLoading() {
        let a = UIActivityIndicatorView(style: .medium)
        a.color = .label
        a.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(a)
        NSLayoutConstraint.activate([
            a.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            a.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        a.startAnimating()
        loading = a
    }

    private func showError(_ text: String) {
        loading?.stopAnimating()
        errorBox?.removeFromSuperview()

        let box = UIView()
        box.translatesAutoresizingMaskIntoConstraints = false
        box.backgroundColor = .secondarySystemBackground
        box.layer.cornerRadius = 12

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.numberOfLines = 0
        label.textColor = .label
        label.font = .systemFont(ofSize: 13)
        label.text = "页面没加载出来\n\n" + text

        let btn = UIButton(type: .system)
        btn.translatesAutoresizingMaskIntoConstraints = false
        btn.setTitle("重试", for: .normal)
        btn.addTarget(self, action: #selector(retry), for: .touchUpInside)

        box.addSubview(label); box.addSubview(btn)
        view.addSubview(box)
        NSLayoutConstraint.activate([
            box.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            box.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            box.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.topAnchor.constraint(equalTo: box.topAnchor, constant: 14),
            label.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 14),
            label.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -14),
            btn.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 10),
            btn.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            btn.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -12)
        ])
        errorBox = box
    }

    @objc private func retry() {
        errorBox?.removeFromSuperview()
        errorBox = nil
        autoRetry = 0
        addLoading()
        load()
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate：外链不在壳里打开

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let scheme = url?.scheme?.lowercased() ?? ""
        // 非本站的 http(s)：整页跳转也交给 Safari，壳留在原页面（about:blank / blob / data 这类放行）
        if (scheme == "https" || scheme == "http") && !isOwn(url) {
            openExternal(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// target="_blank" / window.open 走这里；不返回新 webView，直接用 Safari 打开
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        openExternal(navigationAction.request.url)
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushSafeArea()
        pushPendingAlarm()
        autoRetry = 0
        loading?.stopAnimating()
        // 健康权限不在启动时问：没带 HealthKit 能力的签名会让 requestAuthorization 直接失败，
        // 放在用户主动点「开启健康数据」时再试，启动永远不受影响。
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError("错误 \((error as NSError).code)：\(error.localizedDescription)\n\(failedURL.absoluteString)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if !triedFallback {
            triedFallback = true
            load()
            return
        }
        // 冷启动网络没就绪很常见：静默重试 3 轮（1s / 2s / 4s），还不行才弹卡片
        if autoRetry < 3 {
            autoRetry += 1
            let delay = Double(1 << (autoRetry - 1))
            retryTask?.cancel()
            let task = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.triedFallback = false
                self.load()
            }
            retryTask = task
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: task)
            return
        }
        showError("连接失败 \((error as NSError).domain) \((error as NSError).code)\n\(error.localizedDescription)\n\(failedURL.absoluteString)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("WebView 进程被系统回收，点重试")
    }

    /// 状态栏跟着系统外观走：浅色用深字、深色用浅字（原来固定 .lightContent，浅色下顶部一片白却配白字）
    override var preferredStatusBarStyle: UIStatusBarStyle {
        traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
    }

    /// 系统切深浅色时，WebView 会把新的 prefers-color-scheme 传给页面；
    /// 这里顺手刷新状态栏和底色，保证壳和页面同时换。
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        guard previousTraitCollection?.userInterfaceStyle != traitCollection.userInterfaceStyle else { return }
        setNeedsStatusBarAppearanceUpdate()
        view.backgroundColor = .systemBackground
        webView?.backgroundColor = .systemBackground
        webView?.scrollView.backgroundColor = .systemBackground
    }

    /// 把原生安全区写进 CSS 变量：壳里 env(safe-area-inset-top) 有时取到 0，
    /// 顶栏就会钻到状态栏/灵动岛下面；--sat 是唯一可信的物理值
    private func pushSafeArea() {
        let top = max(0, view.safeAreaInsets.top)
        let bottom = max(0, view.safeAreaInsets.bottom)
        let js = "document.documentElement.style.setProperty('--sat','\(top)px');document.documentElement.style.setProperty('--sab','\(bottom)px');"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if message.name == "wkNative" { handleNative(message.body); return }
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        guard #available(iOS 16.1, *) else { return }

        switch cmd {
        case "start":
            let state = contentState(from: body)
            let attrs = DndActivityAttributes(
                title: body["title"] as? String ?? "倒计时",
                subtitle: body["subtitle"] as? String ?? "",
                kind: body["kind"] as? String ?? "task"
            )

            Task { @MainActor in
                for running in Activity<DndActivityAttributes>.activities {
                    await running.end(dismissalPolicy: .immediate)
                }
                if let act = try? Activity.request(attributes: attrs, contentState: state, pushType: nil) {
                    // 有截止时刻的：到点后再留 5 分钟由系统收走；行情类挂 8 小时
                    if let endAt = state.endAt {
                        await act.end(dismissalPolicy: .after(endAt.addingTimeInterval(300)))
                    } else {
                        await act.end(dismissalPolicy: .after(Date().addingTimeInterval(8 * 3600)))
                    }
                }
            }
        case "update":
            let state = contentState(from: body)
            let kind = body["kind"] as? String

            Task { @MainActor in
                for running in Activity<DndActivityAttributes>.activities {
                    if kind == nil || running.attributes.kind == kind {
                        await running.update(using: state)
                        break
                    }
                }
            }
        case "end":
            Task { @MainActor in
                for running in Activity<DndActivityAttributes>.activities {
                    await running.end(dismissalPolicy: .immediate)
                }
            }
        default:
            break
        }
    }

    /// 到点提醒：网页把任务清单整批推过来，这里同步成系统本地通知（带声音、时间敏感）
    private func handleNative(_ body: Any) {
        guard let dict = body as? [String: Any], let cmd = dict["cmd"] as? String else { return }
        let center = UNUserNotificationCenter.current()

        switch cmd {
        case "sync":
            let tasks = dict["tasks"] as? [[String: Any]] ?? []
            syncAlarms(tasks)
        case "health":
            HealthBridge.shared.start()
        case "awake":
            // 待机页右上角呼吸点涨到最大时打过来一次：打开/关掉系统的自动锁屏。
            // 网页侧拦不住 iOS 的自动暗屏，只有这里把 isIdleTimerDisabled 打开才真正常亮。
            let on = (dict["on"] as? Int) ?? ((dict["on"] as? Bool) == true ? 1 : 0)
            DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = (on != 0) }
        case "stop":
            if let id = dict["id"] as? String, !id.isEmpty {
                let full = "wk-" + id
                center.removePendingNotificationRequests(withIdentifiers: [full])
                center.removeDeliveredNotifications(withIdentifiers: [full])
            }
        case "standby":
            standbyOn = (dict["on"] as? Bool) ?? true
            syncStandbyPlayer()
            reportNativeState()
        case "vibe":
            if (dict["stop"] as? Bool) == true { return }
            vibrate()
        case "tone":
            playTone(loop: (dict["loop"] as? Bool) ?? false)
        case "ring":
            // 弹消息一条消息搞定：先震再响，网页不用发两次、也不会因为中间报错只响不震
            vibrate()
            playTone(loop: (dict["loop"] as? Bool) ?? false)
        case "ringStop":
            stopTone()
        case "open":
            // 网页主动请求打开外链（如 DeepSeek 充值页）
            if let raw = dict["url"] as? String, let u = URL(string: raw) { openExternal(u) }
        case "test":
            // 网页「试听」：除了壳内响铃，再排一条 8 秒后的系统通知，锁屏上能不能收到一试便知
            scheduleTestNotification(seconds: 8)
        case "openSettings":
            if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) }
        default:
            break
        }
    }

    /// 排到系统通知里的提醒。
    /// 原来每次同步都先把「wk-」开头的待发通知全部撤掉再重排：撤和排是异步的，
    /// 恰好跨在到点那一秒时，撤可能落在排之后，把马上要响的那条吃掉——这就是「偶尔到点不响」。
    /// 现在只撤「新清单里已经没有的」，清单里还在的原样覆盖（同一个 id 的 add 本身就是替换）。
    private var scheduledIDs: [String] = []

    private func syncAlarms(_ tasks: [[String: Any]]) {
        let center = UNUserNotificationCenter.current()
        var fresh: [(id: String, request: UNNotificationRequest)] = []
        for t in tasks {
            guard let when = t["when"] as? String,
                  let date = Self.localDate(when) else { continue }
            let rawID = (t["id"] as? String) ?? UUID().uuidString
            let content = UNMutableNotificationContent()
            content.title = (t["title"] as? String) ?? "到点提醒"
            content.body = (t["meta"] as? String) ?? (t["note"] as? String) ?? ""
            // 自带提示音（约 3 秒两拍，比系统"咚"更能听见）；找不到文件就走系统默认
            content.sound = Bundle.main.url(forResource: "alarm", withExtension: "wav") != nil
                ? UNNotificationSound(named: UNNotificationSoundName("alarm.wav"))
                : UNNotificationSound.default
            content.threadIdentifier = "wk-alarm"
            content.userInfo = ["id": rawID]
            if #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }

            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            let full = "wk-" + rawID
            fresh.append((full, UNNotificationRequest(identifier: full, content: content, trigger: trigger)))
        }
        let freshIDs = Set(fresh.map { $0.id })
        // 以前只删「本次进程排过的」id，进程一重启 scheduledIDs 就是空的：
        // 上次会话排进系统、这次清单里已经没有的提醒（任务删了 / 改期了 / 换了一天）会留在系统里，
        // 到点照样响，还占 iOS 的 64 条待发名额。这里直接按系统里的真实清单兜底清一遍。
        center.getPendingNotificationRequests { pending in
            let stale = pending.map { $0.identifier }
                .filter { $0.hasPrefix("wk-") && $0 != "wk-test" && !freshIDs.contains($0) }
            if !stale.isEmpty {
                center.removePendingNotificationRequests(withIdentifiers: stale)
                center.removeDeliveredNotifications(withIdentifiers: stale)
            }
            self.addAlarms(fresh, freshIDs)
        }
    }

    private func addAlarms(_ fresh: [(id: String, request: UNNotificationRequest)], _ freshIDs: Set<String>) {
        let center = UNUserNotificationCenter.current()
        nativeDiag.lastError = ""
        let group = DispatchGroup()
        for item in fresh {
            group.enter()
            center.add(item.request) { [weak self] error in
                if let error = error { self?.nativeDiag.lastError = "排入失败：\(error.localizedDescription)" }
                group.leave()
            }
        }
        scheduledIDs = Array(freshIDs)
        group.notify(queue: .main) { [weak self] in self?.reportNativeState() }
    }

    private func scheduleTestNotification(seconds: TimeInterval) {
        let content = UNMutableNotificationContent()
        content.title = "测试提醒"
        content.body = "这是 App 排进系统的通知，锁屏上能看到它，说明到点提醒走得通"
        content.sound = Bundle.main.url(forResource: "alarm", withExtension: "wav") != nil
            ? UNNotificationSound(named: UNNotificationSoundName("alarm.wav"))
            : UNNotificationSound.default
        content.threadIdentifier = "wk-alarm"
        if #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(seconds, 1), repeats: false)
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "wk-test", content: content, trigger: trigger)
        ) { [weak self] error in
            if let error = error { self?.nativeDiag.lastError = "测试通知排入失败：\(error.localizedDescription)" }
        }
    }

    private struct NativeDiag { var auth = ""; var pending = 0; var lastError = "" }
    private var nativeDiag = NativeDiag()

    /// 把真实状态回给页面：权限、已排进系统的条数、最近一次错误。
    /// 以前这里固定回 true，权限被拒 / 排入失败页面完全不知道，表现就是「到点没反应，也没任何提示」。
    private func reportNativeState() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { [weak self] settings in
            guard let self else { return }
            let raw = settings.authorizationStatus
            let auth: String
            switch raw {
            case .authorized, .provisional, .ephemeral: auth = "yes"
            case .denied: auth = "no"
            default: auth = "ask"
            }
            center.getPendingNotificationRequests { reqs in
                let pending = reqs.filter { $0.identifier.hasPrefix("wk-") && $0.identifier != "wk-test" }.count
                self.nativeDiag.auth = auth
                self.nativeDiag.pending = pending
                let js = "window.wkNativeState && window.wkNativeState(" + (auth == "yes" ? "true" : "false")
                    + ", true, " + (self.standbyOn ? "true" : "false")
                    + ", {auth:'" + auth + "',pending:" + String(pending)
                    + ",err:" + Self.jsString(self.nativeDiag.lastError) + "})"
                DispatchQueue.main.async { self.webView.evaluateJavaScript(js, completionHandler: nil) }
            }
        }
    }

    private static func jsString(_ s: String) -> String {
        // 把任意字符串转成一段合法的 JS 字符串字面量（带引号），错误信息里有引号 / 换行也不会把脚本弄坏
        guard let data = try? JSONSerialization.data(withJSONObject: [s]),
              let text = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(text.dropFirst().dropLast())
    }

    /// 页面传的是本地墙钟 "YYYY-MM-DD HH:MM"，按设备本地时区还原
    private static func localDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f.date(from: String(s.prefix(16)))
    }

    private var standbyOn = true
    private var tonePlayer: AVAudioPlayer?

    /// 铃声交给原生播：Web Audio 在壳里经常被挂起（静音、没手势），原生播放最可靠
    private func playTone(loop: Bool) {
        if loop, let p = tonePlayer, p.isPlaying { return }
        // 只在响铃这一刻抢会话并把别人的音乐压低；响完（见 audioPlayerDidFinishPlaying）立刻还给 ambient
        var diag = ""
        do { try duckAudioSession() }
        catch { diag += "sess:\(error.localizedDescription) " }

        guard let url = Bundle.main.url(forResource: "alarm", withExtension: "wav") else {
            reportTone("no-file"); return
        }
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            p.numberOfLoops = loop ? -1 : 0
            p.volume = 1.0
            p.delegate = self
            p.prepareToPlay()
            tonePlayer?.stop()
            let started = p.play()
            tonePlayer = p
            if started {
                reportTone(diag.isEmpty ? "ok" : "ok-\(diag)")
            } else {
                AudioServicesPlayAlertSound(1005)   // 兜底：系统提示音
                reportTone("play-false-\(diag)")
            }
        } catch {
            AudioServicesPlayAlertSound(1005)
            reportTone("player:\(error.localizedDescription)")
        }
    }

    private func reportTone(_ msg: String) {
        let js = "window.wkToneResult && window.wkToneResult(\"\(msg)\")"
        DispatchQueue.main.async { self.webView.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func stopTone() {
        tonePlayer?.stop()
        tonePlayer = nil
        restoreAudioAfterRing()
    }

    /// 铃声（非循环）自己播完了：把会话还回去，音乐音量立刻恢复
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard player === tonePlayer else { return }
        tonePlayer = nil
        restoreAudioAfterRing()
    }

    /// 响完收尾：后台保活还在跑就留在「playback + mix」，否则彻底退回 ambient 并解除激活
    private func restoreAudioAfterRing() {
        if standbyPlayer?.isPlaying == true {
            keepAliveAudioSession()
        } else {
            idleAudioSession()
        }
    }

    // MARK: - 音频会话

    /// 空闲态：ambient + mix，从不激活会话，绝不压低任何人的音乐
    private func idleAudioSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try? s.setActive(false, options: [.notifyOthersOnDeactivation])
    }

    /// 响铃态：用 ambient 而不是 playback —— 这样系统静音拨片一拨就真的不响，
    /// 只有非静音（响铃）时才出声；同时 mixWithOthers 不压低别人的音乐。
    /// 震动不受静音开关影响，静音时照样震，所以「非静音=震动+铃声」「静音=只震动」。
    private func duckAudioSession() throws {
        let s = AVAudioSession.sharedInstance()
        try s.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
        try s.setActive(true)
    }

    /// 弹消息的震动：先给一记明确的触感，再叠系统长震，比只调其中一个更容易被感知
    private func vibrate() {
        let gen = UINotificationFeedbackGenerator()
        gen.prepare()
        gen.notificationOccurred(.warning)
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
    }

    /// 后台保活态：playback 但要 mixWithOthers —— 静音循环必须和别人共存，不能 duck
    private func keepAliveAudioSession() {
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? s.setActive(true)
    }
    private var standbyPlayer: AVAudioPlayer?

    @objc private func enterBackground() { syncStandbyPlayer() }
    @objc private func enterForeground() {
        syncStandbyPlayer()
        reportNativeState()   // 回到前台把权限 / 已排条数刷新给页面
    }

    /// 后台时播一条静音循环（audio 后台模式）→ 锁屏时页面定时器还在跑，到点能自己响铃+震动
    private func syncStandbyPlayer() {
        guard standbyOn else {
            standbyPlayer?.stop(); standbyPlayer = nil
            restoreAudioAfterRing()          // 关掉保活也要把会话还回 ambient，别一直挂着
            return
        }
        let bg = UIApplication.shared.applicationState == .background
        if bg, standbyPlayer == nil, let url = Bundle.main.url(forResource: "standby", withExtension: "wav") {
            if let p = try? AVAudioPlayer(contentsOf: url) {
                // 保活音频用 mix 会话：既能在后台跑，又不会把正在听的歌压成蚊子声
                keepAliveAudioSession()
                p.numberOfLoops = -1
                p.volume = 0.01          // 几乎无声，只为保活
                p.play()
                standbyPlayer = p
            }
        } else if !bg {
            standbyPlayer?.stop(); standbyPlayer = nil
            restoreAudioAfterRing()
        }
    }

    /// 系统通知被点开：把提醒 id 交回网页（页面可能还没加载完，先存着，didFinish 再补发）
    func deliverAlarm(_ rawID: String) {
        pendingAlarmID = rawID
        pushPendingAlarm()
    }

    private func pushPendingAlarm() {
        guard let id = pendingAlarmID, webView != nil else { return }
        let js = "window.wkNativeAlarm && window.wkNativeAlarm(\"\(id)\")"
        webView.evaluateJavaScript(js) { [weak self] _, err in
            if err == nil { self?.pendingAlarmID = nil }
        }
    }

    /// 把 JS 传来的 payload 转成 Activity 的 ContentState；endAt 为 0 / 缺失表示不是倒计时
    private func contentState(from body: [String: Any]) -> DndActivityAttributes.ContentState {
        let ms = (body["endAt"] as? NSNumber)?.doubleValue ?? 0
        return DndActivityAttributes.ContentState(
            endAt: ms > 0 ? Date(timeIntervalSince1970: ms / 1000) : nil,
            big: body["big"] as? String ?? "",
            small: body["small"] as? String ?? "",
            tone: (body["tone"] as? NSNumber)?.intValue ?? 0,
            progress: (body["progress"] as? NSNumber)?.doubleValue ?? -1,
            ringText: body["ring"] as? String ?? "",
            badge: body["badge"] as? String ?? "",
            leftText: body["left"] as? String ?? "",
            rightText: body["right"] as? String ?? "",
            line1: body["line1"] as? String ?? "",
            line2: body["line2"] as? String ?? ""
        )
    }
}
