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

/// iPhone 端监听接收端心跳；6 秒没有任何包就报 lost。
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
            guard let self, !self.reportedLost, Date().timeIntervalSince(self.lastPacketAt) > 6 else { return }
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
