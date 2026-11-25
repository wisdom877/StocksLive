import Foundation
import ActivityKit

struct DndActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 有截止时刻（日程 / 任务 / 专注 / 值班）时走系统倒计时；行情类为 nil
        var endAt: Date?
        /// 行情类的大字（价格）
        var big: String
        /// 行情类的小字（涨跌幅 · 时间）
        var small: String
        /// 1 涨 / 0 平 / -1 跌
        var tone: Int

        init(endAt: Date?, big: String = "", small: String = "", tone: Int = 0) {
            self.endAt = endAt
            self.big = big
            self.small = small
            self.tone = tone
        }
    }
    var title: String
    var subtitle: String
    /// task / focus / shift / dnd / market
    var kind: String
}
