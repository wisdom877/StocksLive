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
                    HrCurve(samples: context.state.hr ?? [], bpm: context.state.bpm,
                            height: 18, width: 46, showValue: false)
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
                HrCurve(samples: context.state.hr ?? [], bpm: context.state.bpm,
                        height: 10, width: 22, showValue: false)
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
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if !context.state.ringText.isEmpty {
                        Text(context.state.ringText)
                            .font(.system(size: 9, weight: .semibold, design: .rounded))
                            .foregroundStyle(toneColor(context.state.tone))
                    }
                    Text(dLine1(context))
                        .font(.system(size: 11, weight: .semibold))
                        .lineLimit(1).minimumScaleFactor(0.65)
                }
                BigText(context: context)
                    .font(.system(size: 19, weight: .semibold, design: .rounded))
                    .lineLimit(1).minimumScaleFactor(0.55)
                BarView(context: context, showsEnds: false, height: 2)
            }
            Spacer(minLength: 0)
            HrCurve(samples: context.state.hr ?? [], bpm: context.state.bpm, height: 22, width: 62)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 手机锁屏：标题一行（角标靠右）→ 大字 + 时间范围同一行 → 一条细进度条
struct PhoneCard: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if !context.state.ringText.isEmpty {
                        Text(context.state.ringText)
                            .font(.system(size: 11, weight: .semibold, design: .rounded))
                            .foregroundStyle(toneColor(context.state.tone))
                    }
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
            if context.state.progress >= 0 || !(context.state.hr ?? []).isEmpty {
                HrCurve(samples: context.state.hr ?? [], bpm: context.state.bpm, height: 26, width: 66)
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

/// 实时心率曲线：只有真采样才画；没数据就整块消失（不占位、不造假波形）
struct HrCurve: View {
    let samples: [Double]
    var bpm: Int?
    var height: CGFloat = 22
    var width: CGFloat = 62
    var showValue: Bool = true

    var body: some View {
        if samples.count >= 3 {
            VStack(alignment: .trailing, spacing: 1) {
                Canvas { ctx, size in
                    var lo = samples.min() ?? 0, hi = samples.max() ?? 0
                    if hi - lo < 10 { let mid = (hi + lo) / 2; lo = mid - 5; hi = mid + 5 }
                    let span = max(1, hi - lo)
                    let pts = samples.enumerated().map { i, v in
                        CGPoint(x: size.width * CGFloat(i) / CGFloat(samples.count - 1),
                                y: size.height - 1 - CGFloat((v - lo) / span) * (size.height - 3))
                    }
                    var path = Path()
                    path.addLines(pts)
                    ctx.stroke(path, with: .color(.white.opacity(0.85)),
                               style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
                    if let last = pts.last {
                        ctx.fill(Path(ellipseIn: CGRect(x: last.x - 1.6, y: last.y - 1.6, width: 3.2, height: 3.2)),
                                 with: .color(.white.opacity(0.9)))
                    }
                }
                .frame(width: width, height: height)
                if showValue, let b = bpm, b > 0 {
                    Text("\(b) BPM")
                        .font(.system(size: 8.5, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                }
            }
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
