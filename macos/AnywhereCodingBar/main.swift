// AnywhereCoding menu bar app.
// Inside AnywhereCoding.app (scripts/macapp.mjs) it runs the bundled server itself (ServerHost).
// Built alone by scripts/menubar.mjs it only monitors a server run by the LaunchAgent.
import AppKit
import ServiceManagement

let serviceLabel = "io.github.chilin11.anywherecoding"
let pollInterval: TimeInterval = 3
/// While the bundled server boots, connection errors mean "starting", not "broken".
let startGrace: TimeInterval = 20
let selfTesting = CommandLine.arguments.contains("--self-test")

struct ActiveSession: Decodable {
  let id: String
  let agent: String
  let title: String
  let cwd: String?
  let status: String
}

struct Availability: Decodable {
  let agent: String
  let ok: Bool
  let reason: String?
  let warning: String?
}

struct StatusSnapshot: Decodable {
  let version: String
  let running: Int
  let approval: Int
  let unknown: Int
  let active: [ActiveSession]
  let agents: [Availability]
  let errors: [String: String]
}

struct ServerConfig {
  let base: URL
  let token: String
  let port: Int
  /// False when the server only listens on loopback, so phones cannot reach it.
  let lan: Bool

  /// Reads host/port/token from `$ANYWHERE_HOME/config.json` (default `~/.anywherecoding`). The token never leaves memory.
  static func load() throws -> ServerConfig {
    let data = try Data(contentsOf: configFile())
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let token = json["token"] as? String, !token.isEmpty
    else { throw NSError(domain: "AnywhereCoding", code: 1, userInfo: [NSLocalizedDescriptionKey: "config.json 缺少 token"]) }
    let port = (json["port"] as? Int) ?? 8787
    let configured = (json["host"] as? String) ?? "0.0.0.0"
    var host = configured
    let wildcard = host.isEmpty || host == "0.0.0.0" || host == "::" || host == "[::]"
    if wildcard { host = "127.0.0.1" }
    if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
    guard let base = URL(string: "http://\(host):\(port)/") else {
      throw NSError(domain: "AnywhereCoding", code: 2, userInfo: [NSLocalizedDescriptionKey: "无效地址 \(host):\(port)"])
    }
    return ServerConfig(base: base, token: token, port: port, lan: wildcard)
  }

  var lanURL: String? {
    guard lan, let address = lanAddress() else { return nil }
    return "http://\(address):\(port)/"
  }
}

enum Connection {
  case loading(String)
  case online(StatusSnapshot)
  case offline(String)
}

func agentName(_ agent: String) -> String {
  switch agent {
  case "codex": return "Codex"
  case "claude": return "Claude"
  case "pi": return "PI-Desktop"
  case "pi-native": return "Pi CLI"
  default: return agent
  }
}

func shorten(_ text: String, _ limit: Int) -> String {
  let flat = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
  return flat.count > limit ? String(flat.prefix(limit - 1)) + "…" : flat
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  let host = ServerHost.bundled()
  private var timer: Timer?
  private var state: Connection = .loading("正在连接…")
  private var config: ServerConfig?
  private var inFlight = false
  private var startedAt = Date()
  private var failures = 0
  private var isMenuOpen = false
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 4
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: configuration)
  }()

  func applicationDidFinishLaunching(_ notification: Notification) {
    menu.delegate = self
    menu.autoenablesItems = false
    item.menu = menu
    item.button?.imagePosition = .imageLeading
    item.button?.toolTip = "AnywhereCoding"
    if let host {
      host.onChange = { [weak self] in self?.hostChanged() }
      if !selfTesting && !warnIfNotInstalled() { return }
      host.boot()
      if !selfTesting { enableLoginItemOnce() }
    }
    render()
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in self?.poll() }
    timer?.tolerance = 0.5
    if selfTesting { selfTest() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    host?.stopNow()
  }

  /// Diagnostics without screen-recording permission: report the status item and state, then quit (stopping an owned server).
  private func selfTest() {
    let delay = Double(ProcessInfo.processInfo.environment["AW_SELFTEST_DELAY"] ?? "") ?? 2.5
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
      rebuildMenu()
      let button = item.button
      let frame = button?.window?.frame ?? .zero
      var phase = ""
      switch displayState {
      case .loading(let text): phase = "loading \(text)"
      case .online(let snapshot): phase = "online running=\(snapshot.running) approval=\(snapshot.approval) active=\(snapshot.active.count)"
      case .offline(let reason): phase = "offline \(reason)"
      }
      print("visible=\(item.isVisible) frame=\(frame) image=\(button?.image != nil) title='\(button?.title ?? "")'")
      print("mode=\(host == nil ? "monitor" : "bundled") host=\(host.map { "\($0.phase)" } ?? "-") base=\(config?.base.absoluteString ?? "-")")
      print("state=\(phase)")
      print("menu=" + menu.items.map { $0.isSeparatorItem ? "—" : $0.title }.joined(separator: " | "))
      fflush(stdout)
      NSApp.terminate(nil)
    }
  }

  // MARK: Install location and login item

  /// The DMG volume or a translocated (quarantined, unmoved) copy: a temporary path.
  private var runningFromTemporaryLocation: Bool {
    let path = Bundle.main.bundlePath
    return path.hasPrefix("/Volumes/") || path.contains("/AppTranslocation/")
  }

  /// Running from the DMG or a translocated copy breaks login items and updates; ask to move the app first.
  private func warnIfNotInstalled() -> Bool {
    guard runningFromTemporaryLocation else { return true }
    let alert = NSAlert()
    alert.messageText = "请先把 AnywhereCoding 拖到“应用程序”文件夹"
    alert.informativeText = "从安装盘或下载位置直接运行时，开机自启动和后续更新都无法正常工作。\n\n拖到“应用程序”后，从那里重新打开。"
    alert.addButton(withTitle: "退出")
    alert.addButton(withTitle: "仍然运行")
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn {
      NSApp.terminate(nil)
      return false
    }
    return true
  }

  /// First run from a real install location adds a login item; later the menu toggle decides.
  private func enableLoginItemOnce() {
    let key = "loginItemConfigured"
    guard !runningFromTemporaryLocation, !UserDefaults.standard.bool(forKey: key) else { return }
    UserDefaults.standard.set(true, forKey: key)
    try? SMAppService.mainApp.register()
  }

  private var loginEnabled: Bool { SMAppService.mainApp.status == .enabled }

  @objc private func toggleLogin() {
    do {
      if loginEnabled {
        try SMAppService.mainApp.unregister()
      } else {
        try SMAppService.mainApp.register()
        if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
      }
    } catch {
      let alert = NSAlert()
      alert.messageText = "无法修改开机启动"
      alert.informativeText = "\(error.localizedDescription)\n\n可以在“系统设置 › 通用 › 登录项”中手动添加 AnywhereCoding。"
      alert.addButton(withTitle: "打开系统设置")
      alert.addButton(withTitle: "好")
      NSApp.activate(ignoringOtherApps: true)
      if alert.runModal() == .alertFirstButtonReturn { SMAppService.openSystemSettingsLoginItems() }
    }
  }

  // MARK: First run

  private func welcomeIfNeeded(_ loaded: ServerConfig) {
    let key = "welcomed"
    guard host != nil, !selfTesting, !UserDefaults.standard.bool(forKey: key) else { return }
    UserDefaults.standard.set(true, forKey: key)
    let alert = NSAlert()
    alert.messageText = "AnywhereCoding 已在运行"
    var lines = ["本机：\(loaded.base.absoluteString)"]
    if let lan = loaded.lanURL { lines.append("手机（同一 Wi-Fi）：\(lan)") }
    lines.append("")
    lines.append("网页首次打开需要输入登录令牌，点“打开网页”会自动复制令牌，粘贴即可。")
    lines.append("之后可从菜单栏的 </> 图标打开网页、复制地址和令牌。")
    alert.informativeText = lines.joined(separator: "\n")
    alert.addButton(withTitle: "打开网页（复制令牌）")
    alert.addButton(withTitle: "稍后")
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() == .alertFirstButtonReturn {
      copy(loaded.token)
      NSWorkspace.shared.open(loaded.base)
    }
  }

  // MARK: Polling

  private func hostChanged() {
    guard let host else { return }
    switch host.phase {
    case .starting:
      startedAt = Date()
      failures = 0
    case .running, .external, .preparing, .stopped, .failed:
      break
    }
    render()
    if isMenuOpen { rebuildMenu() }
    poll()
  }

  /// Managed server still booting: show progress instead of a connection error.
  private var booting: Bool {
    guard let host else { return false }
    switch host.phase {
    case .preparing, .starting: return true
    case .running: return Date().timeIntervalSince(startedAt) < startGrace
    default: return false
    }
  }

  private func poll() {
    if inFlight { return }
    let loaded: ServerConfig
    do { loaded = try ServerConfig.load() } catch {
      config = nil
      update(booting ? .loading("正在启动服务…") : .offline("读取配置失败：\(error.localizedDescription)"))
      return
    }
    config = loaded
    var request = URLRequest(url: loaded.base.appendingPathComponent("api/status"))
    request.setValue("Bearer \(loaded.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    inFlight = true
    session.dataTask(with: request) { [weak self] data, response, error in
      let next: Connection
      if let error {
        next = .offline("服务未连接：\(error.localizedDescription)")
      } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
        next = .offline(http.statusCode == 401 ? "令牌无效（401）" : "服务返回 HTTP \(http.statusCode)")
      } else if let data, let snapshot = try? JSONDecoder().decode(StatusSnapshot.self, from: data) {
        next = .online(snapshot)
      } else {
        next = .offline("无法解析状态（服务版本过旧？请重启服务）")
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.inFlight = false
        self.received(next, loaded)
      }
    }.resume()
  }

  private func received(_ next: Connection, _ loaded: ServerConfig) {
    switch next {
    case .online:
      failures = 0
      update(next)
      welcomeIfNeeded(loaded)
    case .offline:
      failures += 1
      if booting {
        update(.loading("正在启动服务…"))
      } else {
        update(next)
        // The external server went away (e.g. its LaunchAgent was removed): take over with the bundled one.
        if let host, host.phase == .external, failures >= 3 {
          failures = 0
          host.boot()
        }
      }
    case .loading:
      update(next)
    }
  }

  private func update(_ next: Connection) {
    state = next
    render()
    // Keep an open menu current.
    if isMenuOpen { rebuildMenu() }
  }

  /// A failed or stopped bundled server outranks the last poll result.
  private var displayState: Connection {
    if let host {
      if case .failed(let reason) = host.phase { return .offline(reason) }
      if host.phase == .stopped { return .offline("服务已停止") }
    }
    return state
  }

  // MARK: Status item

  private func render() {
    guard let button = item.button else { return }
    let symbol: String
    var title = ""
    var tint: NSColor? = nil
    var tip = "AnywhereCoding"
    switch displayState {
    case .loading(let text):
      symbol = "chevron.left.forwardslash.chevron.right"
      tint = .systemGray
      tip = "AnywhereCoding：\(text)"
    case .offline(let reason):
      symbol = "bolt.horizontal.circle"
      tint = .systemGray
      tip = "AnywhereCoding：\(reason)"
    case .online(let snapshot):
      if snapshot.approval > 0 {
        symbol = "hand.raised.fill"
        tint = .systemOrange
        title = snapshot.running > 0 ? " \(snapshot.approval)!  \(snapshot.running)" : " \(snapshot.approval)!"
      } else if snapshot.running > 0 {
        symbol = "circle.dotted.circle"
        title = " \(snapshot.running)"
      } else {
        symbol = "chevron.left.forwardslash.chevron.right"
      }
      tip = "AnywhereCoding：运行中 \(snapshot.running)，待审批 \(snapshot.approval)"
    }
    let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "AnywhereCoding")
    image?.isTemplate = true
    button.image = image
    button.contentTintColor = tint
    button.title = title
    button.toolTip = tip
    button.font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .medium)
  }

  // MARK: Menu

  func menuWillOpen(_ menu: NSMenu) {
    isMenuOpen = true
    poll()
  }

  func menuDidClose(_ menu: NSMenu) { isMenuOpen = false }

  func menuNeedsUpdate(_ menu: NSMenu) { rebuildMenu() }

  private func rebuildMenu() {
    menu.removeAllItems()
    switch displayState {
    case .loading(let text):
      menu.addItem(disabled("AnywhereCoding · \(text)"))
    case .offline(let reason):
      menu.addItem(disabled("AnywhereCoding · 未连接"))
      for line in wrap(reason, 60).prefix(4) { menu.addItem(disabled(line)) }
    case .online(let snapshot):
      menu.addItem(disabled("AnywhereCoding v\(snapshot.version) · 服务正常"))
      menu.addItem(disabled("运行中 \(snapshot.running)　待审批 \(snapshot.approval)"))
      menu.addItem(.separator())
      if snapshot.active.isEmpty {
        menu.addItem(disabled("没有进行中的会话"))
      } else {
        menu.addItem(disabled("进行中的会话"))
        for session in snapshot.active.prefix(12) {
          let mark = session.status == "approval" ? "✋" : "●"
          let folder = session.cwd.map { " — " + (($0 as NSString).lastPathComponent) } ?? ""
          let entry = NSMenuItem(title: "\(mark) \(agentName(session.agent))：\(shorten(session.title, 40))\(folder)", action: #selector(openSession(_:)), keyEquivalent: "")
          entry.target = self
          entry.representedObject = session.id
          entry.toolTip = session.status == "approval" ? "等待审批，点击打开处理" : "运行中，点击打开"
          menu.addItem(entry)
        }
      }
      menu.addItem(.separator())
      let warned = snapshot.agents.contains { $0.warning != nil }
      let agents = NSMenuItem(title: warned ? "连接 ⚠" : "连接", action: nil, keyEquivalent: "")
      let agentsMenu = NSMenu()
      if snapshot.agents.isEmpty { agentsMenu.addItem(disabled("尚未添加连接（在网页的“连接”中添加）")) }
      for agent in snapshot.agents {
        agentsMenu.addItem(disabled("\(agent.ok ? "✓" : "✕") \(agentName(agent.agent))\(agent.ok ? "" : "：" + shorten(agent.reason ?? "不可用", 50))"))
        if let warning = agent.warning { agentsMenu.addItem(disabled("　⚠ \(shorten(warning, 60))")) }
      }
      agents.submenu = agentsMenu
      menu.addItem(agents)
      if !snapshot.errors.isEmpty {
        let errors = NSMenuItem(title: "错误 \(snapshot.errors.count)", action: nil, keyEquivalent: "")
        let errorsMenu = NSMenu()
        for (agent, message) in snapshot.errors.sorted(by: { $0.key < $1.key }) {
          errorsMenu.addItem(disabled("\(agentName(agent))：\(shorten(message, 70))"))
        }
        errors.submenu = errorsMenu
        menu.addItem(errors)
      }
    }
    menu.addItem(.separator())
    menu.addItem(action("打开 AnywhereCoding", #selector(openWeb), "o"))
    menu.addItem(action("复制登录令牌", #selector(copyToken), ""))
    if let lan = config?.lanURL {
      let entry = action("复制手机访问地址", #selector(copyLan(_:)), "")
      entry.representedObject = lan
      entry.toolTip = "\(lan)（手机需连同一 Wi-Fi）"
      menu.addItem(entry)
    }
    menu.addItem(.separator())
    if host != nil {
      let login = action("开机时启动", #selector(toggleLogin), "")
      login.state = loginEnabled ? .on : .off
      menu.addItem(login)
    }
    menu.addItem(action("显示日志", #selector(showLogs), ""))
    menu.addItem(action("重启服务…", #selector(restartService), ""))
    menu.addItem(.separator())
    let quitTitle = host?.ownsServer == true ? "退出 AnywhereCoding（停止服务）" : (host != nil ? "退出 AnywhereCoding" : "退出状态栏图标")
    menu.addItem(action(quitTitle, #selector(quit), "q"))
  }

  private func wrap(_ text: String, _ width: Int) -> [String] {
    var lines: [String] = []
    var rest = Substring(text.replacingOccurrences(of: "\n", with: " "))
    while !rest.isEmpty {
      lines.append(String(rest.prefix(width)))
      rest = rest.dropFirst(width)
    }
    return lines
  }

  private func disabled(_ title: String) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    entry.isEnabled = false
    return entry
  }

  private func action(_ title: String, _ selector: Selector, _ key: String) -> NSMenuItem {
    let entry = NSMenuItem(title: title, action: selector, keyEquivalent: key)
    entry.target = self
    return entry
  }

  // MARK: Actions

  private func baseURL() -> URL {
    if let config { return config.base }
    return (try? ServerConfig.load().base) ?? URL(string: "http://127.0.0.1:8787/")!
  }

  private func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  @objc private func openWeb() {
    NSWorkspace.shared.open(baseURL())
  }

  @objc private func openSession(_ sender: NSMenuItem) {
    guard let id = sender.representedObject as? String else { return }
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
    guard let url = URL(string: "#/s/\(encoded)", relativeTo: baseURL()) else { return }
    NSWorkspace.shared.open(url.absoluteURL)
  }

  @objc private func copyToken() {
    guard let token = (try? ServerConfig.load())?.token else { return }
    copy(token)
  }

  @objc private func copyLan(_ sender: NSMenuItem) {
    guard let lan = sender.representedObject as? String else { return }
    copy(lan)
  }

  @objc private func showLogs() {
    let logs = host?.logsDirectory ?? dataDirectory().appendingPathComponent("logs")
    let error = logs.appendingPathComponent("error.log")
    if FileManager.default.fileExists(atPath: error.path) {
      NSWorkspace.shared.activateFileViewerSelecting([error])
    } else {
      NSWorkspace.shared.open(FileManager.default.fileExists(atPath: logs.path) ? logs : dataDirectory())
    }
  }

  private var activeCounts: (running: Int, approval: Int)? {
    guard case .online(let snapshot) = state, snapshot.running + snapshot.approval > 0 else { return nil }
    return (snapshot.running, snapshot.approval)
  }

  @objc private func restartService() {
    let alert = NSAlert()
    alert.messageText = "重启 AnywhereCoding 服务？"
    var detail = "网页连接会短暂中断。PI-Desktop 会话不受影响。"
    if let counts = activeCounts {
      detail = "当前有 \(counts.running) 个运行中、\(counts.approval) 个待审批的会话。重启会中断由本服务启动的 Codex / Claude 任务。\n\n" + detail
      alert.alertStyle = .warning
    }
    alert.informativeText = detail
    alert.addButton(withTitle: "重启")
    alert.addButton(withTitle: "取消")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    if let host, host.phase != .external {
      update(.loading("正在重启服务…"))
      host.restart()
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["kickstart", "-k", "gui/\(getuid())/\(serviceLabel)"]
    process.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async {
        if finished.terminationStatus != 0 {
          self?.update(.offline("重启失败（launchctl 退出码 \(finished.terminationStatus)），服务是否由 LaunchAgent 运行？"))
        } else {
          self?.update(.loading("正在重启服务…"))
        }
      }
    }
    do { try process.run() } catch { update(.offline("重启失败：\(error.localizedDescription)")) }
  }

  @objc private func quit() {
    if host?.ownsServer == true, let counts = activeCounts {
      let alert = NSAlert()
      alert.messageText = "退出并停止服务？"
      alert.informativeText = "当前有 \(counts.running) 个运行中、\(counts.approval) 个待审批的会话。退出会停止服务，并中断由本服务启动的 Codex / Claude 任务。PI-Desktop 会话不受影响。"
      alert.alertStyle = .warning
      alert.addButton(withTitle: "退出")
      alert.addButton(withTitle: "取消")
      NSApp.activate(ignoringOtherApps: true)
      guard alert.runModal() == .alertFirstButtonReturn else { return }
    }
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
// `kill` / `pkill` should stop the bundled server too. Handled off the main thread: a modal alert
// (welcome, confirmations) keeps the main queue from running.
signal(SIGTERM, SIG_IGN)
let terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
terminationSource.setEventHandler {
  delegate.host?.stopNow()
  exit(0)
}
terminationSource.resume()
app.run()
