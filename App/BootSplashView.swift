import UIKit

/// 原生启动层：在黑底上手写 Wisdom，等网页首帧/登录态就绪后淡出。
/// 只负责盖住 WebView 载入阶段，绝不再显示系统菊花。
final class BootSplashView: UIView {
    private let word = UILabel()
    private let sub = UILabel()
    private let bg = CAGradientLayer()

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
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        bg.frame = bounds
        let h: CGFloat = 76
        word.frame = CGRect(x: 28, y: bounds.midY - h / 2 - 8, width: bounds.width - 56, height: h)
        sub.frame = CGRect(x: 0, y: word.frame.maxY + 4, width: bounds.width, height: 18)
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
    }

    func finish() {
        guard superview != nil else { return }
        UIView.animate(withDuration: 0.38, delay: 0, options: [.curveEaseInOut]) {
            self.alpha = 0
            self.word.transform = CGAffineTransform(scaleX: 1.015, y: 1.015)
        } completion: { _ in
            self.removeFromSuperview()
        }
    }
}
