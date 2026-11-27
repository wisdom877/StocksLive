// SPDX-License-Identifier: AGPL-3.0-only
// 从 CarWithin 的 ReceiverConfiguration 裁剪而来，只保留「本机 CarPlay」需要的字段。
// 上游：https://github.com/xmz28/CarWithin（AGPL-3.0-only）
import Foundation
import Darwin
import Security

struct ReceiverConfiguration {
    var name = "黄杨工作台"
    static let discoveryType = "_tds-carkit._tcp."
    var address: String
    var ssid: String
    var password: String
    var port: UInt16 = 7000
    var width = 1280
    var height = 720
    var maxFPS = 30
    var videoCodec: VideoCodec = .h264
    var wifiChannel: UInt8 = 36
    var audioEnabled = true
    var rightHandDrive = false
    var widthPhysicalMM = CarPlayInfo.defaultWidthPhysicalMM
    var oemIconPNG: Data?
    var oemIconLabel = "黄杨工作台"
    let deviceID: String

    /// 本机 Wi-Fi（en0）上的 IPv4；CarPlay 会话只在这个地址上等 iPhone 回连。
    static func wifiIPv4Address() -> String? {
        localIPv4Addresses(interface: "en0").first
    }

    static func localIPv4Addresses(interface: String? = nil) -> [String] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return [] }
        defer { freeifaddrs(first) }
        var result: [String] = []
        var current = first
        while let entry = current {
            defer { current = entry.pointee.ifa_next }
            let name = String(cString: entry.pointee.ifa_name)
            guard interface == nil || interface == name,
                  let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.pointee.ifa_flags & UInt32(IFF_UP) != 0,
                  entry.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                let value = String(cString: host)
                if interface != nil && (value.hasPrefix("169.254.") || value.hasPrefix("0.")) { continue }
                if name == "en0" { result.insert(value, at: 0) } else { result.append(value) }
            }
        }
        return result
    }

    static func persistentDeviceID() -> String {
        if let existing = UserDefaults.standard.string(forKey: "receiverDeviceID") { return existing }
        var random = [UInt8](repeating: 0, count: 6)
        _ = SecRandomCopyBytes(kSecRandomDefault, random.count, &random)
        random[0] = (random[0] | 2) & 0xfe
        let value = random.map { String(format: "%02X", $0) }.joined(separator: ":")
        UserDefaults.standard.set(value, forKey: "receiverDeviceID")
        return value
    }

    func validate() throws {
        var parsed = in_addr()
        guard inet_pton(AF_INET, address, &parsed) == 1,
              Self.localIPv4Addresses().contains(address) else {
            throw ConfigurationError("请先连接 Wi-Fi；CarPlay 需要一个本机局域网地址。")
        }
        guard (320...3840).contains(width), (320...3840).contains(height),
              width % 2 == 0, height % 2 == 0,
              (30...60).contains(maxFPS), maxFPS % 5 == 0,
              (100...400).contains(widthPhysicalMM) else {
            throw ConfigurationError("画面参数超出支持范围。")
        }
        guard !ssid.isEmpty, ssid.utf8.count <= 32 else {
            throw ConfigurationError(ssid.isEmpty ? "请填写 Wi-Fi 名称。" : "Wi-Fi 名称不能超过 32 个 UTF-8 字节。")
        }
        guard password.isEmpty || (8...63).contains(password.utf8.count) else {
            throw ConfigurationError("请输入 8–63 字节的 Wi-Fi 密码，开放网络则留空。")
        }
    }
}

struct ConfigurationError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
