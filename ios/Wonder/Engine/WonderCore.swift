import Foundation
import Observation

/// The app core: one JSContext running wonder-core.js (the web client's store, deck/FSRS,
/// practice grading, progress, steering and Teacher helpers, and chatgpt-dil's NDJSON parser).
/// State is the web's `wonder.v1` document, kept in a file instead of localStorage.
@MainActor
@Observable
final class WonderCore {
    static let shared = WonderCore()

    /// Bumped whenever the store changes; views read it to refresh.
    private(set) var revision = 0

    @ObservationIgnored private let box = Box()
    private final class Box: @unchecked Sendable { var host: JSHost? }

    static var storeURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Wonder", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private init() {
        let box = self.box
        let dir = Self.storeURL
        JSEngine.core.queue.sync {
            let file = { (key: String) in dir.appendingPathComponent(key.replacingOccurrences(of: "/", with: "_") + ".json") }
            let get: @convention(block) (String) -> Any = { key in
                (try? String(contentsOf: file(key), encoding: .utf8)) ?? NSNull()
            }
            let set: @convention(block) (String, String) -> Void = { key, value in
                try? value.write(to: file(key), atomically: true, encoding: .utf8)
            }
            let remove: @convention(block) (String) -> Void = { key in try? FileManager.default.removeItem(at: file(key)) }
            let changed: @convention(block) () -> Void = {
                DispatchQueue.main.async { WonderCore.shared.bump() }
            }
            let native: [String: Any] = ["storageGet": get, "storageSet": set, "storageRemove": remove, "changed": changed]
            box.host = JSHost(script: "wonder-core", name: "core", lane: JSEngine.core, globals: ["__wonderCoreNative": native])
        }
    }

    private func bump() { revision &+= 1 }

    struct CoreError: LocalizedError { let message: String; var errorDescription: String? { message } }

    /// Call `WonderCore.call(name, args)` in the core context.
    @discardableResult
    func call(_ name: String, _ args: JSON = [:]) throws -> JSON {
        let box = self.box
        let argsJSON = args.jsonString
        let text: String? = JSEngine.core.queue.sync { box.host?.invoke("WonderCore", "call", [name, argsJSON]) }
        guard let text, let r = JSON.parse(text) else { throw CoreError(message: "core call \(name) returned nothing") }
        if r["ok"].bool == true { return r["value"] }
        throw CoreError(message: r["error"].string ?? "core call \(name) failed")
    }

    /// `call` for reads that should not fail the UI: logs and returns null on error.
    func get(_ name: String, _ args: JSON = [:]) -> JSON {
        do { return try call(name, args) } catch {
            NSLog("[core] %@: %@", name, error.localizedDescription)
            return .null
        }
    }

    func flush() { _ = get("flush") }

    // MARK: lessons

    func lesson(_ id: String) -> JSON { get("lesson", ["id": .string(id)]) }
    func saveLesson(_ id: String, _ patch: JSON) { _ = get("saveLesson", ["id": .string(id), "patch": patch]) }
    func createLesson(_ fields: JSON) -> String? { get("createLesson", fields).string }

    var memoryEnabled: Bool { self.get("settings")["memoryEnabled"].bool != false }
    func setSetting(_ key: String, _ value: JSON) { _ = get("setSetting", ["key": .string(key), "value": value]) }

    func mergeComponentResults(_ appData: JSON, _ results: JSON) -> JSON {
        get("mergeComponentResults", ["appData": appData, "componentResults": results])
    }
}
