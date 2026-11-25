import UIKit
import WebKit
import ActivityKit
import UserNotifications
import AVFoundation
import AudioToolbox

final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

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
        // 铃声走播放类音频会话：静音拨片拨上也能响（和系统闹钟一致）
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [.duckOthers])
        try? AVAudioSession.sharedInstance().setActive(true)

        NotificationCenter.default.addObserver(self, selector: #selector(enterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(enterForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
        super.viewDidLoad()
        view.backgroundColor = .black

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
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        view.addSubview(webView)
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
        a.color = .white
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
        box.backgroundColor = UIColor(white: 0.12, alpha: 0.95)
        box.layer.cornerRadius = 12

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.numberOfLines = 0
        label.textColor = .white
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushSafeArea()
        pushPendingAlarm()
        autoRetry = 0
        loading?.stopAnimating()
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

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

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
            center.getNotificationSettings { _ in
                center.getPendingNotificationRequests { reqs in
                    let old = reqs.map(\.identifier).filter { $0.hasPrefix("wk-") }
                    center.removePendingNotificationRequests(withIdentifiers: old)
                    center.removeDeliveredNotifications(withIdentifiers: old)

                    for t in tasks {
                        guard let when = t["when"] as? String,
                              let date = Self.localDate(when) else { continue }
                        let rawID = (t["id"] as? String) ?? UUID().uuidString
                        let content = UNMutableNotificationContent()
                        content.title = (t["title"] as? String) ?? "到点提醒"
                        content.body = (t["meta"] as? String) ?? (t["note"] as? String) ?? ""
                        // 自带提示音（约 3 秒两拍，比系统"咚"更能听见）；找不到文件就走系统默认
                        content.sound = UNNotificationSound(named: UNNotificationSoundName("alarm.wav"))
                        content.threadIdentifier = "wk-alarm"
                        content.userInfo = ["id": rawID]
                        if #available(iOS 15.0, *) { content.interruptionLevel = .timeSensitive }

                        let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: date)
                        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
                        center.add(UNNotificationRequest(identifier: "wk-" + rawID, content: content, trigger: trigger))
                    }
                    DispatchQueue.main.async { self.reportNativeState() }
                }
            }
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
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        case "tone":
            playTone(loop: (dict["loop"] as? Bool) ?? false)
        case "ringStop":
            stopTone()
        default:
            break
        }
    }

    private func reportNativeState() {
        let js = "window.wkNativeState && window.wkNativeState(true, true, \(standbyOn))"
        DispatchQueue.main.async { self.webView.evaluateJavaScript(js, completionHandler: nil) }
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
        guard let url = Bundle.main.url(forResource: "alarm", withExtension: "wav") else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        guard let p = try? AVAudioPlayer(contentsOf: url) else { return }
        tonePlayer?.stop()
        p.numberOfLoops = loop ? -1 : 0
        p.volume = 1.0
        p.play()
        tonePlayer = p
    }

    private func stopTone() {
        tonePlayer?.stop()
        tonePlayer = nil
    }
    private var standbyPlayer: AVAudioPlayer?

    @objc private func enterBackground() { syncStandbyPlayer() }
    @objc private func enterForeground() { syncStandbyPlayer() }

    /// 后台时播一条静音循环（audio 后台模式）→ 锁屏时页面定时器还在跑，到点能自己响铃+震动
    private func syncStandbyPlayer() {
        guard standbyOn else { standbyPlayer?.stop(); standbyPlayer = nil; return }
        let bg = UIApplication.shared.applicationState == .background
        if bg, standbyPlayer == nil, let url = Bundle.main.url(forResource: "standby", withExtension: "wav") {
            if let p = try? AVAudioPlayer(contentsOf: url) {
                p.numberOfLoops = -1
                p.volume = 0.01          // 几乎无声，只为保活
                p.play()
                standbyPlayer = p
            }
        } else if !bg {
            standbyPlayer?.stop(); standbyPlayer = nil
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
            tone: (body["tone"] as? NSNumber)?.intValue ?? 0
        )
    }
}
