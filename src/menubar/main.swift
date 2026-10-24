import AppKit
import Foundation

class KithMenuBarApp: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?
    var watchDir = ""
    var kithCliPath = ""
    var kithScriptPath = ""
    var pollInFlight = false
    var scanAvailable = false
    var worktrees: [[String: Any]] = []
    var ownershipAvailable = false
    var coordination: [String: Any] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count == 4 else { NSApplication.shared.terminate(nil); return }
        watchDir = args[1]
        kithCliPath = args[2]
        kithScriptPath = args[3]

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "⚪ Kith"
        }

        buildMenu(collisions: [], recentEdits: [], repos: [])

        // Poll every 3 seconds
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.pollRadar()
        }
        pollRadar()
    }

    func pollRadar() {
        guard !pollInFlight else { return }
        pollInFlight = true
        DispatchQueue.global(qos: .background).async { [weak self] in
            guard let self = self else { return }
            do {
                let json = try runRadar(executable: self.kithCliPath, arguments: [self.kithScriptPath, "watch", self.watchDir, "--once", "--raw"])
                DispatchQueue.main.async {
                    self.pollInFlight = false
                    self.scanAvailable = true
                    self.coordination = json["coordination"] as? [String: Any] ?? [:]
                    self.worktrees = json["worktrees"] as? [[String: Any]] ?? []
                    self.ownershipAvailable = json["ownershipComplete"] as? Bool == true
                    self.updateUI(collisions: json["collisions"] as? [[String: Any]] ?? [], recentEdits: json["recentEdits"] as? [[String: Any]] ?? [], repos: json["repos"] as? [String] ?? [])
                }
            } catch {
                DispatchQueue.main.async {
                    self.pollInFlight = false
                    self.scanAvailable = false
                    self.worktrees = []
                    self.ownershipAvailable = false
                    self.coordination = [:]
                    self.statusItem.button?.title = "⚪ Kith"
                    self.buildMenu(collisions: [], recentEdits: [], repos: [])
                }
            }
        }
    }

    func updateUI(collisions: [[String: Any]], recentEdits: [[String: Any]], repos: [String]) {
        statusItem.button?.title = coordinationTitle(coordination, available: scanAvailable && ownershipAvailable)
        buildMenu(collisions: collisions, recentEdits: recentEdits, repos: repos)
    }

    func buildMenu(collisions: [[String: Any]], recentEdits: [[String: Any]], repos: [String]) {
        let menu = NSMenu()
        func note(_ text: String, in target: NSMenu = menu) {
            let item = NSMenuItem(title: radarLabel(text), action: nil, keyEquivalent: "")
            item.toolTip = text
            item.attributedTitle = NSAttributedString(string: radarLabel(text), attributes: [.foregroundColor: NSColor.secondaryLabelColor])
            item.isEnabled = false; target.addItem(item)
        }
        func section(_ title: String) -> NSMenu {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: ""), detail = NSMenu()
            item.submenu = detail; menu.addItem(item); return detail
        }
        func checkout(_ row: [String: Any], in target: NSMenu) {
            let name = row["label"] as? String ?? "Checkout"
            let item = NSMenuItem(title: radarLabel(name), action: nil, keyEquivalent: ""), detail = NSMenu()
            note(row["path"] as? String ?? "Path unavailable", in: detail)
            note(worktreeActivity(row["activity"] as? String ?? "unknown"), in: detail)
            note("\(row["dirtyFiles"] ?? "Unknown") Git changes; \(sharedPathsLabel(row["sharedDirtyPaths"] as? Int ?? 0))", in: detail)
            note(row["detail"] as? String ?? "Status unavailable", in: detail)
            note("Inspect here: kith status --offline. Keep unfinished work.", in: detail)
            item.submenu = detail; target.addItem(item)
        }
        note("Kith · \(URL(fileURLWithPath: watchDir).lastPathComponent)")
        menu.addItem(NSMenuItem.separator())
        let available = scanAvailable && ownershipAvailable && coordination["available"] as? Bool == true
        if !available {
            note("Status unavailable — inspect before acting")
            note("Run kith status --offline in the affected checkout.")
        } else {
            let attention = coordination["attention"] as? [[String: Any]] ?? []
            for row in attention.prefix(5) {
                note("Needs attention: " + (row["message"] as? String ?? "Inspect saved work"))
                note(row["nextStep"] as? String ?? "Run kith recover.")
            }
            let working = coordination["working"] as? [[String: Any]] ?? []
            note(coordinationHeadline(tasks: working.count, sessions: coordination["sessions"] as? Int ?? 0))
            if working.isEmpty { note("Ask your agent to use Kith to begin this task.") }
            for row in working.prefix(8) {
                let agent = row["agentId"] as? String ?? "Agent"
                let item = NSMenuItem(title: radarLabel("\(agent): \(row["title"] as? String ?? "Task")"), action: nil, keyEquivalent: ""), detail = NSMenu()
                note(row["checkout"] as? String ?? "Checkout unavailable", in: detail)
                let scopes = row["scopes"] as? [String] ?? []
                note(scopes.isEmpty ? "No current file claims" : "Claimed: " + scopes.joined(separator: ", "), in: detail)
                note("Recorded Kith task; writes outside Kith are not attributed.", in: detail)
                item.submenu = detail; menu.addItem(item)
            }
            if working.count > 8 { note("\(working.count - 8) more tasks: kith status --offline") }
            let waiting = coordination["waiting"] as? [[String: Any]] ?? []
            for row in waiting.prefix(6) {
                note("Waiting: \(row["agentId"] ?? "Agent") → \(row["resource"] ?? "resource") (held by \(row["holder"] ?? "not recorded"))")
            }
            let using = coordination["using"] as? [[String: Any]] ?? []
            if !using.isEmpty {
                let detail = section("Shared resources (\(using.count))")
                for row in using.prefix(12) { note("\(row["agentId"] ?? "Agent"): \(row["resource"] ?? "resource") — \(row["detail"] ?? "Reserved")", in: detail) }
            }
        }
        if !collisions.isEmpty {
            menu.addItem(NSMenuItem.separator())
            let detail = section("Review before integration: \(collisions.count) shared files")
            note("Different or unverified copies; a merge conflict is not established.", in: detail)
            for row in collisions.prefix(12) {
                note(row["filePath"] as? String ?? "Path unavailable", in: detail)
                for peer in row["repos"] as? [String] ?? [] { note("  " + peer, in: detail) }
            }
            if collisions.count > 12 { note("More: kith watch --once", in: detail) }
        }
        let saved = worktrees.filter { $0["activity"] as? String == "retained" }
        if !saved.isEmpty {
            let detail = section("Saved work (\(saved.count) checkouts)")
            note("Kept for inspection; saved does not mean safe to delete.", in: detail)
            for row in saved.prefix(20) { checkout(row, in: detail) }
            if saved.count > 20 { note("More: kith status --offline", in: detail) }
        }
        let detail = section("All checkouts (\(worktrees.count))")
        for row in worktrees.prefix(30) { checkout(row, in: detail) }
        if worktrees.count > 30 { note("More: kith watch --once", in: detail) }
        menu.addItem(NSMenuItem.separator())
        let refresh = NSMenuItem(title: "Refresh", action: #selector(scanNowClicked), keyEquivalent: "r")
        refresh.target = self; menu.addItem(refresh)
        let quit = NSMenuItem(title: "Quit Kith", action: #selector(quitClicked), keyEquivalent: "q")
        quit.target = self; menu.addItem(quit)
        statusItem.menu = menu
    }

    @objc func scanNowClicked() {
        pollRadar()
    }

    @objc func quitClicked() {
        NSApplication.shared.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // Accessory means menu bar only, no Dock icon!
let delegate = KithMenuBarApp()
app.delegate = delegate
app.run()
