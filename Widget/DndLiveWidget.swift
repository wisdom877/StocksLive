import WidgetKit
import SwiftUI

struct DndLiveWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DndActivityAttributes.self) { context in
            LockCard(context: context)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Leading(context: context, size: 30)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(dLine1(context)).font(.subheadline).fontWeight(.semibold).lineLimit(1)
                        if !dLine2(context).isEmpty {
                            Text(dLine2(context)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    BigText(context: context).font(.title3).lineLimit(1).minimumScaleFactor(0.6)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    BarView(context: context)
                }
            } compactLeading: {
                CompactLeading(context: context)
            } compactTrailing: {
                BigText(context: context).font(.caption).lineLimit(1).minimumScaleFactor(0.6).frame(maxWidth: 56)
            } minimal: {
                BigText(context: context).font(.caption2)
            }
        }
        .supplementalActivityFamilies([.small, .medium])
    }
}

// MARK: - 锁屏卡

/// 一层标题 + 一个巨大倒计时 + 一条细进度条；左侧环形表示步骤进度，行情态换成折线图标
struct LockCard: View {
    @Environment(\.activityFamily) private var family
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        if family == .small {
            WatchCard(context: context)
        } else {
            PhoneCard(context: context)
        }
    }
}

/// 手表（small 家族）：只留环、标题、大倒计时、一条极细进度线，其余全部砍掉
struct WatchCard: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Leading(context: context, size: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(dLine1(context))
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1).minimumScaleFactor(0.65)
                BigText(context: context)
                    .font(.system(size: 19, weight: .semibold, design: .rounded))
                    .lineLimit(1).minimumScaleFactor(0.55)
                BarView(context: context, showsEnds: false, height: 2)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 手机锁屏：标题一行（角标靠右）→ 大字 + 时间范围同一行 → 一条细进度条
struct PhoneCard: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Leading(context: context, size: 40)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(dLine1(context))
                        .font(.footnote).fontWeight(.semibold)
                        .lineLimit(1).minimumScaleFactor(0.75)
                    // 有进度环的（专注）副标题很短，跟在标题后面；没有进度条的（待办）放到大字右边
                    if context.state.progress >= 0 && !dLine2(context).isEmpty {
                        Text("· " + dLine2(context))
                            .font(.caption2).foregroundStyle(.secondary)
                            .lineLimit(1).minimumScaleFactor(0.7)
                    }
                    Spacer(minLength: 8)
                    if !context.state.badge.isEmpty {
                        Badge(text: context.state.badge, tone: context.state.tone)
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    BigText(context: context)
                        .font(.system(size: 32, weight: .semibold, design: .rounded))
                        .lineLimit(1).minimumScaleFactor(0.55)
                    if context.state.progress < 0 && !dLine2(context).isEmpty {
                        Spacer(minLength: 8)
                        Text(dLine2(context))
                            .font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1).minimumScaleFactor(0.7)
                    }
                }
                BarView(context: context)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - 组件

private func toneColor(_ tone: Int) -> Color {
    switch tone {
    case 1: return Color(red: 1.0, green: 0.32, blue: 0.32)
    case -1: return Color(red: 0.2, green: 0.82, blue: 0.45)
    case 2: return Color(red: 1.0, green: 0.35, blue: 0.35)
    default: return .white
    }
}

private func iconName(_ kind: String) -> String {
    switch kind {
    case "focus": return "brain.head.profile"
    case "shift": return "briefcase.fill"
    case "market": return "chart.line.uptrend.xyaxis"
    default: return "moon.fill"
    }
}

/// 左侧：有环形进度就画环（环里写 2/3），否则画图标
struct Leading: View {
    let context: ActivityViewContext<DndActivityAttributes>
    let size: CGFloat

    var body: some View {
        if context.state.progress >= 0 && !context.state.ringText.isEmpty {
            ZStack {
                Circle().stroke(Color.white.opacity(0.18), lineWidth: 3)
                Circle()
                    .trim(from: 0, to: min(max(context.state.progress, 0.02), 1))
                    .stroke(toneColor(context.state.tone), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(context.state.ringText)
                    .font(.system(size: size * 0.26, weight: .semibold, design: .rounded))
                    .minimumScaleFactor(0.6)
            }
            .frame(width: size, height: size)
        } else {
            Image(systemName: iconName(context.attributes.kind))
                .font(.system(size: size * 0.55, weight: .semibold))
                .foregroundStyle(toneColor(context.state.tone))
                .frame(width: size, height: size)
        }
    }
}

struct CompactLeading: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        if context.state.progress >= 0 && !context.state.ringText.isEmpty {
            Image(systemName: "circle.dashed")
                .font(.caption)
                .foregroundStyle(toneColor(context.state.tone))
        } else {
            Image(systemName: iconName(context.attributes.kind))
                .font(.caption)
                .foregroundStyle(toneColor(context.state.tone))
        }
    }
}

/// 优先级：写了 big（该做了 / 已超时 / 行情点位）→ 显示 big；
/// 否则有 endAt：还早（> 90 分钟）按分钟显示「X 小时 Y 分」，临近了交给系统逐秒倒计时
struct BigText: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        if !context.state.big.isEmpty {
            Text(context.state.big)
                .monospacedDigit()
                .foregroundStyle(toneColor(context.state.tone))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        } else if let endAt = context.state.endAt {
            if endAt.timeIntervalSinceNow > 90 * 60 {
                TimelineView(.periodic(from: .now, by: 60)) { _ in
                    Text(coarseRemaining(endAt)).monospacedDigit()
                }
            } else {
                CountdownText(endAt: endAt).monospacedDigit()
            }
        } else {
            Text("—").monospacedDigit()
        }
    }
}

private func coarseRemaining(_ endAt: Date) -> String {
    let m = max(0, Int((endAt.timeIntervalSinceNow / 60).rounded(.up)))
    if m >= 60 { return "\(m / 60) 小时 \(m % 60) 分" }
    if m >= 1 { return "\(m) 分钟" }
    return "不到 1 分钟"
}

/// 一条 3px 细进度条 + 两端时刻；没有进度信息就整块隐藏
struct BarView: View {
    let context: ActivityViewContext<DndActivityAttributes>
    var showsEnds: Bool = true
    var height: CGFloat = 3

    var body: some View {
        if context.state.progress >= 0 {
            VStack(alignment: .leading, spacing: 3) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.white.opacity(0.16))
                        Capsule().fill(toneColor(context.state.tone))
                            .frame(width: max(2, geo.size.width * min(max(context.state.progress, 0), 1)))
                    }
                }
                .frame(height: height)
                if showsEnds {
                    HStack(spacing: 0) {
                        Text(context.state.leftText)
                        Spacer(minLength: 4)
                        Text(context.state.rightText)
                    }
                    .font(.system(size: 9, weight: .regular, design: .rounded))
                    .foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct Badge: View {
    let text: String
    let tone: Int

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium, design: .rounded))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(tone == 0 ? Color.secondary : toneColor(tone))
    }
}

/// 秒数由系统自己走：渲染一次，之后每秒自动刷新，不靠推送也不耗电。
struct CountdownText: View {
    let endAt: Date

    var body: some View {
        let end = max(endAt, Date().addingTimeInterval(1))
        return Text(timerInterval: Date()...end, countsDown: true)
    }
}

@main
struct DndLiveWidgetBundle: WidgetBundle {
    var body: some Widget {
        DndLiveWidget()
    }
}


/// 轮播时会用 contentState 里的 line1/line2 覆盖固定标题
func dLine1(_ c: ActivityViewContext<DndActivityAttributes>) -> String {
    c.state.line1.isEmpty ? c.attributes.title : c.state.line1
}
func dLine2(_ c: ActivityViewContext<DndActivityAttributes>) -> String {
    c.state.line2.isEmpty ? c.attributes.subtitle : c.state.line2
}
