import Foundation

let args = CommandLine.arguments
if args.count > 1 {
    switch args[1] {
    case "--emit":
        // Both pipes exceed their buffers; a wait-before-read poll hangs here.
        FileHandle.standardError.write(Data(repeating: 120, count: 1048576))
        let object: [String: Any] = ["complete": true, "repos": [], "collisions": [], "recentEdits": [], "padding": String(repeating: "x", count: 1048576)]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: object))
    case "--partial": print("{\"complete\":false,\"repos\":[],\"collisions\":[],\"recentEdits\":[]}")
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
for mode in ["--partial", "--invalid", "--failure", "--hang"] {
    var refused = false
    do { _ = try runRadar(executable: executable, arguments: [mode], timeout: 0.5) }
    catch { refused = true }
    precondition(refused, "must refuse \(mode)")
}
print("Native radar process checks passed: large stdout/stderr, invalid/partial output, nonzero exit and timeout.")
