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
                    self.updateUI(collisions: json["collisions"] as? [[String: Any]] ?? [], recentEdits: json["recentEdits"] as? [[String: Any]] ?? [], repos: json["repos"] as? [String] ?? [])
                }
            } catch {
                DispatchQueue.main.async {
                    self.pollInFlight = false
                    self.scanAvailable = false
                    self.statusItem.button?.title = "⚪ Kith"
                    self.buildMenu(collisions: [], recentEdits: [], repos: [])
                }
            }
        }
    }

    func updateUI(collisions: [[String: Any]], recentEdits: [[String: Any]], repos: [String]) {
        if let button = statusItem.button {
            if collisions.isEmpty {
                button.title = "🟢 Kith"
            } else {
                button.title = "⚠️ Kith (\(collisions.count))"
            }
        }
        buildMenu(collisions: collisions, recentEdits: recentEdits, repos: repos)
    }

    func buildMenu(collisions: [[String: Any]], recentEdits: [[String: Any]], repos: [String]) {
        let menu = NSMenu()

        // Title Header
        let titleItem = NSMenuItem(title: "Kith Agent Radar", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        let dirItem = NSMenuItem(title: "Workspace: \(URL(fileURLWithPath: watchDir).lastPathComponent) (\(repos.count) repos)", action: nil, keyEquivalent: "")
        dirItem.isEnabled = false
        menu.addItem(dirItem)
        menu.addItem(NSMenuItem.separator())

        // Collisions section
        if !scanAvailable {
            let unavailable = NSMenuItem(title: "Scan unavailable — no clean verdict", action: nil, keyEquivalent: "")
            unavailable.isEnabled = false
            menu.addItem(unavailable)
        } else if !collisions.isEmpty {
            let colHeader = NSMenuItem(title: "⚠️ Collisions & Alerts (\(collisions.count)):", action: nil, keyEquivalent: "")
            colHeader.attributedTitle = NSAttributedString(
                string: "⚠️ Active Collisions (\(collisions.count)):",
                attributes: [.foregroundColor: NSColor.systemRed, .font: NSFont.boldSystemFont(ofSize: 13)]
            )
            colHeader.isEnabled = false
            menu.addItem(colHeader)

            for col in collisions {
                let msg = col["message"] as? String ?? "Conflict detected"
                let item = NSMenuItem(title: "  🚨 " + msg, action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            }
            menu.addItem(NSMenuItem.separator())
        } else {
            let okItem = NSMenuItem(title: "No observed worktree overlaps", action: nil, keyEquivalent: "")
            okItem.isEnabled = false
            menu.addItem(okItem)
            menu.addItem(NSMenuItem.separator())
        }

        // Recent Edits section
        let editsHeader = NSMenuItem(title: "Recent Parallel Edits (\(recentEdits.count)):", action: nil, keyEquivalent: "")
        editsHeader.isEnabled = false
        menu.addItem(editsHeader)

        let topEdits = recentEdits.prefix(6)
        if topEdits.isEmpty {
            let noEdits = NSMenuItem(title: "  (No active edits in last 5m)", action: nil, keyEquivalent: "")
            noEdits.isEnabled = false
            menu.addItem(noEdits)
        } else {
            for edit in topEdits {
                let key = edit["key"] as? String ?? ""
                let age = edit["ageSec"] as? Int ?? 0
                let item = NSMenuItem(title: "  📝 \(key) (\(age)s ago)", action: nil, keyEquivalent: "")
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
