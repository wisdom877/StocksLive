import Foundation
import HealthKit
import WebKit

/// 把 HealthKit 里的训练相关数据喂给网页：心率实时推，其余指标每分钟汇总一次。
/// 网页在 iOS 里读不到健康数据，只能靠壳这边授权、查询、再 evaluateJavaScript 送进去。
///
/// 注意：HealthKit 需要「com.apple.developer.healthkit」权限（entitlements + 带该能力的描述文件）。
/// 自签名时如果描述文件没有这个能力，requestAuthorization 会直接失败，这里只回报状态，不崩。
final class HealthBridge: NSObject {
    static let shared = HealthBridge()

    private let store = HKHealthStore()
    private weak var webView: WKWebView?
    private var hrQuery: HKAnchoredObjectQuery?
    private var timer: Timer?
    private var started = false

    // MARK: - 读取范围

    /// 训练 / 心率 / 能量 / 睡眠 / 身体成分，能想到的基本都申请了；
    /// 系统只会给用户勾选的那几项，多申请不浪费。
    private var readTypes: Set<HKObjectType> {
        var set = Set<HKObjectType>()
        func q(_ id: HKQuantityTypeIdentifier) {
            if let t = HKObjectType.quantityType(forIdentifier: id) { set.insert(t) }
        }
        // 心率一族
        q(.heartRate); q(.restingHeartRate); q(.heartRateVariabilitySDNN)
        q(.walkingHeartRateAverage); q(.heartRateRecoveryOneMinute)
        // 活动 / 能量 / 步数
        q(.activeEnergyBurned); q(.basalEnergyBurned)
        q(.stepCount); q(.distanceWalkingRunning); q(.distanceCycling); q(.distanceSwimming)
        q(.distanceDownhillSnowSports); q(.flightsClimbed)
        q(.appleExerciseTime); q(.pushCount); q(.numberOfTimesFallen); q(.swimmingStrokeCount)
        // 体能
        q(.vo2Max); q(.sixMinuteWalkTestDistance); q(.walkingSpeed); q(.walkingStepLength)
        q(.stairAscentSpeed); q(.stairDescentSpeed)
        // 呼吸 / 血氧 / 体温 / 血压 / 血糖
        q(.respiratoryRate); q(.oxygenSaturation)
        q(.bodyTemperature); q(.basalBodyTemperature)
        q(.bloodPressureSystolic); q(.bloodPressureDiastolic); q(.bloodGlucose)
        // 身体成分
        q(.bodyMass); q(.bodyFatPercentage); q(.leanBodyMass); q(.height); q(.waistCircumference)
        // 饮食
        q(.dietaryEnergyConsumed); q(.dietaryProtein); q(.dietaryCarbohydrates)
        q(.dietaryFatTotal); q(.dietaryWater)
        // 睡眠 / 正念 / 站立 / 经期
        if let t = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) { set.insert(t) }
        if let t = HKObjectType.categoryType(forIdentifier: .appleStandHour) { set.insert(t) }
        if let t = HKObjectType.categoryType(forIdentifier: .mindfulSession) { set.insert(t) }
        if let t = HKObjectType.categoryType(forIdentifier: .menstrualFlow) { set.insert(t) }
        set.insert(HKObjectType.workoutType())
        if #available(iOS 17.0, *) {
            q(.timeInDaylight); q(.physicalEffort)
        }
        return set
    }

    // MARK: - 生命周期

    func attach(_ webView: WKWebView) {
        self.webView = webView
    }

    /// 网页点「开启健康数据」或页面加载完自己调一次都行；重复调用无副作用。
    func start() {
        guard HKHealthStore.isHealthDataAvailable() else {
            report(state: ["ok": false, "error": "这台设备没有健康数据"])
            return
        }
        if started {
            pushSnapshot()
            return
        }
        started = true
        store.requestAuthorization(toShare: [], read: readTypes) { [weak self] ok, err in
            guard let self = self else { return }
            if !ok || err != nil {
                let msg = Self.describe(err) ?? "健康权限没拿到（描述文件可能缺 HealthKit 能力）"
                self.report(state: ["ok": false, "error": msg])
                return
            }
            self.report(state: ["ok": true])
            DispatchQueue.main.async { self.startLiveHeartRate(); self.startTimer(); self.pushSnapshot() }
        }
    }

    private static func describe(_ err: Error?) -> String? {
        guard let err = err as NSError? else { return nil }
        if err.domain == HKErrorDomain {
            if err.code == HKError.errorAuthorizationDenied.rawValue { return "健康权限被拒绝，去 设置 → 健康 → 数据访问 里打开" }
            if err.code == HKError.errorAuthorizationNotDetermined.rawValue { return "健康权限未授权" }
        }
        return err.localizedDescription
    }

    private func startLiveHeartRate() {
        guard hrQuery == nil,
              let type = HKObjectType.quantityType(forIdentifier: .heartRate) else { return }
        let start = Date().addingTimeInterval(-3600)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)
        let unit = HKUnit.count().unitDivided(by: .minute())

        let handler: (HKAnchoredObjectQuery, [HKSample]?, [HKDeletedObject]?, HKQueryAnchor?, Error?) -> Void = {
            [weak self] _, samples, _, _, _ in
            guard let self = self, let list = samples as? [HKQuantitySample], !list.isEmpty else { return }
            for s in list {
                let bpm = s.quantity.doubleValue(for: unit)
                let ms = Int(s.endDate.timeIntervalSince1970 * 1000)
                self.push("window.sbHrSample && window.sbHrSample(\(String(format: "%.0f", bpm)), \(ms));")
            }
        }

        let q = HKAnchoredObjectQuery(type: type, predicate: predicate, anchor: nil, limit: 20, resultsHandler: handler)
        q.updateHandler = handler
        hrQuery = q
        store.execute(q)
    }

    private func startTimer() {
        guard timer == nil else { return }
        DispatchQueue.main.async {
            self.timer?.invalidate()
            self.timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
                self?.pushSnapshot()
            }
        }
    }

    // MARK: - 今日汇总

    private func pushSnapshot() {
        var metrics: [String: Double] = [:]
        let group = DispatchGroup()

        func sum(_ id: HKQuantityTypeIdentifier, _ key: String, _ unit: HKUnit) {
            guard let type = HKObjectType.quantityType(forIdentifier: id) else { return }
            group.enter()
            let predicate = HKQuery.predicateForSamples(withStart: Calendar.current.startOfDay(for: Date()),
                                                        end: Date(), options: .strictStartDate)
            let q = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate,
                                      options: .cumulativeSum) { _, stat, _ in
                if let v = stat?.sumQuantity()?.doubleValue(for: unit) { metrics[key] = v }
                group.leave()
            }
            store.execute(q)
        }

        func latest(_ id: HKQuantityTypeIdentifier, _ key: String, _ unit: HKUnit, within: TimeInterval = 86400) {
            guard let type = HKObjectType.quantityType(forIdentifier: id) else { return }
            group.enter()
            let predicate = HKQuery.predicateForSamples(withStart: Date().addingTimeInterval(-within), end: nil,
                                                        options: .strictStartDate)
            let q = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1,
                                  sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) { _, samples, _ in
                if let s = samples?.first as? HKQuantitySample { metrics[key] = s.quantity.doubleValue(for: unit) }
                group.leave()
            }
            store.execute(q)
        }

        sum(.activeEnergyBurned, "active_energy", .kilocalorie())
        sum(.basalEnergyBurned, "basal_energy", .kilocalorie())
        sum(.stepCount, "steps", .count())
        sum(.distanceWalkingRunning, "distance", .meterUnit(with: .kilo))
        sum(.distanceCycling, "cycling_km", .meterUnit(with: .kilo))
        sum(.flightsClimbed, "flights", .count())
        sum(.appleExerciseTime, "exercise_min", .minute())
        sum(.dietaryEnergyConsumed, "intake_energy", .kilocalorie())
        sum(.dietaryWater, "water_ml", .literUnit(with: .milli))

        latest(.heartRate, "hr_last", HKUnit.count().unitDivided(by: .minute()), within: 3600)
        latest(.restingHeartRate, "resting_hr", HKUnit.count().unitDivided(by: .minute()))
        latest(.heartRateVariabilitySDNN, "hrv", .secondUnit(with: .milli))
        latest(.walkingHeartRateAverage, "walking_hr", HKUnit.count().unitDivided(by: .minute()))
        latest(.vo2Max, "vo2max", HKUnit.literUnit(with: .milli).unitDivided(by: .gramUnit(with: .kilo).unitMultiplied(by: .minute())))
        latest(.respiratoryRate, "respiratory", HKUnit.count().unitDivided(by: .minute()))
        latest(.oxygenSaturation, "spo2", .percent())
        latest(.bodyMass, "weight", .gramUnit(with: .kilo))
        latest(.bodyFatPercentage, "body_fat", .percent())
        latest(.bodyTemperature, "temperature", .degreeCelsius())
        latest(.bloodPressureSystolic, "bp_systolic", .millimeterOfMercury())
        latest(.bloodPressureDiastolic, "bp_diastolic", .millimeterOfMercury())
        latest(.bloodGlucose, "glucose", .gramUnit(with: .milli).unitDivided(by: .literUnit(with: .deci)))
        latest(.walkingSpeed, "walking_speed", .meterUnit(with: .none).unitDivided(by: .second()))

        group.enter()
        let standType = HKObjectType.categoryType(forIdentifier: .appleStandHour)
        let standPredicate = HKQuery.predicateForSamples(withStart: Calendar.current.startOfDay(for: Date()),
                                                          end: Date(), options: .strictStartDate)
        let standQuery = HKSampleQuery(sampleType: standType!, predicate: standPredicate, limit: 200,
                                       sortDescriptors: nil) { _, samples, _ in
            let stood = (samples as? [HKCategorySample])?.filter {
                $0.value == HKCategoryValueAppleStandHour.stood.rawValue
            }.count ?? 0
            if stood > 0 { metrics["stand_hours"] = Double(stood) }
            group.leave()
        }
        store.execute(standQuery)

        group.enter()
        let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!
        let sleepPredicate = HKQuery.predicateForSamples(withStart: Calendar.current.startOfDay(for: Date()).addingTimeInterval(-6 * 3600),
                                                          end: Date(), options: .strictStartDate)
        let sleepQuery = HKSampleQuery(sampleType: sleepType, predicate: sleepPredicate, limit: 200,
                                       sortDescriptors: nil) { _, samples, _ in
            let asleep = (samples as? [HKCategorySample])?
                .filter { $0.value == HKCategoryValueSleepAnalysis.asleepCore.rawValue
                    || $0.value == HKCategoryValueSleepAnalysis.asleepDeep.rawValue
                    || $0.value == HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue
                    || $0.value == HKCategoryValueSleepAnalysis.asleepREM.rawValue }
                .reduce(0.0) { $0 + $1.endDate.timeIntervalSince($1.startDate) } ?? 0
            if asleep > 0 { metrics["sleep_minutes"] = asleep / 60 }
            group.leave()
        }
        store.execute(sleepQuery)

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            let payload: [String: Any] = ["metrics": metrics, "max_bpm": self.maxHeartRate()]
            guard let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.push("window.sbHealthSnapshot && window.sbHealthSnapshot(\(json));")
        }
    }

    /// 最大心率：有出生年份就用 220-年龄，否则 190；网页也会用这个值分有氧/无氧
    private func maxHeartRate() -> Int {
        if let comps = try? store.dateOfBirthComponents(), let y = comps.year {
            let age = Calendar.current.component(.year, from: Date()) - y
            if age > 5 && age < 100 { return 220 - age }
        }
        return 190
    }

    // MARK: - 回传网页

    private func report(state: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: state),
              let json = String(data: data, encoding: .utf8) else { return }
        push("window.sbHealthState && window.sbHealthState(\(json));")
    }

    private func push(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
