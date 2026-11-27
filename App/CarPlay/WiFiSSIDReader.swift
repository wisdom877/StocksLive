// 读取 iPhone 当前所连 Wi-Fi 的名称，用于 CarPlay 本机接收端的会话参数。
// 前置条件：App ID 打开 Access WiFi Information，且用户授予「使用期间」定位权限；
// 任一缺失都返回 nil，调用方退回手填，不阻塞流程。
import CoreLocation
import Foundation
import SystemConfiguration.CaptiveNetwork

final class WiFiSSIDReader: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var completion: ((String?) -> Void)?
    private var finished = false

    func currentSSID(completion: @escaping (String?) -> Void) {
        DispatchQueue.main.async {
            self.completion = completion
            self.finished = false
            self.manager.delegate = self
            switch self.manager.authorizationStatus {
            case .authorizedWhenInUse, .authorizedAlways:
                self.read()
            case .notDetermined:
                self.manager.requestWhenInUseAuthorization()
                DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
                    self?.finish(nil)
                }
            default:
                self.finish(nil)
            }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            read()
        case .denied, .restricted:
            finish(nil)
        default:
            break
        }
    }

    private func read() {
        guard let interfaces = CNCopySupportedInterfaces() as? [String] else {
            finish(nil); return
        }
        for name in interfaces {
            guard let info = CNCopyCurrentNetworkInfo(name as CFString) as? [String: Any],
                  let ssid = info[kCNNetworkInfoKeySSID as String] as? String,
                  !ssid.isEmpty else { continue }
            finish(ssid)
            return
        }
        finish(nil)
    }

    private func finish(_ ssid: String?) {
        guard !finished else { return }
        finished = true
        let callback = completion
        completion = nil
        callback?(ssid)
    }
}
