// SPDX-License-Identifier: GPL-3.0-or-later
// AirPlay screen framing adapted from PlayPort ScreenStream.kt.
import Foundation
import CryptoKit
import QuartzCore

/// 一条视频记录：Annex-B 访问单元，外加从流头里解析到的 iPhone 时钟时间戳（解析不到就是 nil）。
public struct ScreenUnit {
    public let data: Data
    public let streamTime: Double?
}

public final class ScreenStream {
    private let key: SymmetricKey
    private var buffer = Data()
    /// 已消费到 buffer 的哪个位置。避免每帧把剩余缓冲整段重拷（P1-3）。
    private var cursor = 0
    private var counter: UInt64 = 0
    private var failed = false
    private var lastStreamTime: Double?
    private var dumpedHeaders = 0
    private var reportedTimestamp = false
    /// 设备时钟的口径修正：NTP 秒（1900 起）→ Unix 秒。
    private static let ntpEpoch: Double = 2_208_988_800
    public private(set) var codec: VideoCodec = .h264
    var onLog: ((String) -> Void)?
    public init(secret: SymmetricKey, connectionID: UInt64) {
        key = PairVerify.derive(secret, salt: "DataStream-Salt\(connectionID)", info: "DataStream-Output-Encryption-Key")
    }

    /// Each returned access unit is Annex-B, including parameter-set configuration units.
    public func append(_ bytes: Data) throws -> [ScreenUnit] {
        guard !failed else { throw ProtocolError.malformed(CWL("视频流已关闭")) }
        let started = CACurrentMediaTime()
        var result: [ScreenUnit] = []
        do {
            guard buffer.count - cursor + bytes.count <= 8 * 1024 * 1024 + 128 + 65536 else {
                throw ProtocolError.limitExceeded(CWL("视频缓冲区"))
            }
            buffer.append(bytes)
            while buffer.count - cursor >= 128 {
                let hBase = cursor, bBase = cursor + 128
                let length = (0..<4).reduce(0) { $0 | (Int(buffer[hBase + $1]) << ($1 * 8)) }
                guard length <= 8 * 1024 * 1024 else { throw ProtocolError.limitExceeded(CWL("视频帧")) }
                guard buffer.count - cursor >= 128 + length else { break }
                let header = buffer[hBase..<bBase]
                let body = buffer[bBase..<(bBase + length)]
                let type = header[header.startIndex + 4]
                let consumed = 128 + length
                switch type {
                case 0:
                    guard body.count >= 16, counter < UInt64.max else { throw ProtocolError.malformed(CWL("加密视频帧")) }
                    if dumpedHeaders == 0 { dumpHeader(type, header) }
                    var nonce = Data(count: 4)
                    for shift in stride(from: 0, through: 56, by: 8) { nonce.append(UInt8(truncatingIfNeeded: counter >> shift)) }
                    let box = try ChaChaPoly.SealedBox(nonce: .init(data: nonce), ciphertext: body.dropLast(16), tag: body.suffix(16))
                    let plain = try ChaChaPoly.open(box, using: key, authenticating: header)
                    counter += 1
                    cursor += consumed
                    result.append(ScreenUnit(data: try Self.annexB(plain), streamTime: accept(streamTimestamp(header))))
                case 1:
                    // iOS can send a header-only configuration record before the next
                    // real codec configuration. Keep the previous codec and stream open.
                    guard !body.isEmpty else { cursor += consumed; continue }
                    let parsed: (VideoCodec, Data)
                    do { parsed = try Self.configuration(body) }
                    catch {
                        // Parameter sets are public stream metadata; the prefix identifies the record layout.
                        let prefix = body.prefix(24).map { String(format: "%02x", $0) }.joined()
                        throw ProtocolError.malformed(CWL("{1}（配置记录 {2} 字节：{3}）", [String(describing: error.localizedDescription), String(describing: body.count), String(describing: prefix)]))
                    }
                    self.codec = parsed.0
                    cursor += consumed
                    result.append(ScreenUnit(data: parsed.1, streamTime: nil))
                default:
                    // 时间戳 / 扩展记录本身没有画面，但头里可能带着这场会话的时间基准（P2）。
                    dumpHeader(type, header)
                    cursor += consumed
                }
            }
            if cursor > 0, cursor == buffer.count || cursor > 1 << 20 || cursor * 2 >= buffer.count {
                buffer.removeFirst(cursor); cursor = 0
            }
            VideoTelemetry.shared.recordDemux((CACurrentMediaTime() - started) * 1000)
            return result
        } catch {
            failed = true; buffer = Data(); cursor = 0
            VideoTelemetry.shared.recordDemux((CACurrentMediaTime() - started) * 1000)
            throw error
        }
    }

    // MARK: - 流内时间戳（P2）

    /// 只在前三条记录上打头，用来确认时间戳字段落在哪个偏移；验证失败就完全不影响原有节拍。
    private func dumpHeader(_ type: UInt8, _ header: Data) {
        guard dumpedHeaders < 3 else { return }
        dumpedHeaders += 1
        let hex = header.prefix(48).map { String(format: "%02x", $0) }.joined(separator: " ")
        onLog?(CWL("视频记录头 {1}：{2}", [String(describing: type), hex]))
    }

    /// AirPlay 屏幕流头里通常把时间戳放在偏移 8 或 16，格式是 NTP（32 位秒 + 32 位小数）。
    private func streamTimestamp(_ header: Data) -> Double? {
        for offset in [8, 16] {
            guard header.count >= offset + 8 else { continue }
            let base = header.startIndex + offset
            let hi = UInt32(header[base]) << 24 | UInt32(header[base + 1]) << 16
                | UInt32(header[base + 2]) << 8 | UInt32(header[base + 3])
            let lo = UInt32(header[base + 4]) << 24 | UInt32(header[base + 5]) << 16
                | UInt32(header[base + 6]) << 8 | UInt32(header[base + 7])
            let epoch = Double(hi) - Self.ntpEpoch + Double(lo) / 4_294_967_296
            // 只接受“像一个真实时钟”的值：在 2023 年之后、且不超过当前时间一天。
            if epoch > 1_700_000_000, epoch < Date().timeIntervalSince1970 + 86_400 { return epoch }
        }
        return nil
    }

    /// 单调并且间隔合理才认，避免把别的 64 位字段当成时间。
    private func accept(_ stamp: Double?) -> Double? {
        guard let stamp else { return nil }
        if let last = lastStreamTime {
            let delta = stamp - last
            guard delta > 0.001, delta < 1 else { return nil }
        }
        lastStreamTime = stamp
        if !reportedTimestamp {
            reportedTimestamp = true
            onLog?(CWL("视频流内时间戳可用，当前 {1}", [String(format: "%.3f", stamp)]))
        }
        return stamp
    }

    private static func annexB(_ data: Data) throws -> Data {
        // H264Surface validates and splits the access unit. Avoid a second full
        // Annex-B pass here on the demux queue for every frame.
        if data.starts(with: [0, 0, 0, 1]) { return data }
        var offset = 0, output = Data()
        while offset < data.count {
            guard offset + 4 <= data.count else { throw ProtocolError.malformed(CWL("视频 NAL 长度")) }
            let length = Int(data.be32(offset)); offset += 4
            guard length > 0, length <= data.count - offset else { throw ProtocolError.malformed(CWL("视频 NAL 内容")) }
            output.append(contentsOf: [0, 0, 0, 1]); output.append(data.dropFirst(offset).prefix(length)); offset += length
        }
        return output
    }
    /// Converts an avcC or hvcC record, optionally inside its MP4 box, to Annex-B parameter sets.
    static func configuration(_ body: Data) throws -> (VideoCodec, Data) {
        if let marker = body.range(of: Data("hvcC".utf8)) {
            return (.h265, try hevcConfiguration(Data(body[marker.upperBound...])))
        }
        if let marker = body.range(of: Data("avcC".utf8)) {
            return (.h264, try avcConfiguration(Data(body[marker.upperBound...])))
        }
        // A bare AVC record carries an SPS (type 7) right after its 8-byte header.
        let looksAVC = body.count >= 9 && body.byte(5) & 0x1f >= 1 && body.byte(8) & 0x1f == 7
        return looksAVC ? (.h264, try avcConfiguration(body)) : (.h265, try hevcConfiguration(body))
    }
    private static func avcConfiguration(_ data: Data) throws -> Data {
        guard data.count >= 7, data.byte(0) == 1, data.byte(4) & 3 == 3 else { throw ProtocolError.malformed(CWL("不支持的 AVC 配置")) }
        var offset = 6, output = Data()
        func readUnits(_ count: Int) throws {
            guard count > 0 else { throw ProtocolError.malformed(CWL("缺少 H.264 参数集")) }
            for _ in 0..<count {
                guard offset + 2 <= data.count else { throw ProtocolError.malformed(CWL("AVC 参数长度")) }
                let length = Int(data.be16(offset)); offset += 2
                guard length > 0, length <= data.count - offset else { throw ProtocolError.malformed(CWL("AVC 参数内容")) }
                output.append(contentsOf: [0, 0, 0, 1]); output.append(data.dropFirst(offset).prefix(length)); offset += length
            }
        }
        try readUnits(Int(data.byte(5) & 31))
        guard offset < data.count else { throw ProtocolError.malformed(CWL("缺少 AVC PPS 数量")) }
        let count = Int(data.byte(offset)); offset += 1; try readUnits(count)
        return output
    }
    private static func hevcConfiguration(_ data: Data) throws -> Data {
        guard data.count >= 23, data.byte(0) == 1, data.byte(21) & 3 == 3 else {
            throw ProtocolError.malformed(CWL("不支持的 HEVC 配置"))
        }
        var offset = 23, output = Data(), types = Set<UInt8>()
        for _ in 0..<Int(data.byte(22)) {
            guard offset + 3 <= data.count else { throw ProtocolError.malformed(CWL("HEVC 参数数组")) }
            let type = data.byte(offset) & 0x3f
            let count = Int(data.be16(offset + 1)); offset += 3
            for _ in 0..<count {
                guard offset + 2 <= data.count else { throw ProtocolError.malformed(CWL("HEVC 参数长度")) }
                let length = Int(data.be16(offset)); offset += 2
                guard length > 0, length <= data.count - offset else { throw ProtocolError.malformed(CWL("HEVC 参数内容")) }
                output.append(contentsOf: [0, 0, 0, 1]); output.append(data.dropFirst(offset).prefix(length)); offset += length
                types.insert(type)
            }
        }
        guard types.isSuperset(of: [32, 33, 34]) else { throw ProtocolError.malformed(CWL("缺少 HEVC VPS/SPS/PPS")) }
        return output
    }
}
