import Foundation
import Observation

/// One rendered DIL element (or text node). The sandbox owns the tree; Swift mirrors it by
/// applying the runtime's six render ops (chatgpt-dil runtime.js OP), the same ops the web's
/// DOM host applies. Each node is observable on its own, so a prop change re-renders one view.
@Observable
final class DilNode: Identifiable {
    let id: Int
    let type: String
    var props: [String: JSON] = [:]
    var text: String = ""
    var children: [DilNode] = []
    @ObservationIgnored weak var parent: DilNode?

    init(id: Int, type: String, text: String = "") {
        self.id = id
        self.type = type
        self.text = text
    }

    var isText: Bool { type == "#text" }
    subscript(_ key: String) -> JSON { props[key] ?? .null }

    /// Concatenated text of this subtree (accessibility labels, page titles).
    var plainText: String { isText ? text : children.map(\.plainText).joined() }
}

@MainActor
@Observable
final class DilTree {
    let root = DilNode(id: 0, type: "#root")
    @ObservationIgnored private var nodes: [Int: DilNode] = [:]
    /// Bumped after each applied batch (scroll-to-bottom, page counts).
    private(set) var version = 0

    init() { nodes[0] = root }

    var nodeCount: Int { nodes.count - 1 }

    func apply(_ ops: [JSON]) {
        for op in ops { applyOne(op) }
        version &+= 1
    }

    func clear() {
        for c in root.children { drop(c) }
        root.children = []
        nodes = [0: root]
        version &+= 1
    }

    private func applyOne(_ op: JSON) {
        guard let kind = op["op"].string, let id = op["id"].int else { return }
        switch kind {
        case "createElement":
            nodes[id] = DilNode(id: id, type: op["type"].string ?? "box")
        case "createText":
            nodes[id] = DilNode(id: id, type: "#text", text: op["text"].string ?? "")
        case "destroy":
            guard let n = nodes[id] else { return }
            detach(n)
            drop(n)
        case "move":
            guard let n = nodes[id], let p = op["parent"].int.flatMap({ nodes[$0] }) else { return }
            detach(n)
            let at = min(max(0, op["index"].int ?? 0), p.children.count)
            p.children.insert(n, at: at)
            n.parent = p
        case "propChanged":
            guard let n = nodes[id], let name = op["name"].string else { return }
            // JSON.stringify drops `value: undefined`: a missing value removes the prop
            if case .object(let o) = op, let v = o["value"] { n.props[name] = v } else { n.props[name] = nil }
        case "textChanged":
            nodes[id]?.text = op["text"].string ?? ""
        default:
            break
        }
    }

    private func detach(_ n: DilNode) {
        guard let p = n.parent else { return }
        if let i = p.children.firstIndex(where: { $0 === n }) { p.children.remove(at: i) }
        n.parent = nil
    }

    private func drop(_ n: DilNode) {
        nodes[n.id] = nil
        for c in n.children { drop(c) }
    }
}
