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
                    Image(systemName: iconName(context.attributes.kind))
                        .font(.system(size: 16, weight: .semibold))
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title).font(.subheadline).fontWeight(.semibold).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Trailing(context: context).font(.title3)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(footnote(context)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            } compactLeading: {
                Image(systemName: iconName(context.attributes.kind)).font(.caption)
            } compactTrailing: {
                Trailing(context: context).font(.caption).frame(maxWidth: 56)
            } minimal: {
                Trailing(context: context).font(.caption2)
            }
        }
        .supplementalActivityFamilies([.small, .medium])
    }

    private func footnote(_ context: ActivityViewContext<DndActivityAttributes>) -> String {
        if context.state.endAt != nil { return context.attributes.subtitle.isEmpty ? " " : context.attributes.subtitle }
        return context.state.small.isEmpty ? (context.attributes.subtitle.isEmpty ? " " : context.attributes.subtitle) : context.state.small
    }

    private func iconName(_ kind: String) -> String {
        switch kind {
        case "focus": return "brain.head.profile"
        case "shift": return "briefcase.fill"
        case "market": return "chart.line.uptrend.xyaxis"
        default: return "moon.fill"
        }
    }
}

/// 锁屏 / 手表卡片：标题可折两行，倒计时或行情大字靠右，副行单独一行
struct LockCard: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: iconName)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(tint)
                Text(context.attributes.title)
                    .font(.footnote).fontWeight(.semibold)
                    .lineLimit(2).minimumScaleFactor(0.8)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                Trailing(context: context)
                    .font(.system(size: 21, weight: .semibold, design: .rounded))
                    .layoutPriority(1)
            }
            if !subline.isEmpty {
                Text(subline)
                    .font(.caption2).foregroundStyle(.secondary)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var iconName: String {
        switch context.attributes.kind {
        case "focus": return "brain.head.profile"
        case "shift": return "briefcase.fill"
        case "market": return "chart.line.uptrend.xyaxis"
        default: return "moon.fill"
        }
    }

    private var subline: String {
        if context.state.endAt != nil { return context.attributes.subtitle }
        return context.state.small
    }

    private var tint: Color {
        switch context.state.tone {
        case 1: return Color(red: 1.0, green: 0.32, blue: 0.32)
        case -1: return Color(red: 0.2, green: 0.82, blue: 0.45)
        default: return .white
        }
    }
}

/// 有 endAt → 系统自己走秒；否则显示行情大字（带涨跌色）
struct Trailing: View {
    let context: ActivityViewContext<DndActivityAttributes>

    var body: some View {
        if let endAt = context.state.endAt {
            CountdownText(endAt: endAt)
        } else {
            Text(context.state.big.isEmpty ? "—" : context.state.big)
                .monospacedDigit()
                .foregroundStyle(toneColor)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }

    private var toneColor: Color {
        switch context.state.tone {
        case 1: return Color(red: 1.0, green: 0.32, blue: 0.32)
        case -1: return Color(red: 0.2, green: 0.82, blue: 0.45)
        default: return .primary
        }
    }
}

/// 秒数由系统自己走：渲染一次，之后每秒自动刷新，不靠推送也不耗电。
struct CountdownText: View {
    let endAt: Date

    var body: some View {
        let end = max(endAt, Date().addingTimeInterval(1))
        return Text(timerInterval: Date()...end, countsDown: true)
            .monospacedDigit()
    }
}

@main
struct DndLiveWidgetBundle: WidgetBundle {
    var body: some Widget {
        DndLiveWidget()
    }
}
