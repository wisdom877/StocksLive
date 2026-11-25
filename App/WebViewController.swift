import UIKit
import WebKit
import ActivityKit

final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

    private var webView: WKWebView!
    // 优先走有证书的域名（HTTPS），证书有效，不会被 ATS 拦、也不吃运营商对 80 端口的限制
    private let homeURL = URL(string: "https://api.wisdomhqq.top/stocks/")!
    private let fallbackURL = URL(string: "http://106.53.132.252/stocks/")!
    private var triedFallback = false
    private var autoRetry = 0
    private var retryTask: DispatchWorkItem?
    private var failedURL = URL(string: "https://api.wisdomhqq.top/stocks/")!

    /// 站点里的 dndLockSync() 只认 window.Capacitor.Plugins.DndLive；
    /// 这里在文档开始前塞一个同名 shim，把调用转成 WK 消息，网页代码一行不用改。
    private static let bridgeJS: String = """
    (function () {
      if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.dndLive) return;
      window.Capacitor = window.Capacitor || {};
      window.Capacitor.Plugins = window.Capacitor.Plugins || {};
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
        super.viewDidLoad()
        view.backgroundColor = .black

        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()          // cookie / localStorage 全部持久化，登录一次就够
        conf.userContentController.add(self, name: "dndLive")
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
