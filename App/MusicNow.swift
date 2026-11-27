import AVFoundation
import Foundation
import MediaPlayer
import UIKit
import WebKit

/// 正在播放：镜像系统「音乐」App，并支持从「音乐」资料库直接起播。
/// 只用 MediaPlayer 的公开 API，不碰 MusicKit —— 自签没有 MusicKit 能力，那条路走不通。
/// 两条播放通道：
///   ① systemMusicPlayer：用户在「音乐」App 里放的东西，我们只做遥控 + 镜像，完全不碰 DRM；
///   ② applicationQueuePlayer：在待机页点了资料库里的播放列表/单曲，由本 App 起播，
///      同样镜像进度和封面（资料库里的歌本来就是设备上的，不涉及云端解密）。
final class MusicNow: NSObject {
    static let shared = MusicNow()

    private weak var web: WKWebView?
    private let system = MPMusicPlayerController.systemMusicPlayer
    private let queue = MPMusicPlayerController.applicationQueuePlayer
    private var useQueue = false           // true 时所有遥控/镜像都对着 applicationQueuePlayer
    private var timer: Timer?
    private var lastArtKey = ""
    private var observed = false
    private var authAsked = false
    private var lastAct = ""
    private var lastActAt = 0.0
    private var songsCache: [MPMediaItem]?
    private var playlistsCache: [MPMediaPlaylist]?

    private var active: MPMusicPlayerController { useQueue ? queue : system }

    func attach(_ view: WKWebView) {
        web = view
    }

    /// 网页来的指令（start / stop / play / pause / toggle / next / prev / seek / refresh / lib / songs / playlist / song）
    func command(_ body: [String: Any]) {
        DispatchQueue.main.async {
            // 音乐页连点会排队很多次 MediaPlayer 调用；自动释放池避免解码/封面对象堆积。
            autoreleasepool { self.run(body) }
        }
    }

    private func run(_ body: [String: Any]) {
        guard let act = body["act"] as? String else { return }
        // 同一动作 280ms 内只执行一次，既保留点按手感，又不会被连点拖死主线程。
        let now = ProcessInfo.processInfo.systemUptime
        if act != "seek", act == lastAct, now - lastActAt < 0.28 { return }
        lastAct = act; lastActAt = now
        switch act {
        case "start":   start()
        case "stop":    timer?.invalidate(); timer = nil
        case "play":    activatePlaybackSession(); active.play()
        case "pause":   active.pause()
        case "toggle":
            if active.playbackState == .playing { active.pause() }
            else {
                // applicationQueuePlayer 没有队列时 play() 会直接回到 paused。
                // 空队列先退回 system，避免连点播放/暂停把播放器状态打乱。
                if useQueue, queue.nowPlayingItem == nil { useQueue = false }
                activatePlaybackSession(); active.play()
            }
        case "next":    active.skipToNextItem()
        case "prev":    active.skipToPreviousItem()
        case "seek":
            let v = (body["value"] as? NSNumber)?.doubleValue ?? 0
            if v.isFinite { active.currentPlaybackTime = max(0, v) }
        case "refresh": start()
        case "lib":     pushLibrary()
        case "songs":   pushSongs()
        case "playlist": playPlaylist(String(describing: body["value"] ?? ""))
        case "playlistItems": pushPlaylistItems(String(describing: body["value"] ?? ""))
        case "playlistTrack": playPlaylistTrack(body["value"] as? [String: Any] ?? [:])
        case "song":     playSong(String(describing: body["value"] ?? ""))
        default: break
        }
        tick()
    }

    private func start() {
        requestAuthIfNeeded()
        if !observed {
            observed = true
            system.beginGeneratingPlaybackNotifications()
            queue.beginGeneratingPlaybackNotifications()
            let c = NotificationCenter.default
            [system, queue].forEach { p in
                c.addObserver(self, selector: #selector(onChange),
                              name: .MPMusicPlayerControllerNowPlayingItemDidChange, object: p)
                c.addObserver(self, selector: #selector(onChange),
                              name: .MPMusicPlayerControllerPlaybackStateDidChange, object: p)
            }
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
            DispatchQueue.main.async {
                self?.tick()
                self?.pushLibrary()      // 授权回来立刻补一次列表，省得用户再点
            }
        }
    }

    /* ---------- 资料库：播放列表 / 全部歌曲 ---------- */

    /// MPMediaQuery 的同步扫描在主线程上很贵；连点列表/歌曲时缓存一次，避免 watchdog。
    private func playlists() -> [MPMediaPlaylist] {
        if let playlistsCache { return playlistsCache }
        let lists = (MPMediaQuery.playlists().collections ?? []).compactMap { $0 as? MPMediaPlaylist }
        playlistsCache = lists
        return lists
    }

    private func songs() -> [MPMediaItem] {
        if let songsCache { return songsCache }
        let items = MPMediaQuery.songs().items ?? []
        songsCache = items
        return items
    }

    private func libraryReady() -> Bool {
        MPMediaLibrary.authorizationStatus() == .authorized
    }

    private func pushLibrary() {
        guard libraryReady() else {
            requestAuthIfNeeded()
            push("window.sbMusicLib && window.sbMusicLib({\"auth\":\"\(authText())\",\"playlists\":[]});")
            return
        }
        let lists = playlists()
        var arr: [[String: Any]] = []
        for pl in lists {
            guard let name = pl.value(forProperty: MPMediaPlaylistPropertyName) as? String, !name.isEmpty else { continue }
            var d: [String: Any] = ["id": String(pl.persistentID), "name": name, "count": pl.items.count]
            if let img = pl.representativeItem?.artwork?.image(at: CGSize(width: 96, height: 96)),
               let data = img.jpegData(compressionQuality: 0.6) {
                d["art"] = "data:image/jpeg;base64," + data.base64EncodedString()
            }
            arr.append(d)
        }
        arr.sort { (($0["name"] as? String) ?? "").localizedStandardCompare((($1["name"] as? String) ?? "")) == .orderedAscending }
        let obj: [String: Any] = ["auth": "authorized", "playlists": Array(arr.prefix(80))]
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let js = String(data: data, encoding: .utf8) {
            push("window.sbMusicLib && window.sbMusicLib(\(js));")
        }
    }

    private func pushSongs() {
        guard libraryReady() else {
            requestAuthIfNeeded()
            push("window.sbMusicSongs && window.sbMusicSongs({\"auth\":\"\(authText())\",\"songs\":[]});")
            return
        }
        let items = songs()
        var arr: [[String: Any]] = []
        for it in items {
            guard let title = it.title, !title.isEmpty else { continue }
            var d: [String: Any] = [
                "id": String(it.persistentID),
                "title": title,
                "artist": it.artist ?? "",
                "album": it.albumTitle ?? "",
            ]
            let dur = it.playbackDuration
            if dur.isFinite && dur > 0 { d["dur"] = dur }
            arr.append(d)
        }
        let obj: [String: Any] = ["auth": "authorized", "songs": Array(arr.prefix(400)), "total": arr.count]
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let js = String(data: data, encoding: .utf8) {
            push("window.sbMusicSongs && window.sbMusicSongs(\(js));")
        }
    }

    /// 本机就是 CarPlay 接收端时，系统「音乐」的默认输出会被吸到虚拟 carAudio 路由，
    /// 结果就是界面在播、车里/手机上都没声。这里和接收端一样把输出拉回物理扬声器。
    private func activatePlaybackSession() {
        let s = AVAudioSession.sharedInstance()
        let outputs = s.currentRoute.outputs.map { $0.portType }
        // 外接蓝牙/耳机/AirPlay 优先：只要手机已经连着可出声的外设，就不要抢回本机扬声器。
        let external: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothLE, .bluetoothHFP,
                                                  .airPlay, .headphones, .usbAudio, .lineOut]
        if outputs.contains(where: { external.contains($0) }) {
            try? s.setCategory(.playback, mode: .default,
                               options: [.allowBluetoothA2DP, .allowAirPlay, .mixWithOthers])
            try? s.setActive(true)
            try? s.overrideOutputAudioPort(.none)
            return
        }
        let onCarAudio = outputs.contains(.carAudio)
        guard onCarAudio else {
            try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try? s.setActive(true)
            return
        }
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .mixWithOthers])
            try s.setActive(true)
            try s.overrideOutputAudioPort(.speaker)
        } catch {
            try? s.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try? s.setActive(true)
        }
    }

    private func playItems(_ items: [MPMediaItem]) {
        guard !items.isEmpty else { return }
        system.pause()                       // 两条通道同时放会叠音
        // 壳平时把会话压成 ambient 且不激活（为了不压低别人的音乐）；
        // 我们自己要出声就得临时切到 playback 并激活，否则放出来是哑的。
        activatePlaybackSession()
        useQueue = true
        queue.setQueue(with: MPMediaItemCollection(items: items))
        queue.play()
        lastArtKey = ""
        start()
    }

    private func playPlaylist(_ raw: String) {
        guard let pid = UInt64(raw.trimmingCharacters(in: .whitespaces)) else { return }
        let lists = playlists()
        guard let pl = lists.first(where: { $0.persistentID == pid }) else { return }
        playItems(pl.items)
    }

    /// 把某个播放列表里的曲目推给网页：点列表是「展开」，不是「开播」
    private func pushPlaylistItems(_ raw: String) {
        guard libraryReady(), let pid = UInt64(raw.trimmingCharacters(in: .whitespaces)) else {
            push("window.sbMusicTracks && window.sbMusicTracks({\"tracks\":[]});")
            return
        }
        let lists = playlists()
        guard let pl = lists.first(where: { $0.persistentID == pid }) else {
            push("window.sbMusicTracks && window.sbMusicTracks({\"tracks\":[]});")
            return
        }
        let name = (pl.value(forProperty: MPMediaPlaylistPropertyName) as? String) ?? ""
        var arr: [[String: Any]] = []
        for it in pl.items {
            guard let title = it.title, !title.isEmpty else { continue }
            var d: [String: Any] = ["id": String(it.persistentID), "title": title,
                                    "artist": it.artist ?? "", "album": it.albumTitle ?? ""]
            let dur = it.playbackDuration
            if dur.isFinite && dur > 0 { d["dur"] = dur }
            arr.append(d)
        }
        let obj: [String: Any] = ["name": name, "tracks": arr]
        if let data = try? JSONSerialization.data(withJSONObject: obj),
           let js = String(data: data, encoding: .utf8) {
            push("window.sbMusicTracks && window.sbMusicTracks(\(js));")
        }
    }

    /// 从播放列表里的某一首发始放：整张列表进队列，再点那首
    private func playPlaylistTrack(_ body: [String: Any]) {
        guard let listRaw = body["list"] as? String, let pid = UInt64(listRaw),
              let trackRaw = body["track"] as? String, let tid = UInt64(trackRaw) else { return }
        let lists = playlists()
        guard let pl = lists.first(where: { $0.persistentID == pid }) else { return }
        let items = pl.items
        guard let startItem = items.first(where: { $0.persistentID == tid }) ?? items.first else { return }
        system.pause()
        activatePlaybackSession()
        useQueue = true
        queue.setQueue(with: MPMediaItemCollection(items: items))
        queue.nowPlayingItem = startItem
        queue.play()
        lastArtKey = ""
        start()
    }

    private func playSong(_ raw: String) {
        guard let pid = UInt64(raw.trimmingCharacters(in: .whitespaces)) else { return }
        let items = songs()
        guard let it = items.first(where: { $0.persistentID == pid }) else { return }
        playItems([it])
    }

    /* ---------- 镜像 ---------- */

    private func tick() {
        guard web != nil else { return }
        // 谁真的在放就镜像谁：用户在「音乐」App 里按了播放，会自动切回系统通道。
        // 两边都 paused 时不能保留上一次的 useQueue，否则会一直对着空队列发 play()。
        if system.playbackState == .playing { useQueue = false }
        else if queue.playbackState == .playing { useQueue = true }
        else if useQueue, queue.nowPlayingItem == nil { useQueue = false }

        let p = active
        var d: [String: Any] = ["auth": authText(), "src": useQueue ? "queue" : "system"]
        switch p.playbackState {
        case .playing: d["state"] = "playing"
        case .paused:  d["state"] = "paused"
        case .stopped: d["state"] = "stopped"
        default:       d["state"] = "none"
        }
        let elapsed = p.currentPlaybackTime
        if elapsed.isFinite && elapsed >= 0 { d["elapsed"] = elapsed }
        if let it = p.nowPlayingItem {
            d["title"] = it.title ?? ""
            d["artist"] = it.artist ?? ""
            d["album"] = it.albumTitle ?? ""
            let dur = it.playbackDuration
            if dur.isFinite && dur > 0 { d["dur"] = dur }
            // 资料库曲目的 playbackStoreID 可能是 0，用 persistentID 兜一层，换歌才认得出
            let key = it.playbackStoreID != "0" ? it.playbackStoreID : String(it.persistentID)
            d["artKey"] = key
            // 封面只在换歌时推一次：600×600 的 JPEG 大概 60~90KB，每秒重推没意义
            if key != lastArtKey {
                lastArtKey = key
                if let img = it.artwork?.image(at: CGSize(width: 600, height: 600)),
                   let data = img.jpegData(compressionQuality: 0.8) {
                    let b64 = data.base64EncodedString()
                    push("window.sbMusicArt && window.sbMusicArt('\(key)', "
                         + "'data:image/jpeg;base64,\(b64)');")
                } else {
                    push("window.sbMusicArt && window.sbMusicArt('\(key)', '');")
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
