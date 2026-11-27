import UIKit
import UserNotifications

/// iPad HD 版专用启动入口。和 iPhone 的 AppDelegate 完全分开编译：
/// iPhone 端仍然只支持竖屏 + 待机横屏，HD 端平时四个方向都可用，
/// 只有进入待机（横屏仪表盘）时才临时请求横屏。
@main
final class HDAppDelegate: UIResponder, UIApplicationDelegate, OrientationControlling, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    private weak var web: WebViewController?
    private var lockLandscape = false

    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        lockLandscape ? .landscape : .all
    }

    func setLandscape(_ on: Bool) {
        guard lockLandscape != on else { return }
        lockLandscape = on
        applyLandscape(on, retry: true)
    }

    private func applyLandscape(_ on: Bool, retry: Bool) {
        DispatchQueue.main.async {
            guard let win = self.window else { return }
            let want: UIInterfaceOrientationMask = on ? .landscape : .all
            win.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            if let scene = win.windowScene {
                scene.requestGeometryUpdate(.iOS(interfaceOrientations: want)) { _ in }
            } else {
                UIViewController.attemptRotationToDeviceOrientation()
            }
        }
        if retry {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.34) { [weak self] in
                self?.applyLandscape(on, retry: false)
            }
        }
    }

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let vc = WebViewController()
        window.rootViewController = vc
        window.backgroundColor = .systemBackground
        window.makeKeyAndVisible()
        self.window = window
        self.web = vc

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["id"] as? String {
            DispatchQueue.main.async { self.web?.deliverAlarm(id) }
        }
        completionHandler()
    }
}
