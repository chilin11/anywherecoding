// Runs the server bundled inside AnywhereCoding.app (Contents/Resources/server, Contents/Resources/node)
// as a child process. The menu-bar-only build (scripts/menubar.mjs) has no bundled server and only monitors.
import Darwin
import Foundation

/// `$ANYWHERE_HOME`, default `~/.anywherecoding`.
func dataDirectory() -> URL {
  let home = ProcessInfo.processInfo.environment["ANYWHERE_HOME"].flatMap { $0.isEmpty ? nil : $0 }
    ?? (NSHomeDirectory() as NSString).appendingPathComponent(".anywherecoding")
  return URL(fileURLWithPath: home)
}

func configFile() -> URL { dataDirectory().appendingPathComponent("config.json") }

func readConfigJSON() -> [String: Any]? {
  guard let data = try? Data(contentsOf: configFile()) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// True when nothing listens on the port (IPv4 any address, like the server's default host).
func portIsFree(_ port: Int) -> Bool {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  guard fd >= 0 else { return false }
  defer { close(fd) }
  // Like Node's listen: lingering TIME_WAIT connections from a just-stopped server do not block the port.
  var reuse: Int32 = 1
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
  var address = sockaddr_in()
  address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = in_port_t(UInt16(port).bigEndian)
  address.sin_addr = in_addr(s_addr: INADDR_ANY)
  return withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
  } == 0
}

/// First non-loopback IPv4 address of a Wi-Fi/Ethernet interface, for phones on the same network.
func lanAddress() -> String? {
  var list: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&list) == 0, let first = list else { return nil }
  defer { freeifaddrs(list) }
  var candidates: [(String, String)] = []
  for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
    let entry = pointer.pointee
    guard let addr = entry.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
          entry.ifa_flags & UInt32(IFF_UP) != 0, entry.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
    candidates.append((String(cString: entry.ifa_name), String(cString: host)))
  }
  return (candidates.first { $0.0.hasPrefix("en") } ?? candidates.first)?.1
}

/// GUI apps start with a minimal PATH; Codex, Claude and Pi are usually found through the login shell's PATH.
func loginShellPath() -> String {
  let fallback = ["/opt/homebrew/bin", "/usr/local/bin", "\(NSHomeDirectory())/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
  let process = Process()
  process.executableURL = URL(fileURLWithPath: shell)
  process.arguments = ["-ilc", "printf '__AW_PATH__%s__AW_PATH__' \"$PATH\""]
  let pipe = Pipe()
  process.standardOutput = pipe
  process.standardError = FileHandle.nullDevice
  process.standardInput = FileHandle.nullDevice
  // Collect output as it arrives: a noisy rc file must not fill the pipe, and a background job that
  // inherits stdout must not block a final read.
  let lock = NSLock()
  var collected = Data()
  pipe.fileHandleForReading.readabilityHandler = { handle in
    let chunk = handle.availableData
    if chunk.isEmpty { handle.readabilityHandler = nil; return } // EOF
    lock.lock(); collected.append(chunk); lock.unlock()
  }
  var found: [String] = []
  if (try? process.run()) != nil {
    let deadline = Date().addingTimeInterval(5)
    while process.isRunning && Date() < deadline { usleep(50_000) }
    if process.isRunning { process.terminate() }
    usleep(100_000)
  }
  pipe.fileHandleForReading.readabilityHandler = nil
  lock.lock(); let output = String(decoding: collected, as: UTF8.self); lock.unlock()
  if let range = output.range(of: "__AW_PATH__(.*?)__AW_PATH__", options: .regularExpression) {
    found = String(output[range]).replacingOccurrences(of: "__AW_PATH__", with: "").split(separator: ":").map(String.init)
  }
  var seen = Set<String>()
  return (found + fallback).filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
}

final class ServerHost {
  enum Phase: Equatable {
    case preparing
    /// Another AnywhereCoding server (e.g. the LaunchAgent) already serves the port; only monitor it.
    case external
    case starting
    case running
    case failed(String)
    case stopped
  }

  let resources: URL
  let node: URL
  let main: URL
  private(set) var phase: Phase = .preparing { didSet { if phase != oldValue { onChange?() } } }
  var onChange: (() -> Void)?
  private var process: Process?
  private var stopping = false
  private var exits: [Date] = []
  private var path = ""
  private let queue = DispatchQueue(label: "anywherecoding.server-host")
  private var pidFile: URL { dataDirectory().appendingPathComponent("app-server.pid") }
  var logsDirectory: URL { dataDirectory().appendingPathComponent("logs") }

  /// nil unless this app bundle carries the server and its Node runtime.
  static func bundled() -> ServerHost? {
    guard let resources = Bundle.main.resourceURL else { return nil }
    let node = resources.appendingPathComponent("node/bin/node")
    let main = resources.appendingPathComponent("server/main.ts")
    guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: main.path) else { return nil }
    return ServerHost(resources: resources, node: node, main: main)
  }

  private init(resources: URL, node: URL, main: URL) {
    self.resources = resources
    self.node = node
    self.main = main
  }

  private func set(_ next: Phase) { DispatchQueue.main.async { self.phase = next } }

  /// Decide between starting the bundled server and monitoring one that already runs.
  func boot() {
    queue.async { [self] in bootLocked() }
  }

  private func bootLocked() {
    guard process == nil else { return }
    exits.removeAll()
    // A downloaded app keeps quarantine on nested files; the user already approved this app.
    removexattr(node.path, "com.apple.quarantine", 0)
    reapOrphan()
    let port = choosePort()
    switch probe(port) {
    case .anywhere:
      set(.external)
      return
    case .other:
      let file = (configFile().path as NSString).abbreviatingWithTildeInPath
      set(.failed("端口 \(port) 被其他程序占用。修改 \(file) 中的 port 后点“重启服务”。"))
      return
    case .none:
      break
    }
    if path.isEmpty { path = loginShellPath() }
    spawn()
  }

  private enum ProbeResult { case none, anywhere, other }

  /// Our server marks responses with `X-AnywhereCoding`; versions before 0.2 only identify by the page title.
  private func probe(_ port: Int) -> ProbeResult {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/")!)
    request.timeoutInterval = 2
    let done = DispatchSemaphore(value: 0)
    var result = ProbeResult.none
    URLSession(configuration: .ephemeral).dataTask(with: request) { data, response, _ in
      if let http = response as? HTTPURLResponse {
        let page = data.map { String(decoding: $0.prefix(4096), as: UTF8.self) } ?? ""
        let ours = http.value(forHTTPHeaderField: "X-AnywhereCoding") != nil || page.contains("<title>AnywhereCoding</title>")
        result = ours ? .anywhere : .other
      }
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 3)
    if result == .none && !portIsFree(port) { result = .other }
    return result
  }

  /// The configured port, or on first run the first free port from 8787, written to config.json for the server.
  private func choosePort() -> Int {
    if let config = readConfigJSON() { return (config["port"] as? Int) ?? 8787 }
    let port = (8787...8799).first(where: portIsFree) ?? 8787
    try? FileManager.default.createDirectory(at: dataDirectory(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if let data = try? JSONSerialization.data(withJSONObject: ["port": port], options: [.prettyPrinted]) {
      FileManager.default.createFile(atPath: configFile().path, contents: data, attributes: [.posixPermissions: 0o600])
    }
    return port
  }

  /// A server left behind by a crashed app instance still holds the port; stop it if it is ours.
  private func reapOrphan() {
    guard let text = try? String(contentsOf: pidFile, encoding: .utf8), let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 else { return }
    defer { try? FileManager.default.removeItem(at: pidFile) }
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-o", "command=", "-p", String(pid)]
    let pipe = Pipe()
    ps.standardOutput = pipe
    guard (try? ps.run()) != nil else { return }
    ps.waitUntilExit()
    let command = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    guard command.contains(main.path) else { return }
    kill(pid, SIGTERM)
    for _ in 0..<40 where kill(pid, 0) == 0 { usleep(100_000) }
    if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
  }

  private func logHandle(_ name: String) -> FileHandle {
    try? FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = logsDirectory.appendingPathComponent(name)
    if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
    let handle = (try? FileHandle(forWritingTo: file)) ?? FileHandle.nullDevice
    _ = try? handle.seekToEnd()
    return handle
  }

  private func spawn() {
    stopping = false
    set(.starting)
    let process = Process()
    process.executableURL = node
    process.arguments = [main.path]
    process.currentDirectoryURL = resources
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = path
    environment["ANYWHERE_HOME"] = dataDirectory().path
    process.environment = environment
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = logHandle("server.log")
    process.standardError = logHandle("error.log")
    process.terminationHandler = { [weak self] finished in
      self?.queue.async { self?.exited(finished) }
    }
    do {
      try process.run()
      self.process = process
      try? String(process.processIdentifier).write(to: pidFile, atomically: true, encoding: .utf8)
      set(.running)
    } catch {
      set(.failed("无法启动内置 Node：\(error.localizedDescription)"))
    }
  }

  private func exited(_ finished: Process) {
    guard finished === process else { return }
    process = nil
    try? FileManager.default.removeItem(at: pidFile)
    if stopping { set(.stopped); return }
    let now = Date()
    exits = exits.filter { now.timeIntervalSince($0) < 60 } + [now]
    let reason = "服务已退出（\(finished.terminationReason == .uncaughtSignal ? "信号" : "代码") \(finished.terminationStatus)）"
    if exits.count > 4 {
      set(.failed("\(reason)，一分钟内多次退出，已停止重试。查看日志：\(logsDirectory.path)/error.log"))
      return
    }
    set(.starting)
    queue.asyncAfter(deadline: .now() + 2) { [self] in if process == nil && !stopping { spawn() } }
  }

  /// SIGTERM lets the server stop the Codex/Claude/Pi processes it owns; force after a few seconds.
  private func terminate() {
    stopping = true
    guard let process, process.isRunning else { return }
    process.terminate()
    for _ in 0..<50 where process.isRunning { usleep(100_000) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    process.waitUntilExit()
  }

  /// Restart an owned server, or retry after a failure/stop (probing the port again).
  func restart() {
    queue.async { [self] in
      terminate()
      process = nil
      try? FileManager.default.removeItem(at: pidFile)
      bootLocked()
    }
  }

  /// Blocking stop used while the app quits.
  func stopNow() {
    queue.sync {
      terminate()
      if process?.isRunning == false { try? FileManager.default.removeItem(at: pidFile) }
    }
  }

  var ownsServer: Bool {
    switch phase {
    case .starting, .running: return true
    default: return false
    }
  }
}
