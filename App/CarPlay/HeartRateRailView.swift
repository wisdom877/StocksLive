import UIKit

/// CarPlay 16:9 画面右侧黑边里的心率柱：一条竖向玻璃胶囊，
/// 数字 + 竖向液位随心率区间变色。没有真实采样时保持安静的“—”，不画假波形。
final class HeartRateRailView: UIView {
    private let glass = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let tint = CAGradientLayer()
    private let sheen = CAGradientLayer()
    private let heart = UIImageView(image: UIImage(systemName: "heart.fill"))
    private let bpmLabel = UILabel()
    private let unitLabel = UILabel()
    private let track = UIView()
    private let fill = UIView()
    private let fillLayer = CAGradientLayer()
    private let knob = UIView()
    private let caption = UILabel()
    private var staleTimer: Timer?
    private var currentBpm: Int?
    private var level: CGFloat = 0
    private var lastPulseBpm: Int?
    /// 有/无真实心率时通知宿主显示或收起，避免留一个空胶囊。
    var onAvailabilityChanged: ((Bool) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { staleTimer?.invalidate() }

    private func setup() {
        isUserInteractionEnabled = false
        backgroundColor = .clear
        layer.cornerCurve = .continuous
        layer.borderWidth = 0.5
        layer.borderColor = UIColor.white.withAlphaComponent(0.16).cgColor
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.55
        layer.shadowRadius = 18
        layer.shadowOffset = CGSize(width: 0, height: 8)

        glass.isUserInteractionEnabled = false
        glass.clipsToBounds = true
        glass.layer.cornerCurve = .continuous
        addSubview(glass)

        tint.colors = [
            UIColor.white.withAlphaComponent(0.10).cgColor,
            UIColor.white.withAlphaComponent(0.015).cgColor,
            UIColor.white.withAlphaComponent(0.055).cgColor,
        ]
        tint.locations = [0, 0.56, 1]
        tint.startPoint = CGPoint(x: 0.1, y: 0)
        tint.endPoint = CGPoint(x: 0.9, y: 1)
        glass.contentView.layer.addSublayer(tint)

        sheen.colors = [UIColor.white.withAlphaComponent(0.12).cgColor,
                        UIColor.white.withAlphaComponent(0).cgColor]
        sheen.startPoint = CGPoint(x: 0.5, y: 0)
        sheen.endPoint = CGPoint(x: 0.5, y: 0.45)
        glass.contentView.layer.addSublayer(sheen)

        heart.contentMode = .scaleAspectFit
        heart.tintColor = UIColor.white.withAlphaComponent(0.36)
        glass.contentView.addSubview(heart)

        bpmLabel.text = "—"
        bpmLabel.textColor = .white
        bpmLabel.font = .monospacedDigitSystemFont(ofSize: 23, weight: .semibold)
        bpmLabel.textAlignment = .center
        bpmLabel.adjustsFontSizeToFitWidth = true
        bpmLabel.minimumScaleFactor = 0.65
        bpmLabel.numberOfLines = 1
        glass.contentView.addSubview(bpmLabel)

        unitLabel.text = "BPM"
        unitLabel.textColor = UIColor.white.withAlphaComponent(0.52)
        unitLabel.font = .systemFont(ofSize: 8, weight: .medium)
        unitLabel.textAlignment = .center
        glass.contentView.addSubview(unitLabel)

        track.backgroundColor = UIColor.white.withAlphaComponent(0.10)
        track.layer.cornerRadius = 1.5
        track.clipsToBounds = true
        glass.contentView.addSubview(track)

        fill.layer.addSublayer(fillLayer)
        fill.isHidden = true
        track.addSubview(fill)

        knob.backgroundColor = UIColor.white.withAlphaComponent(0.85)
        knob.layer.cornerRadius = 3.5
        knob.isHidden = true
        glass.contentView.addSubview(knob)

        caption.text = "心率"
        caption.textColor = UIColor.white.withAlphaComponent(0.55)
        caption.font = .systemFont(ofSize: 9.5, weight: .medium)
        caption.textAlignment = .center
        glass.contentView.addSubview(caption)

        isAccessibilityElement = true
        accessibilityLabel = "心率"
        accessibilityValue = "未接入"
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let w = bounds.width
        let h = bounds.height
        guard w > 0, h > 0 else { return }

        layer.cornerRadius = w / 2
        layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: w / 2).cgPath
        glass.frame = bounds
        glass.layer.cornerRadius = w / 2
        tint.frame = glass.contentView.bounds
        sheen.frame = CGRect(x: 0, y: 0, width: w, height: h * 0.46)

        heart.frame = CGRect(x: (w - 16) / 2, y: 18, width: 16, height: 16)
        bpmLabel.frame = CGRect(x: 4, y: 38, width: w - 8, height: 29)
        unitLabel.frame = CGRect(x: 4, y: 66, width: w - 8, height: 10)

        let trackTop = max(92, h * 0.33)
        let trackBottom = h - 42
        let trackHeight = max(64, trackBottom - trackTop)
        track.frame = CGRect(x: (w - 4) / 2, y: trackTop, width: 4, height: trackHeight)

        let fillHeight = min(trackHeight, max(0, level * trackHeight))
        fill.frame = CGRect(x: 0, y: trackHeight - fillHeight, width: 4, height: fillHeight)
        fillLayer.frame = fill.bounds
        knob.frame = CGRect(x: (w - 7) / 2, y: trackTop + trackHeight - fillHeight - 3.5,
                            width: 7, height: 7)
        knob.isHidden = fillHeight <= 0 || currentBpm == nil

        caption.frame = CGRect(x: 4, y: h - 27, width: w - 8, height: 13)
    }

    func refresh() {
        let bpm = HeartRateCenter.shared.current()
        let hadBpm = currentBpm != nil
        if bpm != currentBpm {
            currentBpm = bpm
            level = bpm.map { min(1, max(0, CGFloat($0 - 40) / 150)) } ?? 0
            paint()
            setNeedsLayout()
        }
        if (bpm != nil) != hadBpm {
            onAvailabilityChanged?(bpm != nil)
        }
        if let bpm, bpm != lastPulseBpm {
            lastPulseBpm = bpm
            pulse()
        }
    }

    private func paint() {
        let color = currentBpm.map(zoneColor) ?? UIColor.white.withAlphaComponent(0.32)
        heart.tintColor = color
        fill.isHidden = currentBpm == nil
        fillLayer.colors = [color.withAlphaComponent(0.92).cgColor,
                            color.withAlphaComponent(0.28).cgColor]
        fillLayer.startPoint = CGPoint(x: 0.5, y: 1)
        fillLayer.endPoint = CGPoint(x: 0.5, y: 0)
        bpmLabel.text = currentBpm.map(String.init) ?? "—"
        bpmLabel.textColor = currentBpm == nil ? UIColor.white.withAlphaComponent(0.55) : .white
        caption.textColor = currentBpm == nil
            ? UIColor.white.withAlphaComponent(0.42)
            : UIColor.white.withAlphaComponent(0.70)
        accessibilityValue = currentBpm.map { "\($0) BPM" } ?? "未接入"
    }

    private func pulse() {
        heart.transform = CGAffineTransform(scaleX: 1.18, y: 1.18)
        UIView.animate(withDuration: 0.42, delay: 0,
                       usingSpringWithDamping: 0.58, initialSpringVelocity: 0.3,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.heart.transform = .identity
        }
    }

    private func zoneColor(_ bpm: Int) -> UIColor {
        let pct = Double(bpm) / 190.0 * 100
        switch pct {
        case ..<50: return UIColor(red: 0.56, green: 0.56, blue: 0.58, alpha: 1)
        case ..<60: return UIColor(red: 0.35, green: 0.78, blue: 0.98, alpha: 1)
        case ..<70: return UIColor(red: 0.19, green: 0.82, blue: 0.35, alpha: 1)
        case ..<80: return UIColor(red: 1.00, green: 0.84, blue: 0.04, alpha: 1)
        case ..<90: return UIColor(red: 1.00, green: 0.62, blue: 0.04, alpha: 1)
        default: return UIColor(red: 1.00, green: 0.27, blue: 0.23, alpha: 1)
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
        staleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }
}
