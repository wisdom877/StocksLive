import UIKit

/// CarPlay 右侧留白里的心率悬浮卡。
/// 不再是一根高高的竖向液位柱：改成一张独立的玻璃卡，显示当前 BPM、心率区间、
/// 近一分钟走势和本次区间，位置贴屏幕最右侧，不压 CarPlay 圆角画面。
final class HeartRateRailView: UIView {
    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let tint = CAGradientLayer()
    private let sheen = CAGradientLayer()
    private let heart = UIImageView(image: UIImage(systemName: "heart.fill"))
    private let live = UIView()
    private let title = UILabel()
    private let bpmLabel = UILabel()
    private let unitLabel = UILabel()
    private let zoneDot = UIView()
    private let zoneLabel = UILabel()
    private let zonePct = UILabel()
    private let zoneTrack = UIView()
    private let zoneScale = CAGradientLayer()
    private let zoneKnob = UIView()
    private let trendHost = UIView()
    private let trendLine = CAShapeLayer()
    private let trendFill = CAShapeLayer()
    private let trendDot = CAShapeLayer()
    private let rangeLabel = UILabel()
    private let footnote = UILabel()

    private var staleTimer: Timer?
    private var currentBpm: Int?
    private var lastPulseBpm: Int?
    private var samples: [Int] = []
    private var sampleTick = 0

    /// 有/无真实心率时通知宿主显示或收起，避免留一张空卡。
    var onAvailabilityChanged: ((Bool) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    deinit { staleTimer?.invalidate() }

    // MARK: - 构建

    private func setup() {
        isUserInteractionEnabled = false
        backgroundColor = .clear
        layer.cornerCurve = .continuous
        layer.borderWidth = 0.5
        layer.borderColor = UIColor.white.withAlphaComponent(0.16).cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.5
        layer.shadowRadius = 20
        layer.shadowOffset = CGSize(width: 0, height: 10)

        glass.isUserInteractionEnabled = false
        glass.clipsToBounds = true
        glass.layer.cornerCurve = .continuous
        addSubview(glass)

        tint.colors = [
            UIColor.white.withAlphaComponent(0.11).cgColor,
            UIColor.white.withAlphaComponent(0.02).cgColor,
            UIColor.white.withAlphaComponent(0.055).cgColor,
        ]
        tint.locations = [0, 0.55, 1]
        tint.startPoint = CGPoint(x: 0.1, y: 0)
        tint.endPoint = CGPoint(x: 0.9, y: 1)
        glass.contentView.layer.addSublayer(tint)

        sheen.colors = [UIColor.white.withAlphaComponent(0.13).cgColor,
                        UIColor.white.withAlphaComponent(0).cgColor]
        sheen.startPoint = CGPoint(x: 0.5, y: 0)
        sheen.endPoint = CGPoint(x: 0.5, y: 0.42)
        glass.contentView.layer.addSublayer(sheen)

        heart.contentMode = .scaleAspectFit
        heart.tintColor = UIColor.white.withAlphaComponent(0.5)
        glass.contentView.addSubview(heart)

        live.backgroundColor = UIColor.systemGreen
        live.layer.cornerRadius = 2.5
        live.layer.shadowColor = UIColor.systemGreen.cgColor
        live.layer.shadowOpacity = 0.45
        live.layer.shadowRadius = 4
        glass.contentView.addSubview(live)

        title.text = "心率"
        title.textColor = UIColor.white.withAlphaComponent(0.55)
        title.font = .systemFont(ofSize: 10.5, weight: .semibold)
        glass.contentView.addSubview(title)

        bpmLabel.text = "—"
        bpmLabel.textColor = .white
        bpmLabel.font = .monospacedDigitSystemFont(ofSize: 36, weight: .semibold)
        bpmLabel.textAlignment = .left
        bpmLabel.adjustsFontSizeToFitWidth = true
        bpmLabel.minimumScaleFactor = 0.7
        bpmLabel.numberOfLines = 1
        glass.contentView.addSubview(bpmLabel)

        unitLabel.text = "BPM"
        unitLabel.textColor = UIColor.white.withAlphaComponent(0.44)
        unitLabel.font = .systemFont(ofSize: 9, weight: .medium)
        unitLabel.textAlignment = .left
        glass.contentView.addSubview(unitLabel)

        zoneDot.layer.cornerRadius = 3
        zoneDot.layer.cornerCurve = .continuous
        glass.contentView.addSubview(zoneDot)

        zoneLabel.textColor = UIColor.white.withAlphaComponent(0.78)
        zoneLabel.font = .systemFont(ofSize: 9.5, weight: .semibold)
        zoneLabel.numberOfLines = 1
        zoneLabel.adjustsFontSizeToFitWidth = true
        zoneLabel.minimumScaleFactor = 0.8
        glass.contentView.addSubview(zoneLabel)

        zonePct.textColor = UIColor.white.withAlphaComponent(0.5)
        zonePct.font = .monospacedDigitSystemFont(ofSize: 9, weight: .medium)
        zonePct.textAlignment = .right
        glass.contentView.addSubview(zonePct)

        zoneTrack.backgroundColor = UIColor.white.withAlphaComponent(0.07)
        zoneTrack.layer.cornerRadius = 1.5
        zoneTrack.clipsToBounds = true
        glass.contentView.addSubview(zoneTrack)

        zoneScale.colors = [
            UIColor(red: 0.56, green: 0.56, blue: 0.58, alpha: 0.95).cgColor,
            UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 0.95).cgColor,
            UIColor(red: 0.19, green: 0.82, blue: 0.35, alpha: 0.95).cgColor,
            UIColor(red: 1.00, green: 0.84, blue: 0.04, alpha: 0.95).cgColor,
            UIColor(red: 1.00, green: 0.62, blue: 0.04, alpha: 0.95).cgColor,
            UIColor(red: 1.00, green: 0.27, blue: 0.23, alpha: 0.95).cgColor,
        ]
        zoneScale.locations = [0, 0.3, 0.5, 0.66, 0.8, 1]
        zoneScale.startPoint = CGPoint(x: 0, y: 0.5)
        zoneScale.endPoint = CGPoint(x: 1, y: 0.5)
        zoneTrack.layer.addSublayer(zoneScale)

        zoneKnob.backgroundColor = UIColor.white.withAlphaComponent(0.94)
        zoneKnob.layer.cornerRadius = 3
        zoneKnob.layer.shadowColor = UIColor.black.cgColor
        zoneKnob.layer.shadowOpacity = 0.35
        zoneKnob.layer.shadowRadius = 3
        zoneKnob.layer.shadowOffset = CGSize(width: 0, height: 1)
        glass.contentView.addSubview(zoneKnob)

        trendHost.backgroundColor = .clear
        trendHost.isUserInteractionEnabled = false
        glass.contentView.addSubview(trendHost)

        trendFill.fillColor = UIColor.white.withAlphaComponent(0.06).cgColor
        trendFill.strokeColor = UIColor.clear.cgColor
        trendHost.layer.addSublayer(trendFill)

        trendLine.lineWidth = 1.35
        trendLine.lineJoin = .round
        trendLine.lineCap = .round
        trendLine.strokeColor = UIColor.white.withAlphaComponent(0.55).cgColor
        trendLine.shadowOpacity = 0.35
        trendLine.shadowRadius = 4
        trendLine.shadowOffset = .zero
        trendHost.layer.addSublayer(trendLine)

        trendDot.fillColor = UIColor.white.cgColor
        trendDot.strokeColor = UIColor.clear.cgColor
        trendHost.layer.addSublayer(trendDot)

        rangeLabel.textColor = UIColor.white.withAlphaComponent(0.45)
        rangeLabel.font = .monospacedDigitSystemFont(ofSize: 9, weight: .medium)
        rangeLabel.textAlignment = .left
        rangeLabel.numberOfLines = 1
        glass.contentView.addSubview(rangeLabel)

        footnote.text = "最近 1 分钟"
        footnote.textColor = UIColor.white.withAlphaComponent(0.3)
        footnote.font = .systemFont(ofSize: 8.5, weight: .regular)
        footnote.textAlignment = .left
        glass.contentView.addSubview(footnote)

        isAccessibilityElement = true
        accessibilityLabel = "心率"
        accessibilityValue = "未接入"
    }

    // MARK: - 布局

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width, h = bounds.height
        guard w > 0, h > 0 else { return }

        let radius = min(24, w / 3)
        layer.cornerRadius = radius
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: radius).cgPath
        glass.frame = bounds
        glass.layer.cornerRadius = radius
        tint.frame = glass.contentView.bounds
        sheen.frame = CGRect(x: 0, y: 0, width: w, height: h * 0.48)

        let pad: CGFloat = 13
        heart.frame = CGRect(x: pad, y: 11, width: 14, height: 14)
        title.frame = CGRect(x: pad + 20, y: 11, width: max(28, w - pad * 2 - 20), height: 14)
        live.frame = CGRect(x: w - pad - 5, y: 15, width: 5, height: 5)

        bpmLabel.frame = CGRect(x: pad, y: 27, width: w - pad * 2, height: 40)
        unitLabel.frame = CGRect(x: pad + 1, y: 67, width: w - pad * 2, height: 10)

        zoneDot.frame = CGRect(x: pad, y: 88, width: 6, height: 6)
        zonePct.frame = CGRect(x: w - pad - 28, y: 84, width: 28, height: 13)
        zoneLabel.frame = CGRect(x: pad + 11, y: 83, width: max(20, w - pad * 2 - 39), height: 15)

        zoneTrack.frame = CGRect(x: pad, y: 105, width: w - pad * 2, height: 3)
        zoneScale.frame = zoneTrack.bounds
        let progress = zoneProgress
        zoneKnob.frame = CGRect(x: pad + progress * (w - pad * 2) - 3, y: 102, width: 6, height: 6)

        trendHost.frame = CGRect(x: pad, y: 117, width: w - pad * 2, height: 50)
        trendFill.frame = trendHost.bounds
        trendLine.frame = trendHost.bounds
        trendDot.frame = trendHost.bounds
        paintTrend()

        rangeLabel.frame = CGRect(x: pad, y: 174, width: w - pad * 2, height: 13)
        footnote.frame = CGRect(x: pad, y: 195, width: w - pad * 2, height: 12)
    }

    private var zoneProgress: CGFloat {
        guard let bpm = currentBpm else { return 0 }
        return min(1, max(0, CGFloat(bpm - 40) / 150))
    }

    // MARK: - 数据

    func refresh() {
        let bpm = HeartRateCenter.shared.current()
        let had = currentBpm != nil
        if bpm != currentBpm {
            currentBpm = bpm
            if let bpm = bpm {
                append(bpm)
                if bpm != lastPulseBpm {
                    lastPulseBpm = bpm
                    pulse()
                }
            } else {
                samples.removeAll()
                sampleTick = 0
            }
            paint()
            setNeedsLayout()
        } else if let bpm = bpm {
            sampleTick += 1
            if sampleTick >= 3 {
                sampleTick = 0
                append(bpm)
                setNeedsLayout()
            }
        }
        if (bpm != nil) != had { onAvailabilityChanged?(bpm != nil) }
    }

    private func append(_ bpm: Int) {
        if samples.last != bpm { samples.append(bpm) } else if samples.isEmpty { samples.append(bpm) }
        if samples.count > 24 { samples.removeFirst(samples.count - 24) }
    }

    private func paint() {
        let color = currentBpm.map(zoneColor) ?? UIColor.white.withAlphaComponent(0.34)
        heart.tintColor = color
        live.backgroundColor = color
        live.layer.shadowColor = color.cgColor

        zoneDot.backgroundColor = color
        zoneLabel.textColor = color
        let info = currentBpm.map { zoneInfo($0) } ?? ("未接入", 0)
        zoneLabel.text = info.1 > 0 ? "\(info.0) · Z\(info.1)" : info.0
        zonePct.text = currentBpm.map { "\(Int(round(Double($0) / 190.0 * 100)))%" } ?? "—"

        bpmLabel.text = currentBpm.map(String.init) ?? "—"
        bpmLabel.textColor = currentBpm == nil ? UIColor.white.withAlphaComponent(0.55) : .white
        unitLabel.textColor = currentBpm == nil
            ? UIColor.white.withAlphaComponent(0.25)
            : UIColor.white.withAlphaComponent(0.44)

        if samples.count >= 2 {
            let lo = samples.min() ?? 0, hi = samples.max() ?? 0
            rangeLabel.text = "本次 \(lo)–\(hi)"
        } else {
            rangeLabel.text = "本次 —"
        }
        rangeLabel.textColor = UIColor.white.withAlphaComponent(0.46)
        footnote.textColor = UIColor.white.withAlphaComponent(0.3)
        zoneKnob.isHidden = currentBpm == nil

        trendLine.strokeColor = color.withAlphaComponent(0.72).cgColor
        trendLine.shadowColor = color.cgColor
        trendFill.fillColor = color.withAlphaComponent(0.08).cgColor
        trendDot.fillColor = color.withAlphaComponent(0.9).cgColor

        accessibilityValue = currentBpm.map {
            let z = zoneInfo($0).0
            return "\($0) BPM，\(z)"
        } ?? "未接入"
        setNeedsLayout()
    }

    private func paintTrend() {
        let area = trendHost.bounds
        guard area.width > 0, area.height > 0, samples.count >= 2 else {
            trendLine.path = nil
            trendFill.path = nil
            trendDot.path = nil
            return
        }
        let lo = CGFloat(samples.min() ?? 0)
        let hi = CGFloat(samples.max() ?? 0)
        let span = max(12, hi - lo)
        let padY: CGFloat = 5
        let usableH = max(1, area.height - padY * 2)
        let step = area.width / CGFloat(max(1, samples.count - 1))

        let up = UIBezierPath()
        var last = CGPoint.zero
        for (i, sample) in samples.enumerated() {
            let x = CGFloat(i) * step
            let norm = (CGFloat(sample) - lo) / span
            let y = padY + (1 - norm) * usableH
            last = CGPoint(x: x, y: y)
            if i == 0 { up.move(to: last) } else { up.addLine(to: last) }
        }
        trendLine.path = up.cgPath

        let fill = UIBezierPath(cgPath: up.cgPath)
        fill.addLine(to: CGPoint(x: area.width, y: area.height))
        fill.addLine(to: CGPoint(x: 0, y: area.height))
        fill.close()
        trendFill.path = fill.cgPath

        let dot = UIBezierPath(ovalIn: CGRect(x: last.x - 2.4, y: last.y - 2.4, width: 4.8, height: 4.8))
        trendDot.path = dot.cgPath
    }

    private func pulse() {
        heart.transform = CGAffineTransform(scaleX: 1.22, y: 1.22)
        live.alpha = 0.2
        UIView.animate(withDuration: 0.46, delay: 0,
                       usingSpringWithDamping: 0.58, initialSpringVelocity: 0.3,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.heart.transform = .identity
            self.live.alpha = 1
        }
    }

    private func zoneColor(_ bpm: Int) -> UIColor {
        switch Double(bpm) / 190.0 {
        case ..<0.50: return UIColor(red: 0.56, green: 0.56, blue: 0.58, alpha: 1)
        case ..<0.60: return UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 1)
        case ..<0.70: return UIColor(red: 0.19, green: 0.82, blue: 0.35, alpha: 1)
        case ..<0.80: return UIColor(red: 1.00, green: 0.84, blue: 0.04, alpha: 1)
        case ..<0.90: return UIColor(red: 1.00, green: 0.62, blue: 0.04, alpha: 1)
        default: return UIColor(red: 1.00, green: 0.27, blue: 0.23, alpha: 1)
        }
    }

    private func zoneInfo(_ bpm: Int) -> (String, Int) {
        switch Double(bpm) / 190.0 {
        case ..<0.50: return ("静息", 1)
        case ..<0.60: return ("热身", 2)
        case ..<0.70: return ("燃脂", 3)
        case ..<0.80: return ("有氧", 4)
        case ..<0.90: return ("无氧", 5)
        default: return ("峰值", 6)
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil {
            staleTimer?.invalidate()
            staleTimer = nil
            return
        }
        refresh()
        guard staleTimer == nil else { return }
        staleTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }
}
