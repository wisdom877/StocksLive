import UIKit

/// 原生启动层：在黑底上手写 Wisdom，等网页首帧/登录态就绪后淡出。
/// 只负责盖住 WebView 载入阶段，绝不再显示系统菊花。
final class BootSplashView: UIView {
    private let word = UILabel()
    private let sub = UILabel()
    private let hint = UILabel()
    private let bg = CAGradientLayer()
    private var hintTimer: Timer?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        isUserInteractionEnabled = false

        bg.colors = [
            UIColor(red: 0.02, green: 0.03, blue: 0.09, alpha: 1).cgColor,
            UIColor.black.cgColor,
            UIColor(red: 0.09, green: 0.01, blue: 0.06, alpha: 1).cgColor,
        ]
        bg.locations = [0, 0.55, 1]
        bg.startPoint = CGPoint(x: 0.1, y: 0)
        bg.endPoint = CGPoint(x: 0.9, y: 1)
        layer.addSublayer(bg)

        word.text = "Wisdom"
        word.textAlignment = .center
        word.textColor = .white
        word.font = UIFont(name: "SnellRoundhand-Bold", size: 64)
            ?? UIFont.italicSystemFont(ofSize: 64)
        word.adjustsFontSizeToFitWidth = true
        word.minimumScaleFactor = 0.7
        word.numberOfLines = 1
        word.layer.shadowColor = UIColor(red: 0.72, green: 0.80, blue: 1, alpha: 1).cgColor
        word.layer.shadowOpacity = 0.22
        word.layer.shadowRadius = 18
        word.layer.shadowOffset = .zero
        addSubview(word)

        sub.text = "黄杨科技"
        sub.textAlignment = .center
        sub.textColor = UIColor.white.withAlphaComponent(0.40)
        sub.font = .systemFont(ofSize: 12, weight: .medium)
        sub.layer.shadowColor = UIColor.black.cgColor
        sub.layer.shadowOpacity = 0.5
        sub.layer.shadowRadius = 4
        addSubview(sub)

        hint.text = "长时间没反应？检查一下网络连接"
        hint.textAlignment = .center
        hint.font = .systemFont(ofSize: 11, weight: .regular)
        hint.alpha = 0
        addSubview(hint)

        applyTheme()
    }

    /// 启动层跟着系统深浅色走：底色、渐变、字色、阴影一起换，别只改一层。
    private func applyTheme() {
        let dark = traitCollection.userInterfaceStyle == .dark
        backgroundColor = dark
            ? .black
            : UIColor(red: 0.949, green: 0.953, blue: 0.965, alpha: 1)
        bg.colors = dark
            ? [UIColor(red: 0.02, green: 0.03, blue: 0.09, alpha: 1).cgColor,
               UIColor.black.cgColor,
               UIColor(red: 0.09, green: 0.01, blue: 0.06, alpha: 1).cgColor]
            : [UIColor(red: 0.86, green: 0.89, blue: 0.99, alpha: 1).cgColor,
               UIColor(red: 0.949, green: 0.953, blue: 0.965, alpha: 1).cgColor,
               UIColor(red: 0.97, green: 0.90, blue: 0.97, alpha: 1).cgColor]
        word.textColor = dark
            ? .white
            : UIColor(red: 0.11, green: 0.13, blue: 0.20, alpha: 1)
        word.layer.shadowColor = (dark
            ? UIColor(red: 0.72, green: 0.80, blue: 1, alpha: 1)
            : UIColor(red: 0.26, green: 0.37, blue: 0.74, alpha: 1)).cgColor
        word.layer.shadowOpacity = dark ? 0.22 : 0.16
        sub.textColor = dark
            ? UIColor.white.withAlphaComponent(0.40)
            : UIColor(red: 0.09, green: 0.10, blue: 0.12, alpha: 0.46)
        sub.layer.shadowOpacity = dark ? 0.5 : 0
        hint.textColor = dark
            ? UIColor.white.withAlphaComponent(0.34)
            : UIColor(red: 0.09, green: 0.10, blue: 0.12, alpha: 0.40)
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        guard traitCollection.hasDifferentColorAppearance(comparedTo: previousTraitCollection) else { return }
        applyTheme()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        bg.frame = bounds
        let h: CGFloat = 76
        word.frame = CGRect(x: 28, y: bounds.midY - h / 2 - 8, width: bounds.width - 56, height: h)
        sub.frame = CGRect(x: 0, y: word.frame.maxY + 4, width: bounds.width, height: 18)
        hint.frame = CGRect(x: 0, y: sub.frame.maxY + 12, width: bounds.width, height: 16)
    }

    func start() {
        alpha = 0
        word.transform = CGAffineTransform(scaleX: 0.95, y: 0.95)
        sub.alpha = 0
        UIView.animate(withDuration: 0.55, delay: 0, options: [.curveEaseOut]) {
            self.alpha = 1
            self.word.transform = .identity
        }
        UIView.animate(withDuration: 0.42, delay: 0.35, options: [.curveEaseOut]) {
            self.sub.alpha = 1
        }
        // 正常一两秒就交给网页了；真卡在网络上八秒后补一行小字。
        hint.alpha = 0
        hintTimer?.invalidate()
        hintTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
            guard let self, self.superview != nil else { return }
            UIView.animate(withDuration: 0.3) { self.hint.alpha = 1 }
        }
    }

    func finish() {
        hintTimer?.invalidate()
        hintTimer = nil
        guard superview != nil else { return }
        UIView.animate(withDuration: 0.38, delay: 0, options: [.curveEaseInOut]) {
            self.alpha = 0
            self.word.transform = CGAffineTransform(scaleX: 1.015, y: 1.015)
        } completion: { _ in
            self.removeFromSuperview()
        }
    }
}
