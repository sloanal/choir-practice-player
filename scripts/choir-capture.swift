import Cocoa
import WebKit
import ScreenCaptureKit
import AVFoundation

let rootLink = "https://www.dropbox.com/scl/fo/kyd9f5krh3yi9jwmfane0/AAnXhKbsa80rnbMpFnDgx_k?rlkey=nfjhrq1034b00aywltpvy7o4b&dl=0"
let outputRoot = URL(fileURLWithPath: "/Users/elcentro/dev/Untitled/recordings/Fall’26 Section Parts for LCC")
let stateRoot = URL(fileURLWithPath: "/Users/elcentro/dev/Untitled/.capture-cache")
let fm = FileManager.default
func log(_ text: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(text)\n"
    print(line, terminator: ""); fflush(stdout)
    let url = stateRoot.appendingPathComponent("capture.log")
    if !fm.fileExists(atPath:url.path) { fm.createFile(atPath:url.path,contents:nil) }
    if let file = try? FileHandle(forWritingTo:url) { try? file.seekToEnd(); try? file.write(contentsOf:Data(line.utf8)); try? file.close() }
}
func problem(_ text: String) -> NSError { NSError(domain:"ChoirCapture",code:1,userInfo:[NSLocalizedDescriptionKey:text]) }
func pause(_ seconds: Double) async throws { try await Task.sleep(nanoseconds: UInt64(seconds * 1e9)) }
struct Track: Codable {
    var path: String
    var url: String
    var sourceDuration: Double?
    var recordedDuration: Double?
    var bytes: Int?
    var peak: Float?
    var status = "pending"
    var error: String?
}

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let queue = DispatchQueue(label:"choir.audio")
    var armed = false
    var started = false
    var count = 0
    var error: Error?
    init(url: URL) throws {
        writer = try AVAssetWriter(outputURL:url,fileType:.m4a)
        input = AVAssetWriterInput(mediaType:.audio,outputSettings:[AVFormatIDKey:kAudioFormatMPEG4AAC,AVSampleRateKey:48000,AVNumberOfChannelsKey:2,AVEncoderBitRateKey:192000])
        input.expectsMediaDataInRealTime = true
        writer.add(input)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard armed, type == .audio, sample.isValid, CMSampleBufferDataIsReady(sample) else { return }
        if !started {
            guard writer.startWriting() else { error = writer.error; return }
            writer.startSession(atSourceTime:sample.presentationTimeStamp); started = true
        }
        if input.isReadyForMoreMediaData {
            if input.append(sample) { count += 1 } else { error = writer.error }
        } else { error = problem("Audio encoder dropped a buffer") }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { self.error = error }
    func finish() async throws {
        queue.sync { armed = false }
        guard started else { throw problem("No audio received from dedicated player") }
        input.markAsFinished(); await writer.finishWriting()
        if let error { throw error }
        guard writer.status == .completed else { throw writer.error ?? problem("Audio writer did not finish") }
    }
}

@MainActor final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var tracks: [Track] = []
    var stream: SCStream?
    let manifestURL = outputRoot.appendingPathComponent("capture-manifest.json")
    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame:.zero,configuration:config)
        web.navigationDelegate = self
        window = NSWindow(contentRect:NSRect(x:80,y:80,width:1050,height:750),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
        window.title = "ChoirCapture — Dropbox audio only"
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps:true)
        Task { await run() }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        // Top-level navigation is restricted to the supplied Dropbox share.
        if navigationAction.targetFrame?.isMainFrame == true {
            let allowed = url.host == "www.dropbox.com" && url.path.hasPrefix("/scl/fo/kyd9f5krh3yi9jwmfane0/")
            return allowed ? .allow : .cancel
        }
        return .allow
    }
    func js(_ script: String) async throws -> Any { try await web.evaluateJavaScript(script) }
    func load(_ url: String) async throws {
        guard let target = URL(string:url), target.host == "www.dropbox.com", target.path.hasPrefix("/scl/fo/kyd9f5krh3yi9jwmfane0/") else { throw problem("URL outside authorized share") }
        web.load(URLRequest(url:target))
        try await pause(1)
        for _ in 0..<60 {
            if !web.isLoading, (try? await js("document.readyState")) as? String == "complete" { return }
            try await pause(0.5)
        }
        throw problem("Page load timed out: \(url)")
    }
    func save() throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted,.sortedKeys,.withoutEscapingSlashes]
        try encoder.encode(tracks).write(to:manifestURL,options:.atomic)
    }
    func inventory() async throws {
        var folders: [(String,String)] = [("",rootLink)]
        var visited = Set<String>()
        while !folders.isEmpty {
            let (prefix,url) = folders.removeFirst()
            guard visited.insert(prefix).inserted else { continue }
            try await load(url)
            var links: [[String:String]] = []
            for _ in 0..<40 {
                links = (try await js("Array.from(document.querySelectorAll('table a[href], [role=table] a[href]')).map(a=>({name:(a.innerText||a.getAttribute('aria-label')||'').trim(),url:a.href})).filter(a=>a.url.includes('/scl/fo/'))")) as? [[String:String]] ?? []
                if !links.isEmpty { break }
                try await pause(0.5)
            }
            guard !links.isEmpty else { throw problem("No folder entries at \(prefix): \((try? await js("document.body.innerText.slice(0,1000)")) ?? "")") }
            log("FOLDER \(prefix.isEmpty ? "/" : prefix): \(links.count) entries")
            for link in links {
                guard let url = link["url"], let name = URL(string:url)?.lastPathComponent, !name.isEmpty, !name.contains("/"), name != ".." else { continue }
                let path = prefix.isEmpty ? name : prefix + "/" + name
                let ext = (name as NSString).pathExtension.lowercased()
                if ["m4a","mp3","wav","aac","aiff","flac","ogg"].contains(ext) {
                    if !tracks.contains(where:{$0.path == path}) { tracks.append(Track(path:path,url:url)) }
                } else if ext.isEmpty { folders.append((path,url)) }
                else { log("NONAUDIO \(path)") }
            }
        }
        tracks.sort { $0.path < $1.path }; try save()
        log("INVENTORY_COMPLETE \(tracks.count) tracks")
    }
    func prepare(_ track: Track) async throws -> Double {
        try await load(track.url)
        for _ in 0..<80 {
            let value = try await js("(()=>{const m=document.querySelector('audio,video');return m&&Number.isFinite(m.duration)&&m.duration>0?m.duration:0})()")
            if let duration = value as? Double, duration > 0 { return duration }
            try await pause(0.5)
        }
        throw problem("Audio player failed to become ready")
    }
    func startCapture(_ sink: Sink) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
        guard let own = content.applications.first(where:{$0.processID == getpid()}), let display = content.displays.first else { throw problem("Dedicated player not available for capture") }
        log("CAPTURE_SCOPE ownProcess=\(getpid()) bundle=\(own.bundleIdentifier); microphone=off; video=not-saved")
        let filter = SCContentFilter(display:display,including:[own],exceptingWindows:[])
        let config = SCStreamConfiguration()
        config.width=2; config.height=2; config.minimumFrameInterval=CMTime(value:1,timescale:1)
        config.capturesAudio=true; config.excludesCurrentProcessAudio=false
        config.sampleRate=48000; config.channelCount=2
        if #available(macOS 15.0, *) { config.captureMicrophone=false }
        let capture = SCStream(filter:filter,configuration:config,delegate:sink)
        try capture.addStreamOutput(sink,type:.audio,sampleHandlerQueue:sink.queue)
        try await capture.startCapture(); stream=capture
    }
    func record(_ index: Int) async throws {
        let disk = try fm.attributesOfFileSystem(forPath:outputRoot.path)
        guard (disk[.systemFreeSize] as? NSNumber)?.int64Value ?? 0 > 5_000_000_000 else { throw problem("Stopped: less than 5 GB free") }
        let duration = try await prepare(tracks[index])
        tracks[index].sourceDuration=duration; try save()
        let dest = outputRoot.appendingPathComponent(tracks[index].path)
        let final = dest.deletingPathExtension().appendingPathExtension("m4a")
        let temp = final.deletingPathExtension().appendingPathExtension("partial.m4a")
        try fm.createDirectory(at:final.deletingLastPathComponent(),withIntermediateDirectories:true)
        if fm.fileExists(atPath:temp.path) { try fm.removeItem(at:temp) }
        let sink=try Sink(url:temp)
        try await startCapture(sink)
        sink.queue.sync { sink.armed=true }
        log("RECORD \(index+1)/\(tracks.count) \(tracks[index].path) duration=\(duration)")
        _ = try await js("(()=>{let m=document.querySelector('audio,video');m.currentTime=0;m.playbackRate=1;m.muted=false;m.volume=1;m.loop=false;m.play();return true})()")
        let began=Date(); var ended=false; var lastTime:Double=0; var stalledAt=Date()
        while Date().timeIntervalSince(began) < duration+60 {
            try await pause(0.25)
            let status=try await js("(()=>{const m=document.querySelector('audio,video');return {time:m.currentTime,ended:m.ended,paused:m.paused,error:m.error?m.error.message:null}})()") as? [String:Any] ?? [:]
            if let e=status["error"] as? String { throw problem(e) }
            if status["ended"] as? Bool == true { ended=true; break }
            let t=status["time"] as? Double ?? 0
            if t > lastTime+0.01 { lastTime=t; stalledAt=Date() }
            if Date().timeIntervalSince(stalledAt)>20 { throw problem("Player stalled at \(t)") }
        }
        _ = try? await js("document.querySelector('audio,video').pause();true")
        try await stream?.stopCapture(); stream=nil
        try await sink.finish()
        guard ended else { throw problem("Playback did not reach the end") }
        let stats=try analyze(temp)
        guard stats.duration >= duration-0.15, stats.duration <= duration+3 else { throw problem("Duration mismatch source=\(duration) recorded=\(stats.duration)") }
        guard stats.peak>0.0001 else { throw problem("Captured audio is silent; not accepting this file") }
        guard !fm.fileExists(atPath:final.path) else { throw problem("Refusing to overwrite existing unverified file: \(final.path)") }
        try fm.moveItem(at:temp,to:final)
        tracks[index].recordedDuration=stats.duration; tracks[index].peak=stats.peak
        tracks[index].bytes=(try fm.attributesOfItem(atPath:final.path)[.size] as? NSNumber)?.intValue
        tracks[index].status="complete"; tracks[index].error=nil; try save()
        log("VERIFIED \(tracks[index].path) duration=\(stats.duration) peak=\(stats.peak) bytes=\(tracks[index].bytes ?? 0)")
    }
    func analyze(_ url: URL) throws -> (duration:Double,peak:Float) {
        let file=try AVAudioFile(forReading:url)
        guard let buffer=AVAudioPCMBuffer(pcmFormat:file.processingFormat,frameCapacity:8192) else { throw problem("Cannot allocate verification buffer") }
        var peak:Float=0
        while file.framePosition<file.length {
            try file.read(into:buffer)
            guard let data=buffer.floatChannelData else { throw problem("Cannot decode audio") }
            for c in 0..<Int(buffer.format.channelCount) { for f in 0..<Int(buffer.frameLength) { peak=max(peak,abs(data[c][f])) } }
        }
        return (Double(file.length)/file.processingFormat.sampleRate,peak)
    }
    func run() async {
        do {
            try fm.createDirectory(at:outputRoot,withIntermediateDirectories:true)
            if let data=try? Data(contentsOf:manifestURL) { tracks=try JSONDecoder().decode([Track].self,from:data) }
            log("START audio-only dedicated Dropbox player; no video output; 192 kbps AAC")
            try await inventory()
            for index in tracks.indices {
                if tracks[index].status=="complete" { continue }
                do { try await record(index) }
                catch {
                    _ = try? await js("document.querySelector('audio,video')?.pause();true")
                    try? await stream?.stopCapture(); stream=nil
                    tracks[index].status="failed"; tracks[index].error=error.localizedDescription; try save()
                    throw error
                }
            }
            log("COMPLETE \(tracks.count) tracks; bytes=\(tracks.compactMap(\.bytes).reduce(0,+))")
            NSApp.terminate(nil)
        } catch { log("FAILED \(error.localizedDescription)"); window.title="ChoirCapture — stopped: \(error.localizedDescription)" }
    }
}
@main struct Main {
    @MainActor static func main() {
        let app=NSApplication.shared
        let delegate=App()
        app.setActivationPolicy(.regular)
        app.delegate=delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
