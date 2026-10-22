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
                    self.statusItem.button?.title = "⚪ Kith"
                    self.buildMenu(collisions: [], recentEdits: [], repos: [])
                }
            }
        }
    }

    func updateUI(collisions: [[String: Any]], recentEdits: [[String: Any]], repos: [String]) {
        statusItem.button?.title = radarTitle(paths: collisions.count, ownershipAvailable: ownershipAvailable)
        buildMenu(collisions: collisions, recentEdits: recentEdits, repos: repos)
    }

    func buildMenu(collisions: [[String: Any]], recentEdits: [[String: Any]], repos: [String]) {
        let menu = NSMenu()

        // Title Header
        let titleItem = NSMenuItem(title: "Kith Worktree Radar", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        let dirItem = NSMenuItem(title: "Workspace: \(URL(fileURLWithPath: watchDir).lastPathComponent) (\(repos.count) checkouts)", action: nil, keyEquivalent: "")
        dirItem.isEnabled = false
        menu.addItem(dirItem)
        menu.addItem(NSMenuItem.separator())

        @discardableResult func note(_ text: String, in target: NSMenu) -> NSMenuItem {
            let item = NSMenuItem(title: radarLabel(text), action: nil, keyEquivalent: "")
            item.toolTip = text
            item.isEnabled = false
            target.addItem(item)
            return item
        }
        if !scanAvailable {
            note("Scan unavailable — no clean verdict", in: menu)
        } else {
            note(collisions.isEmpty ? "No differing shared dirty paths observed" : "Review before integration: \(collisions.count) shared dirty paths", in: menu)
            note(overlapExplanation, in: menu)
            note("Leases describe recorded participation, not file writers.", in: menu)
            let active = worktrees.filter { $0["activity"] as? String == "active" }.count
            let retained = worktrees.filter { $0["activity"] as? String == "retained" }.count
            note("Checkouts: \(active) with current leases; \(retained) retained", in: menu)
            menu.addItem(NSMenuItem.separator())
            for row in worktrees.prefix(20) {
                let activity = row["activity"] as? String ?? "unknown"
                let label = row["label"] as? String ?? "Checkout"
                let checkout = row["path"] as? String ?? "Unavailable path"
                let shared = row["sharedDirtyPaths"] as? Int ?? 0
                let parent = NSMenuItem(title: radarLabel("\(label) — \(worktreeActivity(activity)); \(shared) paths"), action: nil, keyEquivalent: "")
                parent.toolTip = checkout
                let detail = NSMenu()
                note(checkout, in: detail)
                let dirty = (row["dirtyFiles"] as? Int).map(String.init) ?? "Unknown"
                note("\(dirty) Git changes (excludes ignored files)", in: detail)
                if let agents = row["agentIds"] as? [String], !agents.isEmpty { note("Recorded: " + agents.joined(separator: ", "), in: detail) }
                note(row["detail"] as? String ?? "Ownership unavailable", in: detail)
                let paths = collisions.filter { ($0["repos"] as? [String] ?? []).contains(checkout) }
                if !paths.isEmpty {
                    detail.addItem(NSMenuItem.separator())
                    note("Review these copies before integrating:", in: detail)
                    for path in paths.prefix(8) {
                        let peers = (path["repos"] as? [String] ?? []).filter { $0 != checkout }
                        let names = peers.map { URL(fileURLWithPath: $0).lastPathComponent }.joined(separator: ", ")
                        let item = note((path["filePath"] as? String ?? "Unverified path") + " ↔ " + names, in: detail)
                        item.toolTip = path["message"] as? String
                    }
                    if paths.count > 8 { note("… \(paths.count - 8) more: kith watch --once", in: detail) }
                }
                detail.addItem(NSMenuItem.separator())
                note("Inspect in this checkout: kith status --offline", in: detail)
                note("Preserve unfinished work; this view never cleans up.", in: detail)
                parent.submenu = detail
                menu.addItem(parent)
            }
            if worktrees.count > 20 { note("… \(worktrees.count - 20) more checkouts: kith watch --once", in: menu) }
        }
        menu.addItem(NSMenuItem.separator())

        // Recent Edits section
        let editsHeader = NSMenuItem(title: "Recently modified files (\(recentEdits.count)):", action: nil, keyEquivalent: "")
        editsHeader.isEnabled = false
        menu.addItem(editsHeader)

        let topEdits = recentEdits.prefix(6)
        if topEdits.isEmpty {
            let noEdits = NSMenuItem(title: "  (No known file mtimes within 5m)", action: nil, keyEquivalent: "")
            noEdits.isEnabled = false
            menu.addItem(noEdits)
        } else {
            for edit in topEdits {
                let key = edit["key"] as? String ?? ""
                let age = edit["ageSec"] as? Int ?? 0
                let label = String(key.suffix(100)).replacingOccurrences(of: "\n", with: "↵")
                let item = NSMenuItem(title: "  📝 \(label) (\(age)s ago)", action: nil, keyEquivalent: "")
                item.toolTip = key
                item.isEnabled = false
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())

        // Action buttons
        let refreshItem = NSMenuItem(title: "Scan Now", action: #selector(scanNowClicked), keyEquivalent: "r")
        refreshItem.target = self
        menu.addItem(refreshItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit Kith Radar", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

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
