import SwiftUI
import Observation

/// The Teacher (#/teacher, teacher-screen.js): an agent chat whose tool results arrive as
/// server-resolved <TeacherCard> components in each reply's DIL program.
@MainActor
@Observable
final class TeacherController {
    struct Message: Identifiable {
        let id = UUID()
        let role: String
        var text: String
        var surface: DilSurface?
        var index: Int?
        var typing = false
        var status: String?
        var error: String?
        var opener = false
    }

    var threadId: String?
    var messages: [Message] = []
    var followups: [String] = []
    var busy = false
    var draft = ""
    @ObservationIgnored private let core = WonderCore.shared
    @ObservationIgnored private let app = AppModel.shared
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var dils: [UUID: JSON] = [:]
    @ObservationIgnored private var pendingViewState: [UUID: JSON] = [:]

    func load(_ id: String?) {
        stop()
        for m in messages { m.surface?.destroy() }
        messages = []
        dils = [:]
        threadId = id
        followups = []
        guard let id else { return }
        let t = core.get("thread", ["id": .string(id)])
        for (i, m) in t["messages"].array.enumerated() {
            if m["role"].string == "user" {
                if m["opener"].bool != true { messages.append(Message(role: "user", text: m["content"].string ?? "")) }
            } else {
                var msg = Message(role: "assistant", text: m["content"].string ?? "", index: i)
                if !m["dil"].isNull {
                    msg.surface = makeSurface(msg.id, viewState: m["viewState"].isNull ? nil : m["viewState"])
                    dils[msg.id] = m["dil"]
                    msg.surface?.render(code: m["dil"]["code"].string ?? "", constants: m["dil"]["constants"], appData: appData(msg.id, index: i))
                }
                messages.append(msg)
            }
        }
        followups = t["messages"].array.last(where: { $0["role"].string == "assistant" })?["followups"].array.compactMap(\.string) ?? []
    }

    private func entry(_ index: Int?) -> JSON {
        guard let threadId, let index else { return .null }
        return core.get("thread", ["id": .string(threadId)])["messages"][index]
    }

    private func appData(_ id: UUID, index: Int?) -> JSON {
        core.mergeComponentResults(dils[id]?["appData"] ?? .null, entry(index)["componentResults"])
    }

    private func makeSurface(_ id: UUID, viewState: JSON?) -> DilSurface {
        let s = DilSurface(viewState: viewState, viewportWidth: 340)
        s.onAction = { [weak self] a in self?.handleAction(a, reply: id) }
        s.onViewState = { [weak self] vs in
            guard let self else { return }
            guard let index = self.messages.first(where: { $0.id == id })?.index, let tid = self.threadId else { self.pendingViewState[id] = vs ?? .null; return }
            _ = self.core.get("patchThreadMessage", ["threadId": .string(tid), "index": .number(Double(index)), "patch": ["viewState": vs ?? .null]])
        }
        return s
    }

    private func handleAction(_ a: JSON, reply id: UUID) {
        let p = a["payload"]
        guard let msg = messages.first(where: { $0.id == id }) else { return }
        if a["handler"].string == "server" {
            guard let index = msg.index, let tid = threadId else { app.show("Wait for the reply to finish"); return }
            Task {
                do {
                    let res = try await API.widgetAction(a)
                    if !res["componentResults"].isNull {
                        let merged = core.mergeComponentResults(["opGenui": ["componentResults": entry(index)["componentResults"]]], res["componentResults"])["opGenui"]["componentResults"]
                        _ = core.get("patchThreadMessage", ["threadId": .string(tid), "index": .number(Double(index)), "patch": ["componentResults": merged]])
                        _ = core.get("syncSavedPlans", ["results": res["componentResults"]])
                        msg.surface?.setAppData(appData(id, index: index))
                    }
                    for ca in res["clientActions"].array {
                        let r = core.get("teacherClientAction", ["threadId": .string(tid), "action": ca])
                        if let lesson = r["openLesson"].string { app.open(.lesson(lesson), in: .teacher) }
                        app.show(r["toast"].string)
                    }
                    if let m = res["issueTurn"]["message"].string { send(m) }
                } catch { app.show(error.localizedDescription) }
            }
            return
        }
        switch a["type"].string {
        case "issue_new_turn": if let q = p["query"].string { send(q) }
        case "open_url": if let u = p["url"].string { app.openExternal(u) }
        default:
            let r = core.get("clientAction", ["scope": "teacher", "threadId": threadId.map { .string($0) } ?? .null, "action": a])
            app.show(r["toast"].string)
        }
    }

    func send(_ text: String, opener: Bool = false) {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (opener || !message.isEmpty), !busy else { return }
        busy = true
        draft = ""
        followups = []
        if threadId == nil {
            let title = opener ? "Check-in · \(Date.now.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day()))" : message
            threadId = core.get("createThread", ["title": .string(title)]).string
        }
        guard let tid = threadId else { busy = false; return }
        let body = core.get("teacherRequest", ["threadId": .string(tid), "message": .string(message), "opener": .bool(opener)])
        var user: [String: JSON] = ["role": "user", "content": .string(message)]
        if opener { user["opener"] = true }
        _ = core.get("appendThreadMessage", ["threadId": .string(tid), "message": .object(user)])
        if !opener { messages.append(Message(role: "user", text: message)) }
        var bot = Message(role: "assistant", text: "", typing: true)
        let botId = bot.id
        bot.surface = makeSurface(botId, viewState: nil)
        messages.append(bot)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let r = try await API.streamTurn("/api/teacher/stream", body) { [self] ev in
                    switch ev {
                    case .reasoning(let s): self.update(botId) { $0.status = s["active"].bool == false ? nil : s["text"].string }
                    case .content(_, let rec):
                        guard !rec["dil"].isNull else { return }
                        self.update(botId) { $0.typing = false }
                        self.dils[botId] = rec["dil"]
                        self.messages.first(where: { $0.id == botId })?.surface?.render(code: rec["dil"]["code"].string ?? "", constants: rec["dil"]["constants"], appData: rec["dil"]["appData"], animated: rec["status"].string != "complete")
                    case .control: break
                    }
                }
                if !r.failure.isNull { throw API.APIError(message: r.failure["message"].string ?? "The Teacher could not answer") }
                let d = r.message["dil"]
                let dil: JSON = d.isNull ? .null : ["code": d["code"], "constants": d["constants"], "appData": d["appData"]]
                var entry: [String: JSON] = ["role": "assistant", "content": r.message["markdown"], "dil": dil, "componentResults": d["appData"]["opGenui"]["componentResults"].isNull ? [:] : d["appData"]["opGenui"]["componentResults"], "followups": r.final["followupPrompts"].isNull ? [] : r.final["followupPrompts"]]
                if let vs = self.pendingViewState[botId], !vs.isNull { entry["viewState"] = vs }
                let index = self.core.get("appendThreadMessage", ["threadId": .string(tid), "message": .object(entry)]).int
                self.update(botId) { $0.index = index; $0.typing = false; $0.status = nil; $0.text = r.message["markdown"].string ?? "" }
                self.followups = r.final["followupPrompts"].array.compactMap(\.string)
                self.core.flush()
                if r.final["debug"]["truncated"].bool == true { self.app.show("The reply was cut short (length limit).") }
            } catch {
                if !Task.isCancelled {
                    self.update(botId) { $0.typing = false; $0.status = nil; $0.error = error.localizedDescription }
                    _ = self.core.get("popThreadMessage", ["threadId": .string(tid)]) // let the learner resend
                    if !opener { self.draft = message }
                }
            }
            self.busy = false
        }
    }

    private func update(_ id: UUID, _ fn: (inout Message) -> Void) {
        if let i = messages.firstIndex(where: { $0.id == id }) { fn(&messages[i]) }
    }

    func stop() { task?.cancel(); task = nil; busy = false }
}

struct TeacherView: View {
    @Environment(AppModel.self) private var app
    @State private var t = TeacherController()
    @State private var showThreads = false
    @FocusState private var focused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if t.messages.isEmpty { intro }
                    ForEach(t.messages) { m in bubble(m).id(m.id) }
                    if !t.followups.isEmpty { ChipFlow(items: t.followups) { q in Chip(text: q) { t.send(q) } } }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(16)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: t.messages.count) { _, _ in withAnimation { proxy.scrollTo("end", anchor: .bottom) } }
        }
        .background(DilTheme.bg)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(threadTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button { showThreads = true } label: { Image(systemName: "sidebar.left") }.accessibilityLabel("Chats") }
            ToolbarItem(placement: .topBarTrailing) { Button { t.load(nil) } label: { Image(systemName: "square.and.pencil") }.accessibilityLabel("New chat") }
        }
        .sheet(isPresented: $showThreads) { ThreadList(current: t.threadId) { id in t.load(id); showThreads = false } }
        .onAppear(perform: consumePending)
        .onChange(of: app.pendingTeacher) { _, _ in consumePending() }
    }

    private var threadTitle: String {
        guard let id = t.threadId else { return "Teacher" }
        return app.core.get("thread", ["id": .string(id)])["title"].string ?? "Teacher"
    }

    private func consumePending() {
        if let p = app.pendingTeacher {
            app.pendingTeacher = nil
            if p.threadId != t.threadId { t.load(p.threadId) }
            if p.opener { t.send("", opener: true) } else if let m = p.message { t.send(m) }
        } else if t.threadId == nil && t.messages.isEmpty && app.core.get("shouldCheckIn").bool == true {
            t.send("", opener: true)
        }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "graduationcap").font(.system(size: 28)).foregroundStyle(DilTheme.accent)
            Text("Your Teacher").font(.system(size: 22, weight: .semibold))
            Text("It plans your week, proposes lessons, quizzes you from your deck and remembers what matters. It sees your progress, your saved plan and what Wonder knows about you.")
                .font(.system(size: 15)).foregroundStyle(DilTheme.ink2)
            ForEach(["Plan a week to get good at statistics", "Quiz me on what I learned last", "How am I doing?", "What should I learn next?"], id: \.self) { s in
                Button { t.send(s) } label: {
                    HStack { Text(s).foregroundStyle(DilTheme.ink); Spacer(); Image(systemName: "arrow.up.right").foregroundStyle(DilTheme.ink3) }
                        .font(.system(size: 15)).padding(12)
                        .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface))
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(DilTheme.line))
                }
                .buttonStyle(PressFeedbackStyle())
            }
            Button { t.send("", opener: true) } label: { Label("Check in on my progress", systemImage: "sparkles") }.buttonStyle(.ghostLink)
        }
    }

    @ViewBuilder
    private func bubble(_ m: TeacherController.Message) -> some View {
        if m.role == "user" {
            HStack {
                Spacer(minLength: 48)
                Text(m.text).font(.system(size: 15)).foregroundStyle(DilTheme.brandInk)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(DilTheme.brand))
            }
        } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "graduationcap.fill").font(.system(size: 12)).foregroundStyle(DilTheme.accent)
                    .frame(width: 26, height: 26).background(Circle().fill(DilTheme.brandSubtle))
                VStack(alignment: .leading, spacing: 8) {
                    if let s = m.status { ReasoningLine(text: s) }
                    if m.typing && m.status == nil { TypingDots() }
                    if let s = m.surface { DilSurfaceView(surface: s, kind: .message) }
                    if let e = m.error { Text(e).font(.system(size: 13)).foregroundStyle(DilTheme.danger) }
                }
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Ask the Teacher…", text: $t.draft, axis: .vertical)
                .lineLimit(1...5)
                .focused($focused)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 18).fill(DilTheme.surface))
                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(DilTheme.controlBorder))
            Button { t.send(t.draft) } label: {
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36).foregroundStyle(DilTheme.brandInk).background(Circle().fill(DilTheme.brand))
            }
            .disabled(t.busy || t.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(.bar)
    }
}

private struct ThreadList: View {
    let current: String?
    let pick: (String?) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        let _ = app.core.revision
        NavigationStack {
            List {
                Button { pick(nil) } label: { Label("New chat", systemImage: "square.and.pencil") }
                ForEach(Array(app.core.get("threads").array.enumerated()), id: \.offset) { _, th in
                    Button { pick(th["id"].string) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(th["title"].string ?? "Chat").foregroundStyle(DilTheme.ink).fontWeight(th["id"].string == current ? .semibold : .regular)
                            if let d = Date.iso(th["updatedAt"].string) { Text(d.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(DilTheme.ink3) }
                        }
                    }
                    .swipeActions { Button("Delete", role: .destructive) { _ = app.core.get("deleteThread", ["id": th["id"]]); if th["id"].string == current { pick(nil) } } }
                }
            }
            .navigationTitle("Teacher chats")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}
