// SPDX-License-Identifier: AGPL-3.0-only
// CarPlayAudio 会读这个标志来决定是否用 mixWithOthers。本项目的 CarPlay 只在前台跑，
// 不做静音保活，所以恒为 false；保留它只是为了不修改上游的音频文件。
enum BackgroundKeepAlive {
    static var holdsAudioSession = false
    static func start() {}
    static func stop() {}
}
