import AppKit
import Foundation

class KithMenuBarApp: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var timer: Timer?
    var watchDir: String = "/Users/user/Briefed"
    var kithCliPath: String = "/opt/homebrew/bin/node"
    var kithScriptPath: String = "/Users/user/Projects/kith/dist/cli/index.js"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        if args.count > 1 {
            watchDir = args[1]
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.title = "🟢 Kith"
        }

        buildMenu(collisions: [], recentEdits: [], repos: [])

        // Poll every 3 seconds
        timer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.pollRadar()
        }
        pollRadar()
    }

    func pollRadar() {
        DispatchQueue.global(qos: .background).async { [weak self] in
            guard let self = self else { return }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: self.kithCliPath)
            process.arguments = [self.kithScriptPath, "watch", self.watchDir, "--once", "--raw"]
            
            var env = ProcessInfo.processInfo.environment
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            process.environment = env

            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()

            do {
                try process.run()
                process.waitUntilExit()

                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                guard let outputString = String(data: data, encoding: .utf8),
                      let start = outputString.firstIndex(of: "{"),
                      let end = outputString.lastIndex(of: "}"),
                      start <= end else {
                    return
                }
                let jsonSubstring = String(outputString[start...end])
                guard let jsonData = jsonSubstring.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
                    return
                }
                let collisions = json["collisions"] as? [[String: Any]] ?? []
                let recentEdits = json["recentEdits"] as? [[String: Any]] ?? []
                let repos = json["repos"] as? [String] ?? []

                DispatchQueue.main.async {
                    self.updateUI(collisions: collisions, recentEdits: recentEdits, repos: repos)
                }
            } catch {
                // Ignore process launch errors
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
        if !collisions.isEmpty {
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
            let okItem = NSMenuItem(title: "✅ Zero Collisions (All Clear)", action: nil, keyEquivalent: "")
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

        let termItem = NSMenuItem(title: "Open Terminal Radar", action: #selector(openTerminalClicked), keyEquivalent: "t")
        termItem.target = self
        menu.addItem(termItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "Quit Kith Radar", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    @objc func scanNowClicked() {
        pollRadar()
    }

    @objc func openTerminalClicked() {
        let script = "tell application \"Terminal\" to do script \"kith watch '\(watchDir)'\""
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        try? process.run()
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
