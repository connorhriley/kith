import Foundation

let args = CommandLine.arguments
if args.count > 1 {
    switch args[1] {
    case "--emit":
        // Both pipes exceed their buffers; a wait-before-read poll hangs here.
        FileHandle.standardError.write(Data(repeating: 120, count: 1048576))
        let object: [String: Any] = ["complete": true, "ownershipComplete": true, "coordination": ["available": true], "worktrees": [], "repos": [], "collisions": [], "recentEdits": [], "padding": String(repeating: "x", count: 1048576)]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: object))
    case "--partial": print("{\"complete\":false,\"repos\":[],\"collisions\":[],\"recentEdits\":[]}")
    case "--old-payload": print("{\"complete\":true,\"repos\":[],\"collisions\":[],\"recentEdits\":[]}")
    case "--invalid": print("not JSON")
    case "--failure": exit(1)
    case "--hang": Thread.sleep(forTimeInterval: 30)
    default: exit(2)
    }
    exit(0)
}
let executable = URL(fileURLWithPath: args[0]).standardized.path
let good = try runRadar(executable: executable, arguments: ["--emit"])
precondition(good["complete"] as? Bool == true)
for mode in ["--partial", "--old-payload", "--invalid", "--failure", "--hang"] {
    var refused = false
    do { _ = try runRadar(executable: executable, arguments: [mode], timeout: 0.5) }
    catch { refused = true }
    precondition(refused, "must refuse \(mode)")
}
print("Native radar process checks passed: large stdout/stderr, invalid/partial output, nonzero exit and timeout.")

precondition(radarTitle(paths: 58, ownershipAvailable: true) == "Kith (58 paths)")
precondition(radarTitle(paths: 0, ownershipAvailable: false) == "Kith (?)")
precondition(worktreeActivity("active") == "Active Kith lease")
precondition(worktreeActivity("retained").contains("inspect before cleanup"))
precondition(worktreeActivity("unregistered") == "No Kith session")
precondition(worktreeActivity("unknown") == "Ownership unavailable")
precondition(overlapExplanation.contains("merge not verified"))
precondition(radarLabel("file\nname") == "file↵name")
print("Native radar labels distinguish lease/retained/unknown and path counts from conflict verdicts.")

precondition(sharedPathsLabel(0) == "0 shared paths")
precondition(sharedPathsLabel(14) == "14 shared paths")
precondition(recentEditsLabel(377) == "File mtimes within 5m: showing 6 of 377")
precondition(recentEditsLabel(0) == "File mtimes within 5m: showing 0 of 0")

precondition(coordinationHeadline(tasks: 0, sessions: 0).contains("Watching only"))
precondition(coordinationHeadline(tasks: 0, sessions: 1).contains("no task started"))
precondition(coordinationTitle(["available": true, "working": [["title": "Task"]]], available: true) == "Kith · 1 task")
precondition(coordinationTitle(["available": true, "attention": [["message": "Check failed"]]], available: true) == "Kith · needs attention")

var selection = RadarSelection()
selection.select("/tmp/project-a")
let old = selection.revision
selection.select("/tmp/project-b")
precondition(!selection.accepts(old), "An old scan must not relabel a new workspace")
let current = selection.revision
precondition(selection.accepts(current))
selection.select("/tmp/project-a")
precondition(!selection.accepts(old), "Returning to A must not accept its old scan")
print("Workspace selection rejects late completions, including A -> B -> A.")
