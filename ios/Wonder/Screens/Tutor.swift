import SwiftUI
import Observation

/// The lesson tutor (app.js createTutor): a transcript of user messages and DIL replies, each
/// reply its own sandboxed surface, streamed from /api/tutor/stream with the lesson as context.
@MainActor
@Observable
final class TutorController {
    struct Message: Identifiable {
        let id = UUID()
        let role: String
        var text: String
        var surface: DilSurface?
        var index: Int?          // its entry in lesson.tutor once saved
        var error: String?
        var typing = false
    }

    let lessonId: String
    var messages: [Message] = []
    var followups: [String] = []
    var busy = false
    var open = false
    var draft = ""
    @ObservationIgnored weak var lesson: LessonController?
    @ObservationIgnored private let core = WonderCore.shared
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var replyAppData: [UUID: JSON] = [:]
    @ObservationIgnored private var replyDil: [UUID: JSON] = [:]
    @ObservationIgnored private var pendingViewState: [UUID: JSON] = [:]

    static let starters: [(String, String, String)] = [
        ("list.bullet", "Summarize the key ideas", "Summarize the key ideas of this lesson in a few bullet points."),
        ("globe", "Give me a real-world example", "Give me a fresh real-world example of the main idea."),
        ("scope", "Quiz me on this lesson", "Quiz me on this lesson."),
        ("text.quote", "Explain it like I’m 12", "Explain the main idea of this lesson like I am 12."),
    ]

    init(lessonId: String) {
        self.lessonId = lessonId
        let saved = core.lesson(lessonId)["tutor"].array
        for (i, m) in saved.enumerated() {
            if m["role"].string == "user" { messages.append(Message(role: "user", text: m["content"].string ?? "")) }
            else if !m["dil"].isNull {
                var msg = Message(role: "assistant", text: m["content"].string ?? "", index: i)
                msg.surface = makeSurface(id: msg.id, index: i, viewState: m["viewState"].isNull ? nil : m["viewState"])
                replyDil[msg.id] = m["dil"]
                msg.surface?.render(code: m["dil"]["code"].string ?? "", constants: m["dil"]["constants"], appData: m["dil"]["appData"])
                messages.append(msg)
            }
        }
        followups = saved.last(where: { $0["role"].string == "assistant" })?["followups"].array.compactMap(\.string) ?? []
    }

    var guided: Bool { core.get("settings")["tutorMode"].string == "socratic" }
    func toggleGuided() {
        core.setSetting("tutorMode", .string(guided ? "direct" : "socratic"))
        AppModel.shared.show(guided ? "Guide me is on: the tutor asks before it tells" : "Guide me is off")
    }

    private func makeSurface(id: UUID, index: Int?, viewState: JSON?) -> DilSurface {
        let s = DilSurface(viewState: viewState, viewportWidth: 320)
        s.onAction = { [weak self] a in self?.handleAction(a, reply: id) }
        s.onViewState = { [weak self] vs in
            guard let self else { return }
            if let i = self.messages.first(where: { $0.id == id })?.index { self.saveViewState(i, vs) } else { self.pendingViewState[id] = vs ?? .null }
        }
        return s
    }

    private func saveViewState(_ index: Int, _ vs: JSON?) {
        var tutor = core.lesson(lessonId)["tutor"].array
        guard tutor.indices.contains(index), tutor[index]["role"].string == "assistant" else { return }
        var m = tutor[index].object
        if let vs { m["viewState"] = vs } else { m["viewState"] = nil }
        tutor[index] = .object(m)
        core.saveLesson(lessonId, ["tutor": .array(tutor)])
    }

    private func appData(for id: UUID) -> JSON {
        core.mergeComponentResults(replyDil[id]?["appData"] ?? .null, replyAppData[id]?["opGenui"]["componentResults"] ?? .null)
    }

    private func handleAction(_ a: JSON, reply id: UUID) {
        if a["handler"].string == "server" {
            Task {
                guard let res = try? await API.widgetAction(a) else { return }
                if !res["componentResults"].isNull {
                    replyAppData[id] = core.mergeComponentResults(replyAppData[id] ?? .null, res["componentResults"])
                    messages.first(where: { $0.id == id })?.surface?.setAppData(appData(for: id))
                }
                if let m = res["issueTurn"]["message"].string { send(m) }
            }
            return
        }
        let p = a["payload"]
        switch a["type"].string {
        case "issue_new_turn": if let q = p["query"].string { send(q) }
        case "open_url": if let u = p["url"].string { AppModel.shared.openExternal(u) }
        default: AppModel.shared.show(core.get("clientAction", ["scope": "lesson", "lessonId": .string(lessonId), "action": a])["toast"].string)
        }
    }

    /// Reset every reply's widgets; returns their graded quiz ids.
    func resetWidgets() -> [String] {
        var graded: [String] = []
        for m in messages where m.role == "assistant" {
            graded += core.get("quizResolutionIds", ["appData": replyAppData[m.id] ?? .null]).array.compactMap(\.string)
            replyAppData[m.id] = nil
            m.surface?.setAppData(appData(for: m.id))
            m.surface?.resetViewState()
        }
        var tutor = core.lesson(lessonId)["tutor"].array
        for i in tutor.indices where tutor[i]["role"].string == "assistant" { var o = tutor[i].object; o["viewState"] = nil; tutor[i] = .object(o) }
        core.saveLesson(lessonId, ["tutor": .array(tutor)])
        return graded
    }

    func send(_ text: String) {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, !busy else { return }
        let l = core.lesson(lessonId)
        guard l["status"].string == "complete" else { AppModel.shared.show("Wait for the lesson to finish writing first"); return }
        busy = true
        draft = ""
        followups = []
        let history: [JSON] = l["tutor"].array.map { ["role": $0["role"], "content": $0["content"]] }
        messages.append(Message(role: "user", text: message))
        var bot = Message(role: "assistant", text: "", typing: true)
        let botId = bot.id
        bot.surface = makeSurface(id: botId, index: nil, viewState: nil)
        messages.append(bot)
        let useWebSearch = message.range(of: #"\b(sources?|cite|citations?|latest|current(ly)?|recent(ly)?|news|today|this year|search|look (it )?up)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
        let body: JSON = [
            "message": .string(message), "history": .array(history), "lessonContext": ["title": l["title"], "markdown": l["markdown"]],
            "useWebSearch": .bool(useWebSearch), "memoryEnabled": .bool(core.memoryEnabled), "mastery": core.get("requestMastery"),
            "mode": .string(guided ? "socratic" : "direct"),
        ]
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let r = try await API.streamTurn("/api/tutor/stream", body) { [self] ev in
                    if case .content(_, let rec) = ev, !rec["dil"].isNull {
                        self.update(botId) { $0.typing = false }
                        self.replyDil[botId] = rec["dil"]
                        self.messages.first(where: { $0.id == botId })?.surface?.render(code: rec["dil"]["code"].string ?? "", constants: rec["dil"]["constants"], appData: self.appData(for: botId), animated: rec["status"].string != "complete")
                    }
                }
                if !r.failure.isNull { throw API.APIError(message: r.failure["message"].string ?? "The tutor could not answer") }
                let d = r.message["dil"]
                let dil: JSON = d.isNull ? .null : ["code": d["code"], "constants": d["constants"], "appData": d["appData"]]
                let prompts = r.final["followupPrompts"].array
                let base = self.core.lesson(self.lessonId)["tutor"].array
                var entry: [String: JSON] = ["role": "assistant", "content": r.message["markdown"], "dil": dil, "followups": .array(prompts)]
                if let vs = self.pendingViewState[botId], !vs.isNull { entry["viewState"] = vs }
                self.core.saveLesson(self.lessonId, ["tutor": .array(base + [["role": "user", "content": .string(message)], .object(entry)])])
                self.update(botId) { $0.index = base.count + 1; $0.typing = false; $0.text = r.message["markdown"].string ?? "" }
                self.followups = prompts.compactMap(\.string)
            } catch {
                if !Task.isCancelled { self.update(botId) { $0.typing = false; $0.error = error.localizedDescription } }
            }
            self.busy = false
        }
    }

    private func update(_ id: UUID, _ fn: (inout Message) -> Void) {
        if let i = messages.firstIndex(where: { $0.id == id }) { fn(&messages[i]) }
    }

    func stop() { task?.cancel(); task = nil; busy = false }
    func destroy() { for m in messages { m.surface?.destroy() } }
}

struct TutorView: View {
    @Bindable var tutor: TutorController
    var lessonTitle: String
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if tutor.messages.isEmpty { empty }
                        ForEach(tutor.messages) { m in bubble(m).id(m.id) }
                        if !tutor.followups.isEmpty {
                            ChipFlow(items: tutor.followups) { q in Chip(text: q) { tutor.send(q) } }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(16)
                }
                .onChange(of: tutor.messages.count) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: tutor.followups) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
            }
            .background(DilTheme.bg)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle("Tutor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { tutor.toggleGuided() } label: {
                        Label("Guide me", systemImage: tutor.guided ? "questionmark.bubble.fill" : "questionmark.bubble")
                    }
                    .accessibilityHint("The tutor asks guiding questions instead of giving answers right away")
                }
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
        }
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Stuck on something? Ask about any part of “\(lessonTitle)”.").font(.system(size: 15)).foregroundStyle(DilTheme.ink2)
            ForEach(TutorController.starters, id: \.1) { s in
                Button { tutor.send(s.2) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: s.0).foregroundStyle(DilTheme.accent).frame(width: 20)
                        Text(s.1).foregroundStyle(DilTheme.ink)
                        Spacer()
                    }
                    .font(.system(size: 15))
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(DilTheme.line))
                }
                .buttonStyle(PressFeedbackStyle())
            }
        }
    }

    @ViewBuilder
    private func bubble(_ m: TutorController.Message) -> some View {
        if m.role == "user" {
            HStack {
                Spacer(minLength: 48)
                Text(m.text).font(.system(size: 15)).foregroundStyle(DilTheme.brandInk)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DilTheme.brand))
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if m.typing { TypingDots() }
                if let s = m.surface { DilSurfaceView(surface: s, kind: .message) }
                if let e = m.error { Text(e).font(.system(size: 13)).foregroundStyle(DilTheme.danger) }
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(tutor.guided ? "Ask, and the tutor will guide you…" : "Ask anything about this lesson…", text: $tutor.draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 18).fill(DilTheme.surface))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(DilTheme.controlBorder))
            Button { tutor.send(tutor.draft) } label: {
                Image(systemName: tutor.busy ? "ellipsis" : "arrow.up").font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36).foregroundStyle(DilTheme.brandInk).background(Circle().fill(DilTheme.brand))
            }
            .disabled(tutor.busy || tutor.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }
}
