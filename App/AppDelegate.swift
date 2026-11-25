import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    private weak var web: WebViewController?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let vc = WebViewController()
        window.rootViewController = vc
        window.backgroundColor = .black
        window.makeKeyAndVisible()
        self.window = window
        self.web = vc

        // 到点提醒走系统通知：锁屏 / App 不在前台也能响，声音用系统提示音
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        return true
    }

    /// App 在前台时也把通知弹出来并带声音（网页自己那套只在网页里响）
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // 前台交给网页自己响铃 + 弹「知道了 / 10 分钟后再提醒」，不再叠一层系统横幅
        completionHandler([])
    }

    /// 点开系统通知：打开 App 并把提醒 id 交给页面，弹那张能关掉提醒的卡
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["id"] as? String {
            DispatchQueue.main.async { self.web?.deliverAlarm(id) }
        }
        completionHandler()
    }
}
