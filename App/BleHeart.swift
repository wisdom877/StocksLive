import Foundation
import CoreBluetooth
import WebKit

/// 蓝牙心率：直接当 BLE 中心（central）去收「标准心率服务」的广播。
/// 用途：Apple Watch 上跑一个会广播心率的 App（例如「心率广播」的手表模式），
/// 手表就是一个标准心率外设（0x180D / 0x2A37），我们这边 1Hz 收样本直接推给网页。
/// 不碰 HealthKit，也就不需要 healthkit 权限；只要蓝牙权限 + bluetooth-central 后台模式。
final class BleHeart: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let shared = BleHeart()

    private var central: CBCentralManager?
    private weak var web: WKWebView?
    private var target: CBPeripheral?
    private var measure: CBCharacteristic?
    private var lastBpm = 0
    private var lastPushAt = Date.distantPast
    private var scanningAll = false
    private var scanStartedAt = Date()
    private var retryWork: DispatchWorkItem?

    private let svcHR = CBUUID(string: "180D")      // Heart Rate
    private let chrHR = CBUUID(string: "2A37")      // Heart Rate Measurement

    func attach(_ view: WKWebView) {
        web = view
        start()
    }

    func start() {
        if let c = central {
            if c.state == .poweredOn { scan() }
            return
        }
        central = CBCentralManager(delegate: self, queue: .main,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
    }

    private func scan() {
        guard let c = central, c.state == .poweredOn else { return }
        if c.isScanning { c.stopScan() }
        scanningAll = false
        scanStartedAt = Date()
        // 先按服务过滤（省电、命中准）；8 秒没结果再放开扫全部，兜住那些只在名字里带 HR 的设备
        c.scanForPeripherals(withServices: [svcHR],
                             options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    }

    private func scanWide() {
        guard let c = central, c.state == .poweredOn, !scanningAll else { return }
        scanningAll = true
        c.stopScan()
        c.scanForPeripherals(withServices: nil,
                             options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            scan()
        case .unauthorized, .unsupported, .poweredOff:
            stopAndRetry(later: 4)
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        // 已经在连/连上了就别再抢
        if let t = target, t.state == .connected || t.state == .connecting { return }
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? p.name ?? ""
        let hasHR = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.contains(svcHR) ?? false
        // 放开扫描时要挑一下：广告里带心率服务，或者名字像心率设备（AW HRB / HRM / Polar / H10 …）
        if scanningAll && !hasHR {
            let upper = name.uppercased()
            let looksHR = upper.contains("HR") || upper.contains("POLAR") || upper.contains("H10")
                || upper.contains("HRM") || upper.contains("心率")
            if !looksHR { return }
        }
        target = p
        p.delegate = self
        central.stopScan()
        central.connect(p, options: nil)
        if !scanningAll && Date().timeIntervalSince(scanStartedAt) > 8 { scanWide() }
    }

    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([svcHR])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        target = nil
        scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        measure = nil
        target = nil
        scheduleReconnect()
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let svc = p.services?.first(where: { $0.uuid == svcHR }) else {
            central?.cancelPeripheralConnection(p)
            return
        }
        p.discoverCharacteristics([chrHR], for: svc)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor svc: CBService, error: Error?) {
        guard let ch = svc.characteristics?.first(where: { $0.uuid == chrHR }) else { return }
        measure = ch
        p.setNotifyValue(true, for: ch)
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard ch.uuid == chrHR, let d = ch.value, d.count >= 2 else { return }
        let flags = d[0]
        var bpm = Int(d[1])
        if flags & 0x01 != 0 {                    // bit0 = 1 → 16 位心率
            guard d.count >= 3 else { return }
            bpm = Int(UInt16(d[1]) | (UInt16(d[2]) << 8))
        }
        guard bpm >= 25, bpm <= 240 else { return }
        // 同一个数 1 秒内不重复推（有的设备会连着发好几帧相同的值）
        let now = Date()
        if bpm == lastBpm && now.timeIntervalSince(lastPushAt) < 1.0 { return }
        lastBpm = bpm
        lastPushAt = now
        let ms = Int(now.timeIntervalSince1970 * 1000)
        push("window.sbHrSample && window.sbHrSample(\(bpm), \(ms));")
    }

    // MARK: - helpers

    private func push(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.web?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func scheduleReconnect() {
        retryWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.scan() }
        retryWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: w)
    }

    private func stopAndRetry(later: Double) {
        central?.stopScan()
        retryWork?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.start() }
        retryWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + later, execute: w)
    }
}
