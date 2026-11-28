import Foundation
import QuartzCore

/// 视频链路的轻量遥测：只记录“解密 + 解析”这一步的耗时，供 H264Surface.statsLine 汇总。
/// 从视频解复用队列写、从主线程每秒读一次，用一把锁隔离，代价可忽略。
final class VideoTelemetry {
    static let shared = VideoTelemetry()
    private let lock = NSLock()
    private var samples: [Double] = []
    private let capacity = 128

    private init() {}

    func recordDemux(_ milliseconds: Double) {
        lock.lock()
        samples.append(milliseconds)
        if samples.count > capacity { samples.removeFirst(samples.count - capacity) }
        lock.unlock()
    }

    /// 最近 128 帧的解密+解析耗时 p95（毫秒）与样本数。
    func demuxP95() -> (p95: Double, count: Int) {
        lock.lock()
        let copy = samples
        lock.unlock()
        guard !copy.isEmpty else { return (0, 0) }
        let sorted = copy.sorted()
        let index = Int(Double(sorted.count - 1) * 0.95)
        return (sorted[index], sorted.count)
    }
}
