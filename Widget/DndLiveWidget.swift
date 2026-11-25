import WidgetKit
import SwiftUI

struct DndLiveWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DndActivityAttributes.self) { context in
            HStack(spacing: 12) {
                Image(systemName: iconName(context.attributes.kind))
                    .font(.system(size: 18, weight: .semibold))
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.title).font(.footnote).fontWeight(.semibold)
                    if !context.attributes.subtitle.isEmpty {
                        Text(context.attributes.subtitle).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                CountdownText(endAt: context.state.endAt)
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
            }
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
                    CountdownText(endAt: context.state.endAt).font(.title3)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.attributes.subtitle.isEmpty ? " " : context.attributes.subtitle)
                        .font(.caption2).foregroundStyle(.secondary)
                }
            } compactLeading: {
                Image(systemName: iconName(context.attributes.kind)).font(.caption)
            } compactTrailing: {
                CountdownText(endAt: context.state.endAt).font(.caption).frame(maxWidth: 52)
            } minimal: {
                CountdownText(endAt: context.state.endAt).font(.caption2)
            }
        }
        .supplementalActivityFamilies([.small, .medium])
    }

    private func iconName(_ kind: String) -> String {
        switch kind {
        case "focus": return "brain.head.profile"
        case "shift": return "briefcase.fill"
        default: return "moon.fill"
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
