// AnywhereCoding menu bar companion: polls the local server's /api/status and shows activity.
// Build and install with `node scripts/menubar.mjs install`.
import AppKit

let serviceLabel = "io.github.chilin11.anywherecoding"
let pollInterval: TimeInterval = 3

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

  /// Reads host/port/token from `$ANYWHERE_HOME/config.json` (default `~/.anywherecoding`). The token never leaves memory.
  static func load() throws -> ServerConfig {
    let home = ProcessInfo.processInfo.environment["ANYWHERE_HOME"].flatMap { $0.isEmpty ? nil : $0 }
      ?? (NSHomeDirectory() as NSString).appendingPathComponent(".anywherecoding")
    let file = URL(fileURLWithPath: home).appendingPathComponent("config.json")
    let data = try Data(contentsOf: file)
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let token = json["token"] as? String, !token.isEmpty
    else { throw NSError(domain: "AnywhereCoding", code: 1, userInfo: [NSLocalizedDescriptionKey: "config.json 缺少 token"]) }
    let port = (json["port"] as? Int) ?? 8788
    var host = (json["host"] as? String) ?? "127.0.0.1"
    if host.isEmpty || host == "0.0.0.0" || host == "::" || host == "[::]" { host = "127.0.0.1" }
    if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
    guard let base = URL(string: "http://\(host):\(port)/") else {
      throw NSError(domain: "AnywhereCoding", code: 2, userInfo: [NSLocalizedDescriptionKey: "无效地址 \(host):\(port)"])
    }
    return ServerConfig(base: base, token: token)
  }
}

enum Connection {
  case loading
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
  private var timer: Timer?
  private var state: Connection = .loading
  private var config: ServerConfig?
  private var inFlight = false
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
    render()
    poll()
    timer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in self?.poll() }
    timer?.tolerance = 0.5
    if CommandLine.arguments.contains("--self-test") { selfTest() }
  }

  /// Diagnostics without screen-recording permission: report the status item and first poll, then exit.
  private func selfTest() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [self] in
      rebuildMenu()
      let button = item.button
      let frame = button?.window?.frame ?? .zero
      var phase = "loading"
      switch state {
      case .loading: phase = "loading"
      case .online(let snapshot): phase = "online running=\(snapshot.running) approval=\(snapshot.approval) active=\(snapshot.active.count)"
      case .offline(let reason): phase = "offline \(reason)"
      }
      print("visible=\(item.isVisible) frame=\(frame) image=\(button?.image != nil) title='\(button?.title ?? "")'")
      print("state=\(phase)")
      print("menu=" + menu.items.map { $0.isSeparatorItem ? "—" : $0.title }.joined(separator: " | "))
      exit(0)
    }
  }

  // MARK: Polling

  private func poll() {
    if inFlight { return }
    let loaded: ServerConfig
    do { loaded = try ServerConfig.load() } catch {
      config = nil
      update(.offline("读取配置失败：\(error.localizedDescription)"))
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
        self?.inFlight = false
        self?.update(next)
      }
    }.resume()
  }

  private var isMenuOpen = false

  private func update(_ next: Connection) {
    state = next
    render()
    // Keep an open menu current.
    if isMenuOpen { rebuildMenu() }
  }

  // MARK: Status item

  private func render() {
    guard let button = item.button else { return }
    let symbol: String
    var title = ""
    var tint: NSColor? = nil
    var tip = "AnywhereCoding"
    switch state {
    case .loading:
      symbol = "chevron.left.forwardslash.chevron.right"
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
    switch state {
    case .loading:
      menu.addItem(disabled("AnywhereCoding · 正在连接…"))
    case .offline(let reason):
      menu.addItem(disabled("AnywhereCoding · 未连接"))
      menu.addItem(disabled(shorten(reason, 70)))
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
      let agents = NSMenuItem(title: "连接", action: nil, keyEquivalent: "")
      let agentsMenu = NSMenu()
      if snapshot.agents.isEmpty { agentsMenu.addItem(disabled("尚未添加连接")) }
      for agent in snapshot.agents {
        agentsMenu.addItem(disabled("\(agent.ok ? "✓" : "✕") \(agentName(agent.agent))\(agent.ok ? "" : "：" + shorten(agent.reason ?? "不可用", 50))"))
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
    menu.addItem(action("重启服务…", #selector(restartService), ""))
    menu.addItem(.separator())
    menu.addItem(action("退出状态栏图标", #selector(quit), "q"))
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
    return (try? ServerConfig.load().base) ?? URL(string: "http://127.0.0.1:8788/")!
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
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(token, forType: .string)
  }

  @objc private func restartService() {
    let alert = NSAlert()
    alert.messageText = "重启 AnywhereCoding 服务？"
    var detail = "网页连接会短暂中断。PI-Desktop 会话不受影响。"
    if case .online(let snapshot) = state, snapshot.running + snapshot.approval > 0 {
      detail = "当前有 \(snapshot.running) 个运行中、\(snapshot.approval) 个待审批的会话。重启会中断由本服务启动的 Codex / Claude 任务。\n\n" + detail
      alert.alertStyle = .warning
    }
    alert.informativeText = detail
    alert.addButton(withTitle: "重启")
    alert.addButton(withTitle: "取消")
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = ["kickstart", "-k", "gui/\(getuid())/\(serviceLabel)"]
    process.terminationHandler = { [weak self] finished in
      DispatchQueue.main.async {
        if finished.terminationStatus != 0 {
          self?.update(.offline("重启失败（launchctl 退出码 \(finished.terminationStatus)），服务是否已安装？"))
        } else {
          self?.update(.loading)
        }
      }
    }
    do { try process.run() } catch { update(.offline("重启失败：\(error.localizedDescription)")) }
  }

  @objc private func quit() {
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
