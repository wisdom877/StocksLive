import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, OrientationControlling, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    private weak var web: WebViewController?
    /// 默认竖屏；待机页打开时切成横屏，退出待机再切回来
    private var lockLandscape = false

    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        lockLandscape ? .landscapeRight : .portrait
    }

    /// 网页要切方向（1 横屏 / 0 竖屏）：改掉支持的方向，再让系统真的把界面转过去
    func setLandscape(_ on: Bool) {
        guard lockLandscape != on else { return }
        lockLandscape = on
        // 连打两拍：iOS 16 上有时第一拍 geometry 请求会被正在进行的布局吃掉，第二次才真转
        applyLandscape(on, retry: true)
    }

    private func applyLandscape(_ on: Bool, retry: Bool) {
        DispatchQueue.main.async {
            guard let win = self.window else { return }
            let want: UIInterfaceOrientationMask = on ? .landscapeRight : .portrait
            // 先让系统知道支持的方向变了（iOS 16 起必须），再真的把界面转过去
            if #available(iOS 16.0, *) {
                win.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
                if let scene = win.windowScene {
                    scene.requestGeometryUpdate(.iOS(interfaceOrientations: want)) { _ in }
                    return
                }
            }
            // 没接 Scene（这个壳是 AppDelegate + UIWindow 的老式生命周期）：走设备方向 + 尝试旋转
            UIDevice.current.setValue(on ? UIInterfaceOrientation.landscapeRight.rawValue
                                         : UIInterfaceOrientation.portrait.rawValue,
                                      forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
            win.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
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
