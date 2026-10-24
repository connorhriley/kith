import AppKit
import Foundation

class KithMenuBarApp: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?
    var selection = RadarSelection()
    var watchDir: String { selection.path }
    var kithCliPath = ""
    var kithScriptPath = ""
    var pollInFlight = false
    var scanAvailable = false
    var worktrees: [[String: Any]] = []
    var ownershipAvailable = false
    var coordination: [String: Any] = [:]
    var linkedContracts: [[String: Any]] = []
    var contractWarnings: [String] = []
    var recentWorkspaces: [String] = []

    func registerWorkspace(_ path: String) {
        let canonical = URL(fileURLWithPath: path).standardized.path
        recentWorkspaces.removeAll { $0 == canonical }
        recentWorkspaces.insert(canonical, at: 0)
        recentWorkspaces = Array(recentWorkspaces.prefix(10))
        UserDefaults.standard.set(recentWorkspaces, forKey: "KithRecentWorkspaces")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        guard args.count == 4 else { NSApplication.shared.terminate(nil); return }
        selection.select(args[1])
        kithCliPath = args[2]
        kithScriptPath = args[3]
        recentWorkspaces = UserDefaults.standard.stringArray(forKey: "KithRecentWorkspaces") ?? []
        registerWorkspace(watchDir)

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
        let revision = selection.revision, directory = watchDir
        DispatchQueue.global(qos: .background).async { [weak self] in
            guard let self = self else { return }
            do {
                let json = try runRadar(executable: self.kithCliPath, arguments: [self.kithScriptPath, "watch", directory, "--once", "--raw"])
                DispatchQueue.main.async {
                    self.pollInFlight = false
                    guard self.selection.accepts(revision) else { self.pollRadar(); return }
                    self.scanAvailable = true
                    self.coordination = json["coordination"] as? [String: Any] ?? [:]
                    self.worktrees = json["worktrees"] as? [[String: Any]] ?? []
                    self.linkedContracts = json["linkedContracts"] as? [[String: Any]] ?? []
                    self.contractWarnings = json["contractWarnings"] as? [String] ?? []
                    self.ownershipAvailable = json["ownershipComplete"] as? Bool == true
                    self.updateUI(collisions: json["collisions"] as? [[String: Any]] ?? [], recentEdits: json["recentEdits"] as? [[String: Any]] ?? [], repos: json["repos"] as? [String] ?? [])
                }
            } catch {
                DispatchQueue.main.async {
                    self.pollInFlight = false
                    guard self.selection.accepts(revision) else { self.pollRadar(); return }
                    self.scanAvailable = false
                    self.worktrees = []
                    self.linkedContracts = []
                    self.contractWarnings = []
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
            let checkoutPath = row["path"] as? String ?? "Path unavailable"
            let item = NSMenuItem(title: radarLabel(name), action: nil, keyEquivalent: ""), detail = NSMenu()
            note(checkoutPath, in: detail)
            note(worktreeActivity(row["activity"] as? String ?? "unknown"), in: detail)
            note("\(row["dirtyFiles"] ?? "Unknown") Git changes; \(sharedPathsLabel(row["sharedDirtyPaths"] as? Int ?? 0))", in: detail)
            note(row["detail"] as? String ?? "Status unavailable", in: detail)
            note("Inspect here: kith status --offline. Keep unfinished work.", in: detail)
            if checkoutPath != "Path unavailable" {
                detail.addItem(NSMenuItem.separator())
                let openItem = NSMenuItem(title: "Reveal Checkout in Finder", action: #selector(openCheckoutClicked(_:)), keyEquivalent: "")
                openItem.target = self; openItem.representedObject = checkoutPath; detail.addItem(openItem)
                let copyItem = NSMenuItem(title: "Copy Checkout Path", action: #selector(copyTextClicked(_:)), keyEquivalent: "")
                copyItem.target = self; copyItem.representedObject = checkoutPath; detail.addItem(copyItem)
                for (title, role) in [("Copy Claim Next Task Prompt", "worker"), ("Copy Plan Tasks Prompt", "architect")] {
                    let prompt = NSMenuItem(title: title, action: #selector(copyPromptClicked(_:)), keyEquivalent: "")
                    prompt.target = self; prompt.representedObject = [checkoutPath, role]; detail.addItem(prompt)
                }
            }
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
            let queued = coordination["queued"] as? [[String: Any]] ?? []
            if !queued.isEmpty {
                let detail = section("Queued tasks (\(queued.count))")
                for row in queued.prefix(12) {
                    let scopes = (row["scopes"] as? [String] ?? []).joined(separator: ", ")
                    note("\(row["title"] ?? "Task") [p\(row["priority"] ?? 10)]" + (scopes.isEmpty ? "" : " — \(scopes)"), in: detail)
                }
            }
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
        if !linkedContracts.isEmpty || !contractWarnings.isEmpty {
            let detail = section("Linked cross-repo contracts (\(linkedContracts.count))")
            for warning in contractWarnings.prefix(8) { note(warning, in: detail) }
            for row in linkedContracts.prefix(8) {
                let alias = row["alias"] as? String ?? "@contract"
                let repo = row["sourceRepoName"] as? String ?? "repo"
                let file = row["filePath"] as? String ?? "file"
                let locked = row["lockedByAgent"] as? String
                let dirty = row["dirtyInCheckout"] as? Bool == true
                let status = row["ownershipAvailable"] as? Bool != true ? " [ownership unavailable]" : (locked != nil ? " [locked by \(locked!)]" : (dirty ? " [dirty]" : ""))
                note("\(alias) → \(repo)/\(file)\(status)", in: detail)
            }
        }
        let detail = section("All checkouts (\(worktrees.count))")
        for row in worktrees.prefix(30) { checkout(row, in: detail) }
        if worktrees.count > 30 { note("More: kith watch --once", in: detail) }
        menu.addItem(NSMenuItem.separator())
        let wsMenu = section("Switch Workspace")
        for ws in recentWorkspaces where FileManager.default.fileExists(atPath: ws) {
            let label = "\(URL(fileURLWithPath: ws).lastPathComponent) (\(ws))"
            let item = NSMenuItem(title: radarLabel(label), action: #selector(switchWorkspaceClicked(_:)), keyEquivalent: "")
            item.target = self; item.representedObject = ws
            item.state = (ws == watchDir) ? .on : .off
            wsMenu.addItem(item)
        }
        wsMenu.addItem(NSMenuItem.separator())
        let chooseWs = NSMenuItem(title: "Choose Folder…", action: #selector(chooseWorkspaceClicked), keyEquivalent: "")
        chooseWs.target = self; wsMenu.addItem(chooseWs)
        let refresh = NSMenuItem(title: "Refresh", action: #selector(scanNowClicked), keyEquivalent: "r")
        refresh.target = self; menu.addItem(refresh)
        let quit = NSMenuItem(title: "Quit Kith", action: #selector(quitClicked), keyEquivalent: "q")
        quit.target = self; menu.addItem(quit)
        statusItem.menu = menu
    }

    @objc func switchWorkspaceClicked(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? String else { return }
        selectWorkspace(target)
    }

    @objc func chooseWorkspaceClicked() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Watch Workspace"
        if panel.runModal() == .OK, let url = panel.url {
            selectWorkspace(url.path)
        }
    }

    func selectWorkspace(_ path: String) {
        selection.select(path)
        registerWorkspace(watchDir)
        scanAvailable = false; ownershipAvailable = false
        coordination = [:]; worktrees = []; linkedContracts = []; contractWarnings = []
        statusItem.button?.title = "⚪ Kith"
        buildMenu(collisions: [], recentEdits: [], repos: [])
        pollRadar()
    }

    @objc func copyPromptClicked(_ sender: NSMenuItem) {
        guard let values = sender.representedObject as? [String], values.count == 2 else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let output = try runOutput(executable: self.kithCliPath, arguments: [self.kithScriptPath, "prompt", values[1], "--repo", values[0], "--raw"])
                guard let prompt = String(data: output, encoding: .utf8), !prompt.isEmpty else { throw RadarError.invalid }
                DispatchQueue.main.async {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(prompt, forType: .string)
                }
            } catch {
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = "Could not prepare task prompt"
                    alert.informativeText = "Choose an available Git checkout and try again. Existing work is unchanged."
                    alert.runModal()
                }
            }
        }
    }

    @objc func copyTextClicked(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    @objc func openCheckoutClicked(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
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
