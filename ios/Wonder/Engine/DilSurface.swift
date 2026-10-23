import Foundation
import Observation

/// One DIL surface: a sandboxed JSContext running the web's worker (chatgpt-dil runtime + the
/// learning catalog, wonder-engine.js) and the native tree it renders into. The iOS counterpart
/// of public/dil-surface.js, speaking the same message protocol.
@MainActor
@Observable
final class DilSurface {
    let tree = DilTree()
    /// GenUI host actions: {handler: server|client, type, payload, nativeWidgetResolutionId?, componentName?}
    @ObservationIgnored var onAction: ((JSON) -> Void)?
    /// Widget state snapshots, sent on every change (view-state.js format).
    @ObservationIgnored var onViewState: ((JSON?) -> Void)?
    private(set) var lastError: String?
    private(set) var hasContent = false

    @ObservationIgnored private let box = HostBox()
    @ObservationIgnored private var last: (code: String, constants: JSON, appData: JSON)?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var viewportWidth: Int

    /// Holds the JSContext; touched only on JSEngine.queue.
    private final class HostBox: @unchecked Sendable { var host: JSHost?; var flushed: (() -> Void)? }

    init(viewState: JSON? = nil, viewportWidth: Double = 390) {
        self.viewportWidth = Int(viewportWidth.rounded())
        let box = self.box
        let width = self.viewportWidth
        let snapshotJSON = viewState.map { (["type": "setStateSnapshot", "snapshot": $0] as JSON).jsonString }
        JSEngine.queue.async { [weak self] in
            let host = JSHost(script: "wonder-engine", name: "dil-surface")
            box.host = host
            host.onPost = { [weak self] text in
                guard let msg = JSON.parse(text) else { return }
                if msg["type"].string == "viewStateFlushed" { box.flushed?(); box.flushed = nil; return }
                DispatchQueue.main.async { self?.receive(msg) }
            }
            if let snapshotJSON { host.call("__wonderReceive", [snapshotJSON]) }
            host.call("__wonderReceive", [(["type": "init", "viewportWidth": .number(Double(width)), "binary": false] as JSON).jsonString])
        }
    }

    private func receive(_ msg: JSON) {
        switch msg["type"].string {
        case "ops":
            tree.apply(msg["ops"].array)
            hasContent = !tree.root.children.isEmpty
        case "hostAction":
            onAction?(msg["action"])
        case "viewState":
            let s = msg["snapshot"]
            onViewState?(s.isNull ? nil : s)
        case "error":
            let e = msg["error"]
            lastError = "\(e["phase"].string ?? "dil"): \(e["message"].string ?? "")"
            #if DEBUG
            NSLog("[dil] %@", lastError ?? "")
            #endif
        default:
            break
        }
    }

    private func send(_ message: JSON) {
        let json = message.jsonString
        let box = self.box
        JSEngine.queue.async { box.host?.call("__wonderReceive", [json]) }
    }

    /// Render a DIL program. A new `code` re-evaluates the program; the same code re-renders with new appData.
    func render(code: String, constants: JSON, appData: JSON, animated: Bool = false) {
        last = (code, constants, appData)
        generation += 1
        send(["type": "render", "source": .string(code), "constants": constants, "appData": appData, "animated": .bool(animated), "sourceGeneration": .number(Double(generation))])
    }

    /// Re-render the current program with new appData (server componentResults).
    func setAppData(_ appData: JSON) {
        guard let last else { return }
        render(code: last.code, constants: last.constants, appData: appData)
    }

    func invoke(fnId: Int, args: [JSON] = []) {
        send(["type": "invokeFunction", "fnId": .number(Double(fnId)), "args": .array(args)])
    }

    func setViewport(width: Double) {
        let w = Int(width.rounded())
        guard w > 0, w != viewportWidth else { return }
        viewportWidth = w
        send(["type": "viewport", "width": .number(Double(w))])
    }

    func setViewState(_ snapshot: JSON?) { send(["type": "setStateSnapshot", "snapshot": snapshot ?? .null]) }
    func pruneViewState(keep: [String]) { send(["type": "pruneViewState", "keep": .array(keep.map { .string($0) })]) }
    func resetViewState() { send(["type": "resetViewState"]) }

    /// Clear what is shown (a failed lesson's "Try again").
    func clear() {
        tree.clear()
        hasContent = false
        last = nil
        send(["type": "reset"])
    }

    /// Deliver any pending widget-state change, then tear the context down.
    func destroy() {
        let box = self.box
        JSEngine.queue.async {
            guard let host = box.host else { return }
            let finish = { host.destroy(); box.host = nil }
            box.flushed = finish
            host.call("__wonderReceive", [(["type": "flushViewState"] as JSON).jsonString])
            if box.host != nil { JSEngine.queue.asyncAfter(deadline: .now() + 0.5) { if box.host != nil { finish() } } }
        }
    }
}
