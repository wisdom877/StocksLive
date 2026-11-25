import UIKit
import WebKit
import ActivityKit

final class WebViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

    private var webView: WKWebView!
    private let homeURL = URL(string: "http://106.53.132.252/stocks/")!

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
        end: function () {
          try { window.webkit.messageHandlers.dndLive.postMessage({ cmd: "end" }); } catch (e) {}
          return Promise.resolve();
        },
        isSupported: function () { return Promise.resolve({ supported: true }); }
      };
    })();
    """

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

        webView.load(URLRequest(url: homeURL))
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
        addLoading()
        webView.load(URLRequest(url: homeURL))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading?.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError("错误 \((error as NSError).code)：\(error.localizedDescription)\n\(homeURL.absoluteString)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError("连接失败 \((error as NSError).domain) \((error as NSError).code)\n\(error.localizedDescription)\n\(homeURL.absoluteString)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError("WebView 进程被系统回收，点重试")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        guard #available(iOS 16.1, *) else { return }

        switch cmd {
        case "start":
            let title = body["title"] as? String ?? "倒计时"
            let subtitle = body["subtitle"] as? String ?? ""
            let kind = body["kind"] as? String ?? "task"
            let ms = (body["endAt"] as? NSNumber)?.doubleValue ?? 0
            let endAt = Date(timeIntervalSince1970: ms / 1000)

            Task { @MainActor in
                for running in Activity<DndActivityAttributes>.activities {
                    await running.end(dismissalPolicy: .immediate)
                }
                let attrs = DndActivityAttributes(title: title, subtitle: subtitle, kind: kind)
                let state = DndActivityAttributes.ContentState(endAt: endAt)
                if let act = try? Activity.request(attributes: attrs, contentState: state, pushType: nil) {
                    // 到点后再留 5 分钟，由系统收走；App 被杀也生效
                    await act.end(dismissalPolicy: .after(endAt.addingTimeInterval(300)))
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
}
