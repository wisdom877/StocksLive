import Foundation

/// 网页要切方向时只认这个协议：iPhone 壳和 iPad HD 壳各自实现自己的方向策略，
/// 网页壳本身不直接依赖某个 AppDelegate 类型。
protocol OrientationControlling: AnyObject {
    func setLandscape(_ on: Bool)
}
