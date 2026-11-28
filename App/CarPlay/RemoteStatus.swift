import Foundation
import Network

/// iPad 接收端 → iPhone 远程主机的轻量状态回执。
/// CarPlay 的 RTSP 控制连接是 iPhone 主动发起的；iAP2 侧没有“对端已连上”的回执，
/// 所以用一条同局域网的 UDP 心跳把接收端的真实状态带回 iPhone。
enum RemoteStatusPacket {
    static let prefix = "STOCKSCP1"
    static let port: UInt16 = 7001

    static func encode(_ state: String) -> Data {
        Data("\(prefix)|\(state)|\(Int(Date().timeIntervalSince1970))".utf8)
    }

    static func decode(_ data: Data) -> String? {
        let text = String(data: data, encoding: .utf8) ?? ""
        let parts = text.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count >= 2, parts[0] == prefix else { return nil }
        return parts[1]
    }
}

/// iPhone 端监听接收端心跳；12 秒没有任何包才报 lost。
/// 心跳是 UDP，iPad 短暂卡顿、切后台或 Wi-Fi 抖一下就会丢几个包，
/// 6 秒太短，会把仍然活着的 CarPlay 误判成「等待 iPad 确认」。
final class RemoteStatusListener {
    private let queue = DispatchQueue(label: "StocksLive.remoteStatus.listener")
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var watchdog: DispatchSourceTimer?
    private var lastPacketAt = Date.distantPast
    private var reportedLost = true
    var onState: ((String) -> Void)?

    func start(port: UInt16 = RemoteStatusPacket.port) throws {
        stop()
        let candidate = try NWListener(using: .udp, on: NWEndpoint.Port(rawValue: port) ?? .any)
        listener = candidate
        lastPacketAt = Date()
        reportedLost = false
        candidate.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            let id = UUID()
            self.connections[id] = connection
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .failed, .cancelled:
                    self.connections.removeValue(forKey: id)
                default: break
                }
            }
            connection.start(queue: self.queue)
            self.receive(connection, id: id)
        }
        candidate.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            if case .failed(let error) = state { self.listener = nil; self.report("lost") }
        }
        candidate.start(queue: queue)

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, !self.reportedLost, Date().timeIntervalSince(self.lastPacketAt) > 12 else { return }
            self.reportedLost = true
            self.report("lost")
        }
        watchdog = timer
        timer.resume()
    }

    func stop() {
        watchdog?.cancel(); watchdog = nil
        connections.values.forEach { $0.cancel() }; connections.removeAll()
        listener?.cancel(); listener = nil
        reportedLost = true
    }

    private func receive(_ connection: NWConnection, id: UUID) {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, let state = RemoteStatusPacket.decode(data) {
                self.lastPacketAt = Date()
                self.reportedLost = false
                self.report(state)
            }
            if error == nil {
                self.receive(connection, id: id)
            } else {
                self.connections.removeValue(forKey: id)
            }
        }
    }

    /// 回前台时重新给心跳一个完整的 12 秒窗口；后台被系统冻住期间的时间差
    /// 不能拿来判定“iPad 掉线”，否则一解锁就闪一下等待连接。
    func markFresh() {
        queue.async { [weak self] in
            guard let self else { return }
            // 只重置判定窗口，不把旧状态再抛一次：旧状态可能刚好是 lost，
            // 回前台补发会让远程主机误以为已经恢复并取消重建。
            self.lastPacketAt = Date()
            self.reportedLost = false
        }
    }

    private func report(_ state: String) {
        DispatchQueue.main.async { [weak self] in self?.onState?(state) }
    }
}

/// iPad 接收端：控制连接就绪后开始每 2 秒向 iPhone 回执。
final class RemoteStatusBeacon {
    private let queue = DispatchQueue(label: "StocksLive.remoteStatus.beacon")
    private var connection: NWConnection?
    private var timer: DispatchSourceTimer?
    private var state = "connected"
    private var ready = false

    func start(peer: String, port: UInt16 = RemoteStatusPacket.port, state: String = "connected") {
        stop()
        self.state = state
        let target = NWEndpoint.Host(peer)
        let endpoint = NWEndpoint.hostPort(host: target, port: NWEndpoint.Port(rawValue: port) ?? .any)
        let candidate = NWConnection(to: endpoint, using: .udp)
        connection = candidate
        candidate.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.queue.async {
                switch state {
                case .ready:
                    self.ready = true
                    self.sendNow()
                case .failed, .cancelled:
                    self.ready = false
                default: break
                }
            }
        }
        candidate.start(queue: queue)

        let beat = DispatchSource.makeTimerSource(queue: queue)
        beat.schedule(deadline: .now() + 0.2, repeating: 2)
        beat.setEventHandler { [weak self] in self?.sendNow() }
        timer = beat
        beat.resume()
    }

    func update(_ state: String) {
        queue.async { [weak self] in
            self?.state = state
            self?.sendNow()
        }
    }

    func stop() {
        timer?.cancel(); timer = nil
        connection?.cancel(); connection = nil
        ready = false
    }

    private func sendNow() {
        guard ready, let connection else { return }
        connection.send(content: RemoteStatusPacket.encode(state), completion: .contentProcessed { _ in })
    }
}

// MARK: - 角色切换控制（iPhone → iPad）

/// iPhone 从「投到 iPad」切回「本机显示」时，先让 iPad 主动收掉接收端，
/// 否则 iOS 侧可能还握着到 iPad 的 CarPlay 控制连接，本机探针就会一直
/// 卡在「等待 TCP 连接」。
enum RemoteControlPacket {
    static let prefix = "STOCKSCP2"
    static let port: UInt16 = 7002

    static func encode(_ command: String) -> Data {
        Data("\(prefix)|\(command)|\(Int(Date().timeIntervalSince1970))".utf8)
    }

    static func decode(_ data: Data) -> String? {
        let text = String(data: data, encoding: .utf8) ?? ""
        let parts = text.split(separator: "|", maxSplits: 2).map(String.init)
        guard parts.count >= 2, parts[0] == prefix else { return nil }
        return parts[1]
    }
}

/// iPhone 只发一条 UDP，不等待回执；真正的释放由 iPad 关闭接收端完成。
enum RemoteControlSender {
    static func send(_ command: String, host: String) {
        let endpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: RemoteControlPacket.port) ?? .any
        )
        let connection = NWConnection(to: endpoint, using: .udp)
        let queue = DispatchQueue(label: "StocksLive.remoteControl.sender")
        connection.stateUpdateHandler = { state in
            if case .ready = state {
                connection.send(content: RemoteControlPacket.encode(command), completion: .contentProcessed { _ in
                    connection.cancel()
                })
            } else if case .failed = state {
                connection.cancel()
            }
        }
        connection.start(queue: queue)
    }
}

/// iPad 接收端监听 iPhone 的切换指令；收到 stop 后立刻收起 RTSP/媒体连接。
final class RemoteControlListener {
    private let queue = DispatchQueue(label: "StocksLive.remoteControl.listener")
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    var onCommand: ((String) -> Void)?

    func start(port: UInt16 = RemoteControlPacket.port) throws {
        stop()
        let candidate = try NWListener(using: .udp, on: NWEndpoint.Port(rawValue: port) ?? .any)
        listener = candidate
        candidate.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            let id = UUID()
            self.connections[id] = connection
            connection.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .failed, .cancelled:
                    self.connections.removeValue(forKey: id)
                default: break
                }
            }
            connection.start(queue: self.queue)
            self.receive(connection, id: id)
        }
        candidate.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.listener = nil }
        }
        candidate.start(queue: queue)
    }

    func stop() {
        connections.values.forEach { $0.cancel() }; connections.removeAll()
        listener?.cancel(); listener = nil
    }

    private func receive(_ connection: NWConnection, id: UUID) {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, let command = RemoteControlPacket.decode(data) {
                DispatchQueue.main.async { self.onCommand?(command) }
            }
            if error == nil {
                self.receive(connection, id: id)
            } else {
                self.connections.removeValue(forKey: id)
            }
        }
    }
}
