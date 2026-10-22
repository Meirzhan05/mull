import Foundation
import JavaScriptCore

/// All JavaScript runs on one serial queue, in contexts that share one virtual machine.
enum JSEngine {
    static let queue = DispatchQueue(label: "app.wonder.js", qos: .userInitiated)
    static let vm: JSVirtualMachine = JSVirtualMachine()

    private static var sources: [String: String] = [:]
    private static let sourcesLock = NSLock()

    /// A bundled script from Engine/JS (built by ios/engine/bundle.mjs).
    static func source(_ name: String) -> String {
        sourcesLock.lock()
        defer { sourcesLock.unlock() }
        if let s = sources[name] { return s }
        guard let url = Bundle.main.url(forResource: name, withExtension: "js"),
              let s = try? String(contentsOf: url, encoding: .utf8) else {
            fatalError("missing bundled script \(name).js (run node ios/engine/bundle.mjs)")
        }
        sources[name] = s
        return s
    }
}

/// One JSContext with the bridge `jsc-shim.js` expects: `__native.post / setTimer / clearTimer / log`.
/// Create, use and destroy it on `JSEngine.queue` only.
final class JSHost {
    let context: JSContext
    let name: String
    var onPost: ((String) -> Void)?
    private var timers: [Int: DispatchWorkItem] = [:]
    private(set) var destroyed = false

    init(script: String, name: String, globals: [String: Any] = [:]) {
        dispatchPrecondition(condition: .onQueue(JSEngine.queue))
        self.name = name
        context = JSContext(virtualMachine: JSEngine.vm)
        context.name = name
        let label = name
        context.exceptionHandler = { _, exc in
            let msg = exc?.toString() ?? "unknown"
            let line = exc?.objectForKeyedSubscript("line")?.toString() ?? "?"
            NSLog("[js:%@] exception: %@ (line %@)", label, msg, line)
        }

        let native = JSValue(newObjectIn: context)!
        let post: @convention(block) (String) -> Void = { [weak self] json in self?.onPost?(json) }
        let setTimer: @convention(block) (Int, Double) -> Void = { [weak self] id, ms in self?.setTimer(id, ms: ms) }
        let clearTimer: @convention(block) (Int) -> Void = { [weak self] id in self?.clearTimer(id) }
        let log: @convention(block) (String, String) -> Void = { level, text in
            #if DEBUG
            NSLog("[js:%@] %@ %@", label, level, String(text.prefix(2000)))
            #endif
        }
        native.setObject(post, forKeyedSubscript: "post" as NSString)
        native.setObject(setTimer, forKeyedSubscript: "setTimer" as NSString)
        native.setObject(clearTimer, forKeyedSubscript: "clearTimer" as NSString)
        native.setObject(log, forKeyedSubscript: "log" as NSString)
        context.setObject(native, forKeyedSubscript: "__native" as NSString)
        for (k, v) in globals { context.setObject(v, forKeyedSubscript: k as NSString) }
        context.evaluateScript(JSEngine.source(script), withSourceURL: URL(string: "wonder://\(script).js"))
    }

    /// Call a global function with string arguments; returns its result as a string (or nil).
    @discardableResult
    func call(_ function: String, _ args: [Any]) -> String? {
        dispatchPrecondition(condition: .onQueue(JSEngine.queue))
        guard !destroyed, let fn = context.objectForKeyedSubscript(function), !fn.isUndefined else { return nil }
        let r = fn.call(withArguments: args)
        guard let r, !r.isUndefined, !r.isNull else { return nil }
        return r.toString()
    }

    /// Call `object.method(...args)`.
    func invoke(_ object: String, _ method: String, _ args: [Any]) -> String? {
        dispatchPrecondition(condition: .onQueue(JSEngine.queue))
        guard !destroyed, let obj = context.objectForKeyedSubscript(object), !obj.isUndefined else { return nil }
        return obj.invokeMethod(method, withArguments: args)?.toString()
    }

    private func setTimer(_ id: Int, ms: Double) {
        timers[id]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.destroyed else { return }
            self.timers[id] = nil
            self.call("__wonderFireTimer", [id])
        }
        timers[id] = work
        JSEngine.queue.asyncAfter(deadline: .now() + max(0, ms) / 1000, execute: work)
    }

    private func clearTimer(_ id: Int) {
        timers[id]?.cancel()
        timers[id] = nil
    }

    func destroy() {
        dispatchPrecondition(condition: .onQueue(JSEngine.queue))
        destroyed = true
        for t in timers.values { t.cancel() }
        timers.removeAll()
        onPost = nil
    }
}
