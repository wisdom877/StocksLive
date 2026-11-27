import Foundation

public enum AnnexB {
    /// Splits complete Annex-B access units into raw NAL units (without start codes).
    public static func units(in data: Data) throws -> [Data] {
        let bytes = [UInt8](data)
        guard bytes.count <= 8 * 1024 * 1024 else { throw ProtocolError.limitExceeded("video access unit") }
        var starts: [(Int, Int)] = []; var i = 0
        while i + 2 < bytes.count {
            if bytes[i] == 0, bytes[i + 1] == 0 {
                if bytes[i + 2] == 1 { starts.append((i, 3)); i += 3; continue }
                if i + 3 < bytes.count, bytes[i + 2] == 0, bytes[i + 3] == 1 {
                    starts.append((i, 4)); i += 4; continue
                }
            }
            i += 1
        }
        guard let first = starts.first, bytes.prefix(first.0).allSatisfy({ $0 == 0 }) else {
            throw ProtocolError.malformed("Annex B start code")
        }
        return try starts.enumerated().map { index, entry in
            let begin = entry.0 + entry.1
            let end = index + 1 < starts.count ? starts[index + 1].0 : bytes.count
            guard end > begin else { throw ProtocolError.malformed("empty NAL unit") }
            return Data(bytes[begin..<end])
        }
    }
    /// Cheap keyframe probe used on every access unit before the full NAL split.
    /// It only walks start codes and reads the first byte of each NAL header.
    public static func containsRandomAccess(_ data: Data, codec: VideoCodec) -> Bool {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self), raw.count >= 4 else { return false }
            let count = raw.count
            var i = 0
            while i + 3 < count {
                guard base[i] == 0, base[i + 1] == 0 else { i += 1; continue }
                let prefix: Int
                if base[i + 2] == 1 { prefix = 3 }
                else if base[i + 2] == 0, base[i + 3] == 1 { prefix = 4 }
                else { i += 1; continue }
                let header = i + prefix
                guard header < count else { return false }
                let first = base[header]
                let type = codec == .h264 ? first & 0x1f : (first >> 1) & 0x3f
                if codec == .h264 ? type == 5 : (16...21).contains(type) { return true }
                i = header + 1
            }
            return false
        }
    }

    public static func lengthPrefixed(_ units: [Data]) throws -> Data {
        var result = Data()
        for unit in units {
            guard !unit.isEmpty, unit.count <= 8 * 1024 * 1024 else { throw ProtocolError.malformed("NAL unit size") }
            result.putBE32(UInt32(unit.count)); result.append(unit)
        }
        return result
    }
}
