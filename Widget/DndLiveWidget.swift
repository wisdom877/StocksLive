import WidgetKit
import SwiftUI

struct DndLiveWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DndActivityAttributes.self) { context in
            LockCard(context: context)
                .padding(.horizontal, 16).padding(.vertical, 14)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Leading(context: context, size: 30)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(context.attributes.title).font(.subheadline).fontWeight(.semibold).lineLimit(1)
                        if !context.attributes.subtitle.isEmpty {
                            Text(context.attributes.subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    BigText(context: context).font(.title3)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    BarView(context: context)
                }
            } compactLeading: {
                CompactLeading(context: context)
            } compactTrailing: {
                BigText(context: context).font(.caption).frame(maxWidth: 56)
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
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            Leading(context: context, size: 46)
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(context.attributes.title)
                        .font(.footnote).fontWeight(.semibold)
                        .lineLimit(1).minimumScaleFactor(0.75)
                    if !context.attributes.subtitle.isEmpty {
                        Text("· " + context.attributes.subtitle)
                            .font(.caption2).foregroundStyle(.secondary)
                            .lineLimit(1).minimumScaleFactor(0.7)
                    }
                    Spacer(minLength: 6)
                    if !context.state.badge.isEmpty {
                        Badge(text: context.state.badge, tone: context.state.tone)
                    }
                }
                BigText(context: context)
                    .font(.system(size: 30, weight: .semibold, design: .rounded))
                    .lineLimit(1).minimumScaleFactor(0.55)
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

/// 有 endAt 让系统自己走秒；否则显示大字（行情点位 / 已超时）
struct BigText: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        if let endAt = context.state.endAt {
            CountdownText(endAt: endAt).monospacedDigit()
        } else {
            Text(context.state.big.isEmpty ? "—" : context.state.big)
                .monospacedDigit()
                .foregroundStyle(toneColor(context.state.tone))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        }
    }
}

/// 一条 3px 细进度条 + 两端时刻；没有进度信息就整块隐藏
struct BarView: View {
    let context: ActivityViewContext<DndActivityAttributes>

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
                .frame(height: 3)
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

struct Badge: View {
    let text: String
    let tone: Int

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium, design: .rounded))
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(
                Capsule().fill(toneColor(tone).opacity(tone == 0 ? 0.14 : 0.9))
            )
            .foregroundStyle(tone == 0 ? Color.white.opacity(0.75) : Color.white)
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
