// SPDX-License-Identifier: AGPL-3.0-only
// 从 CarWithin 的 NativeReceiver 裁剪而来：只保留本机显示所需的一条链路
// （RTSP 控制 + 配对 + 媒体 + 触控），去掉 CarLife / 仪表 / BMS / 浏览器投屏 / AirPlay 输出。
// 上游：https://github.com/xmz28/CarWithin（AGPL-3.0-only）
import Foundation
import Network
import CoreGraphics

/// All listener/session state is confined to queue. UI callbacks are always main-thread.
final class CarPlayReceiver {
    private let queue = DispatchQueue(label: "StocksLive.carplay.receiver")
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var sessions: [UUID: SessionState] = [:]
    /// Access units handed to the main thread but not yet consumed. Over the limit, the local
    /// display skips to the next keyframe instead of dropping arbitrary (dependent) P-frames.
    private var localInFlight = 0
    private var localInFlightSince: DispatchTime?
    private var localSkipping = false
    private let maximumLocalInFlight = 12
    /// 主线程滞后超过这个毫秒数才认为“积压”。按时间判定，30/60fps 含义一致。
    private let localLagLimitMs = 150
    private var localVideoEnabled = true

    // forceKeyFrame state: throttled sends, resent every second until a keyframe arrives.
    private var keyframeWantedSince: DispatchTime?
    private var keyframeLastSent: DispatchTime?
    private var keyframeAttempts = 0
    private var keyframeReason = ""
    private var keyframeWatchdog: DispatchWorkItem?
    private var stalledNotified = false
    private var touchSlots = TouchSlots(count: CarPlayInfo.touchContacts)
    private var displaySize: (width: Int, height: Int)?
    private var nightMode: Bool?
    private var generation = UUID()
    private var airPlayIdentity: AirPlayCredentials?
    // NetService must be published/stopped on a thread with a run loop (main).
    private var discoveryService: NetService?

    var onLog: ((String) -> Void)?
    var onListening: ((UInt16) -> Void)?
    var onControlConnected: (() -> Void)?
    var onVideo: ((Data, VideoCodec) -> Void)?
    var onVideoClosed: (() -> Void)?
    var onVideoStalled: ((String) -> Void)?
    var onFailure: ((String) -> Void)?

    func setLocalVideoEnabled(_ enabled: Bool) {
        queue.async { [weak self] in
            self?.localVideoEnabled = enabled
            if !enabled { self?.localSkipping = false }
        }
    }

    /// 远端 iPad 的配置可能先写 720p，而 iPhone 实际协商到 1080p；
    /// 首帧到达后用真实像素尺寸校正触控坐标，避免画面正常但点不中。
    func setDisplaySize(width: Int, height: Int) {
        guard width > 1, height > 1 else { return }
        queue.async { [weak self] in
            self?.displaySize = (width, height)
        }
    }

    func start(configuration: ReceiverConfiguration, identity: AccessoryIdentity) {
        let listening = onListening
        queue.async { [weak self] in
            guard let self else { return }
            self.stopOnQueue()
            self.displaySize = (configuration.width, configuration.height)
            do { self.airPlayIdentity = try AirPlayCredentials() }
            catch { self.fail("AirPlay 身份创建失败：\(error.localizedDescription)"); return }
            if configuration.audioEnabled {
                do {
                    for bits: UInt64 in [0x10000000, 0x20000000, 0x40000000] {
                        let format = try ReceiverAudioFormat(bits: bits)
                        _ = try NativeAudioDecoder(format: format)
                        _ = try NativeOpusEncoder(rate: format.sampleRate)
                    }
                } catch { self.fail("无线音频编解码器不可用：\(error.localizedDescription)"); return }
            }
            self.log("请求 \(configuration.width)×\(configuration.height) @ \(configuration.maxFPS) FPS")
            self.listen(configuration: configuration, identity: identity, port: configuration.port, onReady: listening)
        }
    }

    private func listen(configuration: ReceiverConfiguration, identity: AccessoryIdentity, port: UInt16?, onReady: ((UInt16) -> Void)?) {
        let generation = self.generation
        do {
            let candidate = try NWListener(using: .tcp, on: port.flatMap(NWEndpoint.Port.init(rawValue:)) ?? .any)
            if let airPlayIdentity {
                let features = CarPlayInfo.features(audio: configuration.audioEnabled)
                let txt: [String: String] = ["deviceid": configuration.deviceID,
                    "features": String(format: "0x%x,0x%x", UInt32(truncatingIfNeeded: features), UInt32(truncatingIfNeeded: features >> 32)),
                    "flags": "0x4", "model": "StocksLive1,1", "srcvers": "509.11", "protovers": "1.1",
                    "pi": airPlayIdentity.identifier,
                    "pk": airPlayIdentity.signingKey.publicKey.rawRepresentation.map { String(format: "%02x", $0) }.joined()]
                candidate.service = NWListener.Service(name: configuration.name, type: "_airplay._tcp", txtRecord: NWTXTRecord(txt))
                candidate.serviceRegistrationUpdateHandler = { [weak self] change in self?.log("Bonjour 注册状态：\(change)") }
            }
            listener = candidate
            candidate.stateUpdateHandler = { [weak self, weak candidate] state in
                guard let self, let candidate, self.generation == generation, self.listener === candidate else { return }
                switch state {
                case .ready:
                    guard let actualPort = candidate.port?.rawValue else { self.fail("监听器未获得端口"); return }
                    self.log("原生 RTSP 监听器已在端口 \(actualPort) 就绪")
                    DispatchQueue.main.async { [weak self] in
                        guard let self else { return }
                        let service = NetService(domain: "local.", type: ReceiverConfiguration.discoveryType,
                            name: configuration.name, port: Int32(actualPort))
                        service.setTXTRecord(NetService.data(fromTXTRecord: [
                            "app": Data("StocksLive".utf8), "deviceid": Data(configuration.deviceID.utf8)]))
                        self.discoveryService?.stop(); self.discoveryService = service; service.publish()
                        self.onLog?("正在通过 \(ReceiverConfiguration.discoveryType) 发布 \(configuration.name)")
                        onReady?(actualPort)
                    }
                case .failed(let error):
                    if port != nil, case .posix(.EADDRINUSE) = error {
                        self.log("端口 \(port!) 已被占用，正在申请可用端口")
                        candidate.cancel(); self.listener = nil
                        self.listen(configuration: configuration, identity: identity, port: nil, onReady: onReady)
                    } else { self.fail("监听器失败：\(error.localizedDescription)") }
                default: break
                }
            }
            candidate.newConnectionHandler = { [weak self, weak candidate] connection in
                // 一个 iPad 车机只服务一台 iPhone；留 2 条给新旧控制连接交替，
                // 既不让第二台手机抢触控，也不至于重连瞬间被旧连接卡住。
                guard let self, self.generation == generation, self.listener === candidate,
                      self.connections.count < 2 else { connection.cancel(); return }
                let id = UUID(); self.connections[id] = connection
                let state = SessionState(credentials: self.airPlayIdentity)
                self.sessions[id] = state
                if case .hostPort(let host, _) = connection.endpoint { state.peerAddress = "\(host)" }
                connection.stateUpdateHandler = { [weak self, weak connection] update in
                    guard let self, let connection else { return }
                    switch update {
                    case .ready:
                        self.log("收到控制连接")
                        DispatchQueue.main.async { [weak self] in self?.onControlConnected?() }
                        self.receive(connection, id: id, state: state, configuration: configuration, identity: identity)
                    case .failed, .cancelled:
                        state.media?.stop(); self.sessions.removeValue(forKey: id); self.connections.removeValue(forKey: id)
                    default: break
                    }
                }
                connection.start(queue: self.queue)
            }
            candidate.start(queue: queue)
        } catch let error as NWError {
            if port != nil, case .posix(.EADDRINUSE) = error {
                log("端口 \(port!) 已被占用，正在申请可用端口")
                listen(configuration: configuration, identity: identity, port: nil, onReady: onReady)
            } else { fail("无法创建监听器：\(error.localizedDescription)") }
        } catch { fail("无法创建监听器：\(error)") }
    }

    private func fail(_ message: String) {
        log(message); stopOnQueue()
        DispatchQueue.main.async { [weak self] in self?.onFailure?(message) }
    }

    func stop() { queue.async { [weak self] in self?.stopOnQueue() } }

    private var activeMedia: CarPlayMediaSession? { sessions.values.first(where: { $0.media != nil })?.media }

    /// All fingers currently held by `source` (normalized 0…1); an empty list releases them.
    func touches(source: String, _ points: [TouchPoint]) {
        queue.async { [weak self] in
            guard let self, let size = self.displaySize else { return }
            let report = self.touchSlots.update(source: source, points: points)
            guard !report.isEmpty else { return }
            let contacts = report.map { entry in
                CarPlayInfo.TouchContact(slot: entry.slot,
                    x: UInt16(clamping: Int((min(max(entry.x, 0), 1) * Double(max(size.width - 1, 0))).rounded())),
                    y: UInt16(clamping: Int((min(max(entry.y, 0), 1) * Double(max(size.height - 1, 0))).rounded())),
                    down: entry.down)
            }
            self.activeMedia?.touch(contacts)
        }
    }

    /// Day/night appearance for CarPlay. Remembered across sessions and sent once the event channel is up.
    func setNightMode(_ night: Bool) {
        queue.async { [weak self] in
            guard let self, self.nightMode != night else { return }
            self.nightMode = night
            self.sessions.values.forEach { $0.media?.setNightMode(night) }
        }
    }

    /// Milliseconds since the oldest in-flight access unit was handed to the display.
    private func localLagMs() -> Int {
        guard let since = localInFlightSince else { return 0 }
        return Int((DispatchTime.now().uptimeNanoseconds - since.uptimeNanoseconds) / 1_000_000)
    }

    /// Thread-safe entry for the display layer when it needs a fresh keyframe.
    func requestKeyFrame(reason: String) {
        queue.async { [weak self] in self?.requestKeyFrameOnQueue(reason: reason) }
    }

    private func requestKeyFrameOnQueue(reason: String) {
        let now = DispatchTime.now()
        if keyframeWantedSince == nil {
            keyframeWantedSince = now; keyframeAttempts = 0; keyframeReason = reason
            armKeyframeWatchdog()
        }
        // 400 ms throttle: several recovery paths share one request, so a burst of
        // recover() calls cannot ask for repeated IDRs and spike the bitrate.
        if let last = keyframeLastSent, now.uptimeNanoseconds - last.uptimeNanoseconds < 400_000_000 { return }
        sendKeyFrameRequest()
    }

    private func sendKeyFrameRequest() {
        guard keyframeWantedSince != nil else { return }
        guard let media = sessions.values.first(where: { $0.media?.hasEventChannel == true })?.media else { return }
        keyframeAttempts += 1
        keyframeLastSent = .now()
        guard media.requestKeyFrame() else { return }
        if keyframeAttempts == 1 { log("已请求关键帧（\(keyframeReason)）") }
        guard keyframeAttempts < 4 else {
            log("iPhone 未响应关键帧请求（已重试 \(keyframeAttempts) 次），准备重启接收端")
            keyframeWantedSince = nil
            keyframeWatchdog?.cancel(); keyframeWatchdog = nil
            notifyStalled("关键帧请求 8 次未响应")
            return
        }
        let run = generation
        queue.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.generation == run, self.keyframeWantedSince != nil else { return }
            self.sendKeyFrameRequest()
        }
    }

    private func keyframeArrived() {
        guard let since = keyframeWantedSince else { return }
        keyframeWantedSince = nil
        keyframeWatchdog?.cancel(); keyframeWatchdog = nil
        stalledNotified = false
        let ms = (DispatchTime.now().uptimeNanoseconds - since.uptimeNanoseconds) / 1_000_000
        log("关键帧已到达（\(ms) ms，\(keyframeAttempts) 次请求）")
    }

    /// A watchdog independent of the event channel: even if forceKeyFrame cannot be
    /// sent, a session that has produced no recoverable picture for 9s is restarted
    /// instead of leaving the last frame frozen forever.
    private func armKeyframeWatchdog() {
        keyframeWatchdog?.cancel()
        let run = generation
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.generation == run, self.keyframeWantedSince != nil else { return }
            self.log("等待关键帧超过 9 秒，准备重启接收端")
            self.keyframeWantedSince = nil
            self.keyframeAttempts = 0
            self.keyframeWatchdog = nil
            self.notifyStalled("等待关键帧超时")
        }
        keyframeWatchdog = item
        queue.asyncAfter(deadline: .now() + 9, execute: item)
    }

    private func notifyStalled(_ reason: String) {
        guard !stalledNotified else { return }
        stalledNotified = true
        let run = generation
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == run else { return }
            self.onVideoStalled?(reason)
        }
    }

    private func stopOnQueue() {
        DispatchQueue.main.async { [weak self] in self?.discoveryService?.stop(); self?.discoveryService = nil }
        generation = UUID(); listener?.cancel(); listener = nil
        keyframeWatchdog?.cancel(); keyframeWatchdog = nil; stalledNotified = false
        localSkipping = false; keyframeWantedSince = nil; keyframeLastSent = nil; keyframeAttempts = 0
        touchSlots.reset()
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        sessions.values.forEach { $0.media?.stop() }; sessions.removeAll()
    }

    private final class SessionState {
        var parser = RTSPParser()
        var authenticated = false
        var setup: PairSetup?
        var verify: PairVerify?
        var cipher: ControlCipher?
        var media: CarPlayMediaSession?
        var peerAddress = ""
        init(credentials: AirPlayCredentials?) {
            if let credentials {
                setup = PairSetup(identifier: credentials.identifier, signingKey: credentials.signingKey) {
                    try credentials.saveController($0, key: $1)
                }
                verify = PairVerify(identifier: credentials.identifier, signingKey: credentials.signingKey) {
                    try? credentials.controller($0)
                }
            }
        }
    }

    private func receive(_ connection: NWConnection, id: UUID, state: SessionState,
                         configuration: ReceiverConfiguration, identity: AccessoryIdentity) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 32768) { [weak self] data, _, complete, error in
            guard let self, self.connections[id] != nil else { return }
            do {
                if let data, !data.isEmpty {
                    var input = data
                    while true {
                        let plaintext = try state.cipher?.receive(input) ?? input
                        guard let request = try state.parser.append(plaintext, maximumRequests: 1).first else { break }
                        self.log("\(request.method) \(request.target.prefix(100)) [\(request.body.count) 字节]")
                        let response = try self.respond(request, state: state, configuration: configuration, identity: identity)
                        let encoded = response.encoded(for: request)
                        let wire = try state.cipher?.encrypt(encoded) ?? encoded
                        connection.send(content: wire, completion: .contentProcessed { [weak self] error in
                            if let error { self?.log("控制通道写入失败：\(error.localizedDescription)"); connection.cancel() }
                        })
                        input = Data()
                        if state.cipher == nil, let keys = state.verify?.keys {
                            // M4 is plaintext. Only subsequent bytes use the negotiated record keys.
                            state.cipher = ControlCipher(readKey: keys.read, writeKey: keys.write)
                            input = state.parser.takeBufferedData()
                            self.log("Pair-Verify 已通过，已启用加密控制")
                        }
                    }
                }
                if complete || error != nil { connection.cancel(); self.connections.removeValue(forKey: id) }
                else { self.receive(connection, id: id, state: state, configuration: configuration, identity: identity) }
            } catch {
                self.log("控制连接被拒绝：\(error)"); connection.cancel(); self.connections.removeValue(forKey: id)
            }
        }
    }

    private func respond(_ request: RTSPRequest, state: SessionState, configuration: ReceiverConfiguration,
                         identity: AccessoryIdentity) throws -> RTSPResponse {
        switch (request.method, request.target.components(separatedBy: "?")[0]) {
        case ("OPTIONS", _): return RTSPResponse()
        case ("SETUP", _):
            guard state.cipher != nil, state.authenticated, let secret = state.verify?.mediaSecret else {
                throw ProtocolError.malformed("在配件会话通过验证前收到 SETUP")
            }
            if state.media == nil {
                let media = CarPlayMediaSession(queue: queue, secret: secret, peerAddress: state.peerAddress,
                                                audioEnabled: configuration.audioEnabled, hevc: configuration.videoCodec == .h265)
                media.onLog = { [weak self] in self?.log($0) }
                if let nightMode { media.setNightMode(nightMode) }
                let run = generation
                media.onVideoClosed = { [weak self] in
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.generation == run else { return }
                        self.onVideoClosed?()
                    }
                }
                media.onVideo = { [weak self] data, codec in
                    guard let self else { return }
                    let keyframe = AnnexB.containsRandomAccess(data, codec: codec)
                    if keyframe { self.keyframeArrived() }
                    guard self.localVideoEnabled else { return }
                    if self.localSkipping {
                        guard keyframe, self.localInFlight < self.maximumLocalInFlight / 2 else { return }
                        self.localSkipping = false
                    } else if !keyframe, self.localLagMs() > self.localLagLimitMs {
                        self.localSkipping = true
                        self.requestKeyFrameOnQueue(reason: "本机显示积压")
                        return
                    }
                    if self.localInFlight == 0 { self.localInFlightSince = .now() }
                    self.localInFlight += 1
                    DispatchQueue.main.async { [weak self] in
                        self?.onVideo?(data, codec)
                        self?.queue.async { [weak self] in
                            guard let self else { return }
                            self.localInFlight = max(0, self.localInFlight - 1)
                            if self.localInFlight == 0 { self.localInFlightSince = nil }
                        }
                    }
                }
                state.media = media
            }
            return RTSPResponse(body: try state.media!.setup(request.body), contentType: "application/x-apple-binary-plist")
        case ("RECORD", _):
            guard state.media != nil else { throw ProtocolError.malformed("在 SETUP 前收到 RECORD") }
            log("已接受 CarPlay RECORD，正在等待视频")
            return RTSPResponse()
        case ("POST", "/pair-setup"):
            guard state.cipher == nil, let setup = state.setup else { throw ProtocolError.malformed("pair-setup 不可用") }
            let fields = try TLV8.decode(request.body)
            log("Pair-Setup 状态 \(fields[6]?.first ?? 0)，方法 \(fields[0]?.first.map(String.init) ?? "缺失")")
            let body = try setup.handle(request.body)
            if setup.complete { log("Pair-Setup 已完成，已保存通过验证的控制端") }
            return RTSPResponse(body: body, contentType: "application/pairing+tlv8")
        case ("POST", "/pair-verify"):
            guard state.cipher == nil, let verify = state.verify else { throw ProtocolError.malformed("pair-verify 不可用") }
            return RTSPResponse(body: try verify.handle(request.body), contentType: "application/pairing+tlv8")
        case ("GET", "/info"), ("POST", "/info"):
            let info = CarPlayInfo.build(configuration)
            return RTSPResponse(body: try PropertyListSerialization.data(fromPropertyList: info, format: .binary, options: 0),
                                contentType: "application/x-apple-binary-plist")
        case ("POST", "/auth-setup"):
            let body = try MFiSAP.respond(to: request.body, identity: identity)
            state.authenticated = true
            log("已生成 MFiSAP 响应，正在等待 iPhone 接受")
            return RTSPResponse(body: body)
        case ("POST", "/feedback"):
            if let feedback = try state.media?.feedback() {
                return RTSPResponse(body: feedback, contentType: "application/x-apple-binary-plist")
            }
            return RTSPResponse()
        case ("POST", "/command"):
            guard state.cipher != nil else { throw ProtocolError.malformed("验证完成前收到 command") }
            if let command = try PropertyListSerialization.propertyList(from: request.body, format: nil) as? [String: Any] {
                let type = command["type"] as? String ?? "未知"
                log("CarPlay 命令：\(type)；字段：\(command.keys.sorted().joined(separator: ", "))")
            }
            return RTSPResponse()
        case ("TEARDOWN", _):
            if try state.media?.teardown(request.body) == true {
                state.media = nil
                log("CarPlay TEARDOWN：媒体已停止，控制连接保留")
            }
            return RTSPResponse()
        default:
            log("尚未实现：\(request.method) \(request.target.prefix(80))")
            return RTSPResponse(status: 501, reason: "Not Implemented")
        }
    }

    private func log(_ message: String) { DispatchQueue.main.async { [weak self] in self?.onLog?(message) } }
}
