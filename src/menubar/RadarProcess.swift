import Foundation
import Darwin

enum RadarError: Error { case launch, timeout, outputLimit, failed, invalid }

private final class Capture {
    private let lock = NSLock()
    private var bytes = Data()
    private var exceeded = false
    func drain(_ handle: FileHandle) {
        while true {
            let chunk = handle.readData(ofLength: 65536)
            if chunk.isEmpty { return }
            lock.lock()
            if bytes.count + chunk.count <= 8 * 1024 * 1024 { bytes.append(chunk) }
            else { exceeded = true }
            lock.unlock()
        }
    }
    func result() throws -> Data {
        lock.lock(); defer { lock.unlock() }
        if exceeded { throw RadarError.outputLimit }
        return bytes
    }
}

/** Drain both pipes while the child runs; bound execution and reject failed/partial scans. */
func runRadar(executable: String, arguments: [String], timeout: TimeInterval = 12) throws -> [String: Any] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    let stdout = Pipe(), stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    try process.run()
    let group = DispatchGroup(), output = Capture(), errors = Capture()
    for (capture, pipe) in [(output, stdout), (errors, stderr)] {
        group.enter()
        DispatchQueue.global().async { capture.drain(pipe.fileHandleForReading); group.leave() }
    }
    if finished.wait(timeout: .now() + timeout) == .timedOut {
        process.terminate()
        if finished.wait(timeout: .now() + 1) == .timedOut {
            kill(process.processIdentifier, SIGKILL)
            _ = finished.wait(timeout: .now() + 1)
        }
        _ = group.wait(timeout: .now() + 2)
        throw RadarError.timeout
    }
    guard group.wait(timeout: .now() + 2) == .success else { throw RadarError.timeout }
    _ = try errors.result()
    guard process.terminationStatus == 0 else { throw RadarError.failed }
    guard let json = try JSONSerialization.jsonObject(with: output.result()) as? [String: Any],
          json["complete"] as? Bool == true,
          json["ownershipComplete"] is Bool, json["worktrees"] is [[String: Any]],
          json["repos"] is [String], json["collisions"] is [[String: Any]], json["recentEdits"] is [[String: Any]] else { throw RadarError.invalid }
    return json
}

// Shared with the native presentation checks; counts describe paths, never urgency.
func radarTitle(paths: Int, ownershipAvailable: Bool) -> String {
    return "Kith" + (paths > 0 ? " (\(paths) paths)" : "") + (ownershipAvailable ? "" : " (?)")
}
func worktreeActivity(_ activity: String) -> String {
    switch activity {
    case "active": return "Active Kith lease"
    case "retained": return "Retained — inspect before cleanup"
    case "unregistered": return "No Kith session"
    default: return "Ownership unavailable"
    }
}
func radarLabel(_ text: String) -> String {
    return String(text.prefix(140)).replacingOccurrences(of: "\n", with: "↵").replacingOccurrences(of: "\r", with: "↵")
}
let overlapExplanation = "Different/unverified dirty copies; merge not verified."
