import Foundation
import ActivityKit

struct DndActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// 有截止时刻（日程 / 任务 / 专注 / 值班）时走系统倒计时；行情 / 超时态为 nil
        var endAt: Date?
        /// 无倒计时时的大字（行情点位、或「已超时 12:04」）
        var big: String
        /// 大字下面的小字（涨跌幅 · 时间）
        var small: String
        /// 1 涨 / -1 跌 / 2 超时 / 0 中性
        var tone: Int
        /// 环形进度 0...1（专注是整轮进度，日程是剩余比例）
        var progress: Double
        /// 环内文字，专注是「2/3」，日程/行情留空
        var ringText: String
        /// 右上角胶囊：还剩 36% / 上证指数 / 该结束了
        var badge: String
        /// 底部进度条两端的小字（11:30 / 13:30）
        var leftText: String
        var rightText: String
        /// 轮播时的标题 / 副标题覆写；空字符串表示沿用 attributes 里的固定值
        var line1: String
        var line2: String

        init(endAt: Date?, big: String = "", small: String = "", tone: Int = 0,
             progress: Double = -1, ringText: String = "", badge: String = "",
             leftText: String = "", rightText: String = "",
             line1: String = "", line2: String = "") {
            self.endAt = endAt
            self.big = big
            self.small = small
            self.tone = tone
            self.progress = progress
            self.ringText = ringText
            self.badge = badge
            self.leftText = leftText
            self.rightText = rightText
            self.line1 = line1
            self.line2 = line2
        }
    }
    var title: String
    var subtitle: String
    /// task / focus / shift / dnd / market
    var kind: String
}
