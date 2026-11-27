import Foundation

/// 原生层唯一的心率快照：BleHeart / HealthBridge / 快捷指令都会喂进来，
/// CarPlay 右侧留白里的心率胶囊只读这里，避免各页面自己缓存一份导致数字不一致。
final class HeartRateCenter {
    static let shared = HeartRateCenter()
    static let didUpdate = Notification.Name("HeartRateCenterDidUpdate")

    private(set) var bpm: Int?
    private(set) var updatedAt: Date?

    private init() {}

    func ingest(_ value: Int, at date: Date = Date()) {
        guard value >= 25, value <= 240 else { return }
        let apply = {
            self.bpm = value
            self.updatedAt = date
            NotificationCenter.default.post(name: Self.didUpdate, object: self)
        }
        if Thread.isMainThread { apply() }
        else { DispatchQueue.main.async(execute: apply) }
    }

    /// 和网页同一口径：超过 90 秒没有新样本就视为未接入，不显示一个已经过期的数字。
    func current(now: Date = Date()) -> Int? {
        guard let bpm, let updatedAt, now.timeIntervalSince(updatedAt) <= 90 else { return nil }
        return bpm
    }
}
