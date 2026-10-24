import Foundation

/// The Wonder server (genui-lab/wonder, `npm run dev`). Claude runs there: the app never holds
/// an API key. The Simulator reaches the Mac's server at localhost; a device needs its address.
enum API {
    static let defaultServer = "http://localhost:8750"
    static let serverKey = "wonder.server"
    static let ndjsonType = "application/vnd.openai.conversation-source+ndjson"

    static var server: String {
        get { UserDefaults.standard.string(forKey: serverKey).flatMap { $0.isEmpty ? nil : $0 } ?? defaultServer }
        set { UserDefaults.standard.set(newValue, forKey: serverKey) }
    }

    static func url(_ path: String) throws -> URL {
        let base = server.hasSuffix("/") ? String(server.dropLast()) : server
        guard let u = URL(string: base + path), u.scheme == "http" || u.scheme == "https" else { throw APIError(message: "The server address is not a valid http(s) URL") }
        return u
    }

    struct APIError: LocalizedError {
        let message: String
        var status = 0
        var body: JSON = .null
        var errorDescription: String? { message }
    }

    static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 300 // lessons stream for minutes; the server has its own idle watchdog
        c.timeoutIntervalForResource = 1800
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private static func check(_ data: Data, _ response: URLResponse) throws -> JSON {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = JSON.parse(data: data) ?? .null
        if !(200..<300).contains(status) || json["ok"].bool == false {
            throw APIError(message: json["error"].string ?? "Request failed (\(status))", status: status, body: json)
        }
        return json
    }

    static func get(_ path: String) async throws -> JSON {
        let (data, res) = try await session.data(from: try url(path))
        return try check(data, res)
    }

    static func post(_ path: String, _ body: JSON) async throws -> JSON {
        var req = URLRequest(url: try url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body.jsonString.data(using: .utf8)
        let (data, res) = try await session.data(for: req)
        return try check(data, res)
    }

    static func delete(_ path: String, _ body: JSON? = nil) async throws -> JSON {
        var req = URLRequest(url: try url(path))
        req.httpMethod = "DELETE"
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body.jsonString.data(using: .utf8)
        }
        let (data, res) = try await session.data(for: req)
        return try check(data, res)
    }

    /// `/api/widget_action`, the server half of GenUI.dispatchWidgetAction.
    static func widgetAction(_ action: JSON) async throws -> JSON {
        try await post("/api/widget_action", [
            "componentName": action["componentName"], "action_type": action["type"],
            "payload": action["payload"], "resolutionId": action["nativeWidgetResolutionId"],
        ])
    }

    // MARK: streamed turns

    enum TurnEvent {
        case content(message: JSON, record: JSON)
        case reasoning(JSON)
        case control(JSON)
    }

    struct TurnResult {
        let message: JSON
        let failure: JSON
        let final: JSON
    }

    /// POST and read a conversation-source NDJSON stream. Records are parsed and validated by
    /// chatgpt-dil's ConversationSourceParser in the core context (stream-client.js on the web).
    @MainActor
    static func streamTurn(_ path: String, _ body: JSON, onEvent: @MainActor (TurnEvent) -> Void) async throws -> TurnResult {
        var req = URLRequest(url: try url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(ndjsonType, forHTTPHeaderField: "Accept")
        req.httpBody = body.jsonString.data(using: .utf8)
        let (bytes, res) = try await session.bytes(for: req)
        let http = res as? HTTPURLResponse
        if let http, !(200..<300).contains(http.statusCode) {
            var data = Data()
            for try await b in bytes { data.append(b) }
            throw APIError(message: JSON.parse(data: data)?["error"].string ?? "Request failed (\(http.statusCode))", status: http.statusCode)
        }
        guard (http?.value(forHTTPHeaderField: "Content-Type") ?? "").hasPrefix(ndjsonType) else { throw APIError(message: "Unexpected response type") }

        let core = WonderCore.shared
        let sid = try core.call("openStream")
        var finished = false
        defer { if !finished { _ = core.get("cancelStream", ["id": sid]) } }
        func deliver(_ events: JSON) {
            for e in events.array {
                switch e["type"].string {
                case "content": onEvent(.content(message: e["message"], record: e["record"]))
                case "reasoning": onEvent(.reasoning(e["status"]))
                case "control": onEvent(.control(e["detail"]))
                default: break
                }
            }
        }
        for try await line in bytes.lines {
            try Task.checkCancellation()
            deliver(try core.call("pushStream", ["id": sid, "text": .string(line + "\n")]))
        }
        let done = try core.call("finishStream", ["id": sid])
        finished = true
        deliver(done["events"])
        return TurnResult(message: done["message"], failure: done["failure"], final: done["final"])
    }
}
