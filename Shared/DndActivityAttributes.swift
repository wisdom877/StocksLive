import ActivityKit

struct DndActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var endAt: Date
    }
    var title: String
    var subtitle: String
    var kind: String
}
