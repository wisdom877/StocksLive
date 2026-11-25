import UIKit
import WebKit
import ActivityKit

final class WebViewController: UIViewController, WKScriptMessageHandler {

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
        webView.navigationDelegate = nil
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        view.addSubview(webView)

        webView.load(URLRequest(url: homeURL))
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
