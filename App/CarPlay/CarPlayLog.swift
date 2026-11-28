import Foundation
import UIKit
import WebKit

/// CarPlay 诊断日志：内存环形 200 条 + 沙盒文件（上限 512 KB）。
///
/// 为什么要有这个：车机侧出问题时，现场只有设备 Console 里的 NSLog，用户拿不到，
/// 服务器也看不到。这里把状态切换、重连、断连原因按时间戳留一段，会话结束或重建时
/// 压缩上报到 `/api/v1/diag/carplay`，落到服务器 `logs/carplay/`。
///
/// 三条硬约束：
/// 1. 只在主流程旁路写，绝不阻塞启动、渲染和重连；
/// 2. 上报走 cookie（sk），不碰 appkey，凭证不进代码也不进日志；
/// 3. 60 秒内只传一次，避免断连风暴时把请求打满。
final class CarPlayLog {
    static let shared = CarPlayLog()

    private let queue = DispatchQueue(label: "StocksLive.carplayLog")
    private var memory: [String] = []
    private let memoryMax = 200
    private let fileMax = 512 * 1024
    private var lastUploadAt = Date.distantPast
    private let minUploadGap: TimeInterval = 60

    private let fileURL: URL? = {
        guard let doc = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
        else { return nil }
        let folder = doc.appendingPathComponent("CarPlay", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("carplay.log")
    }()

    private static let stampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm:ss.SSS"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    /// 记一条。调用方不用关心线程，内部串行队列落盘。
    func record(_ line: String) {
        let text = "\(Self.stampFormatter.string(from: Date())) \(line)"
        queue.async { [weak self] in
            guard let self else { return }
            self.memory.append(text)
            if self.memory.count > self.memoryMax {
                self.memory.removeFirst(self.memory.count - self.memoryMax)
            }
            self.appendToFile(text)
        }
    }

    /// 上报一次。reason 说明这次为什么传：stop / failed / lost / recover / manual。
    /// 只读 cookie 里的 sk，缺 cookie 时直接放弃，不重试（下一次重建还会再传）。
    func upload(webView: WKWebView?, reason: String) {
        guard let webView else { return }
        let now = Date()
        guard now.timeIntervalSince(lastUploadAt) >= minUploadGap else { return }
        lastUploadAt = now

        let lines = queue.sync { memory }
        guard lines.isEmpty == false else { return }
        guard let endpoint = Self.endpoint(from: webView.url) else { return }
        let payloadLines = Array(lines.suffix(500))

        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
            guard let sk = cookies.first(where: { $0.name == "sk" && $0.value.isEmpty == false })
            else { return }
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("sk=\(sk.value)", forHTTPHeaderField: "Cookie")
            let body: [String: Any] = [
                "device": UIDevice.current.model,
                "system": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
                "version": (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "",
                "reason": reason,
                "lines": payloadLines,
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
            request.httpBody = data
            URLSession.shared.dataTask(with: request) { _, _, _ in }.resume()
        }
    }

    /// 本地留档路径，供设置页「导出诊断」用（当前 UI 未接，先留接口）。
    var localFileURL: URL? { fileURL }

    private func appendToFile(_ text: String) {
        guard let url = fileURL else { return }
        let data = Data((text + "\n").utf8)
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        let size = (attrs?[.size] as? Int) ?? 0
        if size + data.count > fileMax {
            // 到顶就整篇重写，只保留最新这一段，避免无限增长
            try? data.write(to: url, options: .atomic)
            return
        }
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    /// 端点沿用当前网页的 scheme/host（线上是 https），路径固定 /stocks/api/v1/diag/carplay。
    private static func endpoint(from pageURL: URL?) -> URL? {
        guard let pageURL, let scheme = pageURL.scheme, let host = pageURL.host else {
            return URL(string: "https://api.wisdomhqq.top/stocks/api/v1/diag/carplay")
        }
        var comps = URLComponents()
        comps.scheme = scheme
        comps.host = host
        comps.port = pageURL.port
        comps.path = "/stocks/api/v1/diag/carplay"
        return comps.url
    }
}
