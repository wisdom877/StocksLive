import UIKit
import AVFoundation

/// Receives complete Annex-B access units; transport decryption/demux precedes this layer.
final class H264Surface: UIView {
    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
    private var display: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
    var pictureInPictureLayer: AVSampleBufferDisplayLayer { display }
    var isReadyForPictureInPicture: Bool {
        guard videoSize != .zero, !awaitingKeyframeMirror, !isHidden, window != nil, !bounds.isEmpty else { return false }
        if #available(iOS 17.4, *) { return display.isReadyForDisplay }
        return hasPublishedFrame
    }
    lazy var touchOwnershipGestureRecognizer: UILongPressGestureRecognizer = {
        let gesture = UILongPressGestureRecognizer(target: self, action: #selector(holdTouchOwnership(_:)))
        gesture.minimumPressDuration = 0
        gesture.allowableMovement = 10_000
        gesture.cancelsTouchesInView = false
        return gesture
    }()

    // 解析、切分、拷贝、入队全部在这条串行队列上完成，主线程不再参与（P0-3）。
    private let videoQueue = DispatchQueue(label: "com.stocks.carplay.video", qos: .userInteractive)
    private var format: CMVideoFormatDescription?
    private var parameters: VideoParameterSets?
    private var pending: [(CMSampleBuffer, Int)] = []
    private var pendingBytes = 0
    private var pendingSince: TimeInterval?
    /// Target cadence used only as the step between consecutive frames. Set on the main
    /// thread before the stream starts and never mutated afterwards.
    var frameRate: Double = 30
    private var nextStamp: CMTime?
    private var lastSlowLogAt: CFTimeInterval = 0
    private var requesting = false
    private var hasEnqueuedFrame = false
    private var firstFramePublished = false
    /// 主线程镜像：是否已经有帧进入显示层。
    private var hasPublishedFrame = false
    private var awaitingKeyframe = false
    private var awaitingKeyframeMirror = false
    private var suspended = false
    private var lastRecovery = -Double.infinity
    private var checkingDisplaySince: TimeInterval?
    /// 主线程镜像：视频像素尺寸，仅用于触控归一化与 PiP 就绪判断。
    private var videoSize: CGSize = .zero
    /// 主线程只读取的视频像素尺寸：外层用它把原生卡片收成画面本身的宽高比，
    /// 这样 19.5:9 / 21:9 的车机画面不会再被 16:9 的卡框硬塞出左右黑边。
    var pictureSize: CGSize { videoSize }
    /// 卡片尺寸本来就是按上面这个像素宽高比排的，此时用 .resize 直接铺满最干净：
    /// .resizeAspect 会再按 layer 的整数点尺寸算一次等比内缩，四舍五入后仍可能
    /// 在边上留出 1pt 的黑缝，淡色背景上看着就是一圈细黑边。
    /// 拿不到像素尺寸（还在等首帧）时退回 .resizeAspect，避免把画面拉变形。
    func matchCard(aspectKnown: Bool) {
        let want: AVLayerVideoGravity = aspectKnown ? .resize : .resizeAspect
        if display.videoGravity != want { display.videoGravity = want }
    }
    private var statFrames = 0
    private var statSkips = 0
    private var statFlushes = 0
    private var statWindowStart = ProcessInfo.processInfo.systemUptime
    private var statWindowFrames = 0
    private var statKeyWaitStart: TimeInterval?
    private var statKeyWaitMs = 0
    private var statWindowBytes = 0
    private var statWindowBytesSince = ProcessInfo.processInfo.systemUptime
    private var statGaps: [Double] = []
    private var statLastArrival: TimeInterval?
    private var rendererNeedsRecovery: Bool { display.requiresFlushToResumeDecoding || display.status == .failed }
    var onLog: ((String) -> Void)?
    /// Every finger currently on the surface, normalized to the video picture (0…1).
    var onTouches: (([TouchPoint]) -> Void)?
    /// Called whenever the renderer discarded frames and can only resume at a new keyframe.
    var onKeyframeNeeded: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        // 透明底：画面比例和卡片不一致时露出来的那条，应该让网页背景透上来，而不是刷成黑边。
        backgroundColor = .clear
        display.videoGravity = .resizeAspect
        isUserInteractionEnabled = true
        isMultipleTouchEnabled = true
        addGestureRecognizer(touchOwnershipGestureRecognizer)
        NotificationCenter.default.addObserver(self, selector: #selector(decodeFailed(_:)),
            name: .AVSampleBufferDisplayLayerFailedToDecode, object: display)
        NotificationCenter.default.addObserver(self, selector: #selector(rendererFlushChanged),
            name: .AVSampleBufferDisplayLayerRequiresFlushToResumeDecodingDidChange, object: display)
    }

    @objc private func decodeFailed(_ note: Notification) {
        let error = note.userInfo?[AVSampleBufferDisplayLayerFailedToDecodeNotificationErrorKey] as? NSError
        let detail = String(describing: error.map { "（\($0.code)）" } ?? "")
        videoQueue.async { [weak self] in
            guard let self, !self.suspended, self.format != nil, self.rendererNeedsRecovery,
                  ProcessInfo.processInfo.systemUptime - self.lastRecovery >= 0.5 else { return }
            self.recover(reason: CWL("本机解码失败{1}", [detail]))
        }
    }

    @objc private func rendererFlushChanged() {
        videoQueue.async { [weak self] in
            guard let self, !self.suspended, self.format != nil, self.display.requiresFlushToResumeDecoding,
                  ProcessInfo.processInfo.systemUptime - self.lastRecovery >= 0.5 else { return }
            self.recover(reason: CWL("系统要求恢复视频解码"))
        }
    }

    /// Must run on `videoQueue`.
    private func recover(reason: String) {
        guard !suspended else { return }
        statFlushes += 1
        display.stopRequestingMediaData(); requesting = false
        pending.removeAll(); pendingBytes = 0; pendingSince = nil
        display.flush()
        hasEnqueuedFrame = false
        checkingDisplaySince = nil
        nextStamp = nil
        statKeyWaitStart = ProcessInfo.processInfo.systemUptime
        lastRecovery = ProcessInfo.processInfo.systemUptime
        if !awaitingKeyframe { onLog?(CWL("视频渲染器将在下一个关键帧恢复：{1}", [String(describing: reason)])) }
        awaitingKeyframe = true
        awaitingKeyframeMirror = true
        onKeyframeNeeded?(reason)
    }

    required init?(coder: NSCoder) { fatalError(CWL("不支持从 Storyboard 创建 H264Surface")) }

    @objc private func holdTouchOwnership(_ gesture: UILongPressGestureRecognizer) {
        // The recognizer intentionally does no work. It prevents the parent scroll view
        // from cancelling a CarPlay drag while raw touch callbacks keep their HID semantics.
    }

    /// Frames were skipped while the app was in the background: start again at a fresh keyframe.
    func resumeAfterBackground(skippedFrames: Bool) {
        videoQueue.async { [weak self] in
            guard let self else { return }
            self.suspended = false
            self.nextStamp = nil
            guard self.format != nil else { return }
            if skippedFrames || self.rendererNeedsRecovery {
                self.recover(reason: CWL("回到前台"))
            } else if self.awaitingKeyframe {
                self.onKeyframeNeeded?(CWL("回到前台等待关键帧"))
            }
            if #available(iOS 17.4, *), !self.display.isReadyForDisplay {
                self.checkingDisplaySince = ProcessInfo.processInfo.systemUptime
                self.onKeyframeNeeded?(CWL("回到前台等待显示"))
            }
        }
    }

    func reset() {
        DispatchQueue.main.async { [weak self] in self?.releaseAllTouches() }
        videoQueue.async { [weak self] in
            guard let self else { return }
            self.suspended = false
            self.checkingDisplaySince = nil; self.lastRecovery = -.infinity
            self.display.stopRequestingMediaData(); self.requesting = false
            self.pending.removeAll(); self.pendingBytes = 0; self.pendingSince = nil
            self.awaitingKeyframe = false; self.awaitingKeyframeMirror = false
            self.nextStamp = nil
            self.display.flushAndRemoveImage(); self.format = nil; self.parameters = nil; self.hasEnqueuedFrame = false
            self.firstFramePublished = false
            DispatchQueue.main.async { [weak self] in
                self?.videoSize = .zero
                self?.hasPublishedFrame = false
            }
        }
    }

    private func makeFormat(_ sets: VideoParameterSets) throws -> CMVideoFormatDescription {
        let units = sets.ordered.map { $0 as NSData }
        let pointers = units.map { $0.bytes.assumingMemoryBound(to: UInt8.self) }
        let sizes = units.map(\.length)
        var description: CMVideoFormatDescription?
        let status: OSStatus
        switch sets.codec {
        case .h264:
            status = CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: kCFAllocatorDefault,
                parameterSetCount: pointers.count, parameterSetPointers: pointers, parameterSetSizes: sizes,
                nalUnitHeaderLength: 4, formatDescriptionOut: &description)
        case .h265:
            status = CMVideoFormatDescriptionCreateFromHEVCParameterSets(allocator: kCFAllocatorDefault,
                parameterSetCount: pointers.count, parameterSetPointers: pointers, parameterSetSizes: sizes,
                nalUnitHeaderLength: 4, extensions: nil, formatDescriptionOut: &description)
        }
        guard status == noErr, let description else {
            throw ProtocolError.malformed(CWL("{1} 参数无效（{2}）", [String(describing: sets.codec.displayName), String(describing: status)]))
        }
        return description
    }

    func enqueue(accessUnit: Data, codec: VideoCodec) throws {
        let arrived = ProcessInfo.processInfo.systemUptime
        videoQueue.async { [weak self] in
            guard let self else { return }
            self.statWindowBytes += accessUnit.count
            if let last = self.statLastArrival {
                let gap = (arrived - last) * 1000
                if gap > 0, gap < 1200 {
                    self.statGaps.append(gap)
                    if self.statGaps.count > 180 { self.statGaps.removeFirst() }
                }
            }
            self.statLastArrival = arrived
            do { try self.ingest(accessUnit: accessUnit, codec: codec) }
            catch { self.onLog?(CWL("视频帧解析失败：{1}", [String(describing: error.localizedDescription)])) }
        }
    }

    /// 真正的解析与入队，只在 `videoQueue` 上执行。
    private func ingest(accessUnit: Data, codec: VideoCodec) throws {
        guard !suspended else { return }
        let startedAt = CACurrentMediaTime()
        // While waiting for an IDR, discard P-frames before splitting them: a full
        // Annex-B pass on every skipped frame is the largest avoidable cost.
        if awaitingKeyframe, !AnnexB.containsRandomAccess(accessUnit, codec: codec) {
            statSkips += 1
            return
        }
        let units = try AnnexB.units(in: accessUnit)
        if parameters?.codec != codec { parameters = VideoParameterSets(codec: codec); format = nil }
        var picture: [Data] = []
        var changed = false
        for unit in units {
            if codec.parameterSet(unit) != nil { if parameters!.absorb(unit) { changed = true } }
            else { picture.append(unit) }
        }
        if changed || format == nil, let sets = parameters, sets.isComplete {
            let newFormat = try makeFormat(sets)
            display.stopRequestingMediaData(); requesting = false
            pending.removeAll(); pendingBytes = 0; pendingSince = nil
            nextStamp = nil
            display.flush(); format = newFormat
            let dimensions = CMVideoFormatDescriptionGetDimensions(newFormat)
            let pixelSize = CGSize(width: CGFloat(dimensions.width), height: CGFloat(dimensions.height))
            DispatchQueue.main.async { [weak self] in self?.videoSize = pixelSize }
            onLog?(CWL("本机显示层使用 {1}", [String(describing: codec.displayName)]))
        }
        guard !picture.isEmpty else { return }
        guard let format else {
            // Parameter sets were lost (e.g. after a reset); only a new IDR carries them again.
            if !awaitingKeyframe {
                awaitingKeyframe = true; awaitingKeyframeMirror = true
                statKeyWaitStart = ProcessInfo.processInfo.systemUptime
                onKeyframeNeeded?(CWL("缺少参数集"))
            }
            return
        }
        let keyframe = picture.contains { codec.isRandomAccess($0) }
        let now = ProcessInfo.processInfo.systemUptime
        if rendererNeedsRecovery {
            // During lock transitions the decoder may stay unavailable for a short time.
            guard now - lastRecovery >= 0.5 else { return }
            recover(reason: CWL("显示层需要恢复：{1}", [String(describing: display.error?.localizedDescription ?? CWL("系统状态变化"))]))
            guard !rendererNeedsRecovery else { return }
        } else if pendingBytes > 16 * 1024 * 1024 || pendingAge(now) > 1.2 {
            // 按时间而不是按帧数判断积压：30fps 与 60fps 下同一阈值含义一致（P0-2）。
            recover(reason: CWL("显示积压 {1} 帧 / {2} ms",
                [String(describing: pending.count), String(format: "%.0f", pendingAge(now) * 1000)]))
        } else if #available(iOS 17.4, *) {
            if display.isReadyForDisplay {
                checkingDisplaySince = nil
            } else if hasEnqueuedFrame {
                let started = checkingDisplaySince ?? now
                checkingDisplaySince = started
                if now - started >= 1.5, now - lastRecovery >= 1.5 {
                    recover(reason: CWL("收到视频帧后显示层仍未就绪"))
                }
            }
        }
        if awaitingKeyframe {
            guard keyframe else { statSkips += 1; return }
            awaitingKeyframe = false
            awaitingKeyframeMirror = false
            if let since = statKeyWaitStart { statKeyWaitMs = Int((now - since) * 1000) }
            statKeyWaitStart = nil
        }
        let bytes = try AnnexB.lengthPrefixed(picture)
        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
            blockLength: bytes.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: bytes.count, flags: 0, blockBufferOut: &block)
        guard status == noErr, let block else { throw ProtocolError.malformed(CWL("无法分配视频缓冲区")) }
        status = bytes.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes.count) }
        guard status == noErr else { throw ProtocolError.malformed(CWL("无法写入视频缓冲区")) }
        var sample: CMSampleBuffer?
        var size = bytes.count
        // 时间戳以“到达时间 + 有界前瞻”生成：任何一帧都不允许比现在超前超过
        // 150ms。这样即使流是 60fps 而声明 30fps，也不会每秒攒出一秒的账（P0-1）。
        let interval = CMTime(seconds: 1.0 / max(frameRate, 1), preferredTimescale: 1_000_000)
        let lead = CMTime(seconds: 0.05, preferredTimescale: 1_000_000)
        let maxLead = CMTime(seconds: 0.15, preferredTimescale: 1_000_000)
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        var stamp = CMTimeAdd(hostNow, lead)
        if let next = nextStamp {
            let candidate = CMTimeAdd(next, interval)
            if CMTimeCompare(candidate, stamp) > 0 { stamp = candidate }
        }
        if CMTimeCompare(CMTimeSubtract(stamp, hostNow), maxLead) > 0 {
            stamp = CMTimeAdd(hostNow, maxLead)
        }
        nextStamp = stamp
        var timing = CMSampleTimingInfo(duration: interval,
            presentationTimeStamp: stamp, decodeTimeStamp: .invalid)
        status = CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
            sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
        guard status == noErr, let sample else { throw ProtocolError.malformed(CWL("无法创建视频帧")) }
        if pending.isEmpty { pendingSince = now }
        pending.append((sample, bytes.count)); pendingBytes += bytes.count
        statFrames += 1; statWindowFrames += 1
        // Retain dependent compressed frames until the decoder is ready. Dropping
        // an arbitrary P-frame corrupts every dependent frame up to the next IDR.
        if !requesting {
            requesting = true
            display.requestMediaDataWhenReady(on: videoQueue) { [weak self] in self?.drain() }
        }
        let cost = CACurrentMediaTime() - startedAt
        if cost >= 0.008, CACurrentMediaTime() - lastSlowLogAt >= 1 {
            lastSlowLogAt = CACurrentMediaTime()
            onLog?(CWL("视频帧解析耗时 {1} ms（待显示 {2} 帧）",
                [String(format: "%.1f", cost * 1000), String(describing: pending.count)]))
        }
    }

    private func pendingAge(_ now: TimeInterval) -> TimeInterval {
        guard let since = pendingSince else { return 0 }
        return now - since
    }

    func suspendForExternalOutput() {
        videoQueue.async { [weak self] in
            guard let self else { return }
            self.suspended = true
            self.display.stopRequestingMediaData(); self.requesting = false
            self.pending.removeAll(); self.pendingBytes = 0; self.pendingSince = nil
            self.nextStamp = nil
            self.display.flush()
        }
    }

    private func drain() {
        guard !suspended else { return }
        while display.isReadyForMoreMediaData, !pending.isEmpty {
            let (sample, bytes) = pending.removeFirst(); pendingBytes -= bytes
            display.enqueue(sample)
            hasEnqueuedFrame = true
            if !firstFramePublished {
                firstFramePublished = true
                DispatchQueue.main.async { [weak self] in self?.hasPublishedFrame = true }
            }
        }
        if pending.isEmpty {
            pendingSince = nil
            display.stopRequestingMediaData(); requesting = false
        }
    }

    /// 每秒一行的运行状态，供 CarPlay 页显示与验收（P0-4）。
    func statsLine() -> String {
        let uptime = ProcessInfo.processInfo.systemUptime
        let demux = VideoTelemetry.shared.demuxP95()
        let snapshot = videoQueue.sync { () -> (Double, Int, Int, Int, Int, Int, Double, Double, Double) in
            let window = max(uptime - statWindowStart, 0.001)
            let fps = Double(statWindowFrames) / window
            let byteWindow = max(uptime - statWindowBytesSince, 0.001)
            let mbit = Double(statWindowBytes) * 8 / byteWindow / 1_000_000
            let gaps = statGaps.sorted()
            let p95 = gaps.isEmpty ? 0 : gaps[min(gaps.count - 1, Int(Double(gaps.count - 1) * 0.95))]
            let maxGap = gaps.last ?? 0
            statWindowStart = uptime; statWindowFrames = 0
            statWindowBytes = 0; statWindowBytesSince = uptime
            return (fps, statFrames, statSkips, statFlushes, pending.count, statKeyWaitMs, p95, maxGap, mbit)
        }
        return String(format: "视频 %.0f fps · 累计 %d 帧 · 丢 %d · 恢复 %d · 待显示 %d · 关键帧等待 %d ms · 间隔 %.0f/%.0f ms · %.1f Mbps · 解析 %.1f ms",
                      snapshot.0, snapshot.1, snapshot.2, snapshot.3, snapshot.4, snapshot.5,
                      snapshot.6, snapshot.7, snapshot.8, demux.p95)
    }

    // Each UITouch keeps a small id from touchesBegan to touchesEnded, so a finger keeps its HID slot.
    private var fingers: [ObjectIdentifier: (id: Int, touch: UITouch)] = [:]
    private var nextFingerID = 0

    private func normalized(_ touch: UITouch) -> CGPoint? {
        guard videoSize != .zero else { return nil }
        let rect = AVMakeRect(aspectRatio: videoSize, insideRect: bounds)
        guard rect.width > 0, rect.height > 0 else { return nil }
        let point = touch.location(in: self)
        return CGPoint(x: min(max((point.x - rect.minX) / rect.width, 0), 1),
                       y: min(max((point.y - rect.minY) / rect.height, 0), 1))
    }

    private func publish() {
        let points = fingers.values.sorted { $0.id < $1.id }.compactMap { finger in
            normalized(finger.touch).map { TouchPoint(id: finger.id, x: $0.x, y: $0.y) }
        }
        onTouches?(points)
    }

    /// Releases every finger, e.g. when the view leaves the screen mid-gesture.
    func releaseAllTouches() {
        guard !fingers.isEmpty else { return }
        fingers.removeAll(); onTouches?([])
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches {
            fingers[ObjectIdentifier(touch)] = (nextFingerID, touch); nextFingerID = (nextFingerID + 1) & 0xff
        }
        publish()
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { publish() }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        touches.forEach { fingers.removeValue(forKey: ObjectIdentifier($0)) }; publish()
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        touches.forEach { fingers.removeValue(forKey: ObjectIdentifier($0)) }; publish()
    }
}
