import Foundation
import MediaPlayer
import UIKit
import WebKit

/// 正在播放：代表系统「音乐」App 读元数据、控制播放。
/// 只碰 MediaPlayer 的公开 API（MPMusicPlayerController.systemMusicPlayer），
/// 不碰 MusicKit —— 自签没有 MusicKit 能力，那条路走不通。
/// 音频仍然在「音乐」App 里播，我们只做遥控 + 镜像，完全不碰 DRM。
final class MusicNow: NSObject {
    static let shared = MusicNow()

    private weak var web: WKWebView?
    private let player = MPMusicPlayerController.systemMusicPlayer
    private var timer: Timer?
    private var lastArtKey = ""
    private var observed = false
    private var authAsked = false

    func attach(_ view: WKWebView) {
        web = view
    }

    /// 网页来的指令（start / stop / play / pause / toggle / next / prev / seek / refresh）
    func command(_ body: [String: Any]) {
        DispatchQueue.main.async { self.run(body) }
    }

    private func run(_ body: [String: Any]) {
        guard let act = body["act"] as? String else { return }
        switch act {
        case "start":   start()
        case "stop":    timer?.invalidate(); timer = nil
        case "play":    player.play()
        case "pause":   player.pause()
        case "toggle":
            if player.playbackState == .playing { player.pause() } else { player.play() }
        case "next":    player.skipToNextItem()
        case "prev":    player.skipToPreviousItem()
        case "seek":
            let v = (body["value"] as? NSNumber)?.doubleValue ?? 0
            if v.isFinite { player.currentPlaybackTime = max(0, v) }
        case "refresh": start()
        default: break
        }
        tick()
    }

    private func start() {
        requestAuthIfNeeded()
        if !observed {
            observed = true
            player.beginGeneratingPlaybackNotifications()
            let c = NotificationCenter.default
            c.addObserver(self, selector: #selector(onChange),
                          name: .MPMusicPlayerControllerNowPlayingItemDidChange, object: player)
            c.addObserver(self, selector: #selector(onChange),
                          name: .MPMusicPlayerControllerPlaybackStateDidChange, object: player)
        }
        if timer == nil {
            // 1 秒一拍：进度、状态都靠它，秒级足够，别更密
            let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }
        tick()
    }

    @objc private func onChange() { tick() }

    private func requestAuthIfNeeded() {
        let st = MPMediaLibrary.authorizationStatus()
        guard st == .notDetermined, !authAsked else { return }
        authAsked = true
        MPMediaLibrary.requestAuthorization { [weak self] _ in
            DispatchQueue.main.async { self?.tick() }
        }
    }

    private func tick() {
        guard web != nil else { return }
        var d: [String: Any] = ["auth": authText()]
        switch player.playbackState {
        case .playing: d["state"] = "playing"
        case .paused:  d["state"] = "paused"
        case .stopped: d["state"] = "stopped"
        default:       d["state"] = "none"
        }
        let elapsed = player.currentPlaybackTime
        if elapsed.isFinite && elapsed >= 0 { d["elapsed"] = elapsed }
        if let it = player.nowPlayingItem {
            d["title"] = it.title ?? ""
            d["artist"] = it.artist ?? ""
            d["album"] = it.albumTitle ?? ""
            let dur = it.playbackDuration
            if dur.isFinite && dur > 0 { d["dur"] = dur }
            d["artKey"] = it.playbackStoreID
            // 封面只在换歌时推一次：600×600 的 JPEG 大概 60~90KB，每秒重推没意义
            if it.playbackStoreID != lastArtKey {
                lastArtKey = it.playbackStoreID
                if let img = it.artwork?.image(at: CGSize(width: 600, height: 600)),
                   let data = img.jpegData(compressionQuality: 0.8) {
                    let b64 = data.base64EncodedString()
                    push("window.sbMusicArt && window.sbMusicArt('\(it.playbackStoreID)', "
                         + "'data:image/jpeg;base64,\(b64)');")
                } else {
                    push("window.sbMusicArt && window.sbMusicArt('\(it.playbackStoreID)', '');")
                }
            }
        }
        if let data = try? JSONSerialization.data(withJSONObject: d),
           let js = String(data: data, encoding: .utf8) {
            push("window.sbMusic && window.sbMusic(\(js));")
        }
    }

    private func authText() -> String {
        switch MPMediaLibrary.authorizationStatus() {
        case .authorized:    return "authorized"
        case .denied:        return "denied"
        case .restricted:    return "restricted"
        case .notDetermined: return "undetermined"
        default:             return "unknown"
        }
    }

    private func push(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.web?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
