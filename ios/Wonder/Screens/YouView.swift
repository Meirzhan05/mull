import SwiftUI

/// You (#/you): name and totals, settings, the server address, and learner memory.
struct YouView: View {
    @Environment(AppModel.self) private var app
    @State private var name = ""
    @State private var server = API.server
    @State private var memory: [JSON] = []
    @State private var memoryError: String? = nil
    @State private var confirmErase = false
    @State private var confirmForget = false
    @State private var newFact = ""

    var body: some View {
        let _ = app.core.revision
        let t = app.core.get("today")
        let totals = t["totals"]
        let settings = app.core.get("settings")
        Form {
            Section {
                TextField("Your name", text: $name)
                    .onSubmit { app.core.setSetting("name", .string(name.trimmingCharacters(in: .whitespaces))) }
                    .submitLabel(.done)
                LabeledContent("Total XP", value: "\(totals["xp"].int ?? 0)")
                LabeledContent("Streak", value: "\(totals["streak"].int ?? 0) days (best \(totals["bestStreak"].int ?? 0))")
                LabeledContent("Lessons finished", value: "\(totals["lessonsFinished"].int ?? 0) of \(totals["lessonsStarted"].int ?? 0)")
                LabeledContent("Cards", value: "\(totals["cards"].int ?? 0) · \(totals["mastered"].int ?? 0) mastered")
            } header: { Text("You") }

            Section("Learning") {
                Picker("Daily goal", selection: Binding(get: { settings["dailyGoal"].int ?? 30 }, set: { app.core.setSetting("dailyGoal", .number(Double($0))) })) {
                    ForEach(app.core.get("constants")["DAILY_GOALS"].array.compactMap { g -> (Int, String)? in
                        guard let xp = g["xp"].int ?? g.int else { return nil }
                        return (xp, g["label"].string.map { "\($0) · \(xp) XP" } ?? "\(xp) XP")
                    }, id: \.0) { Text($0.1).tag($0.0) }
                }
                Toggle("Use what Wonder knows about me", isOn: Binding(get: { settings["memoryEnabled"].bool != false }, set: { app.core.setSetting("memoryEnabled", .bool($0)) }))
                Toggle("Teacher check-in each day", isOn: Binding(get: { settings["teacherCheckIn"].bool != false }, set: { app.core.setSetting("teacherCheckIn", .bool($0)) }))
                Toggle("Tutor guides with questions", isOn: Binding(get: { settings["tutorMode"].string == "socratic" }, set: { app.core.setSetting("tutorMode", .string($0 ? "socratic" : "direct")) }))
            }

            Section {
                ForEach(Array(memory.enumerated()), id: \.offset) { _, m in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m["fact"].string ?? "")
                        Text([m["kind"].string, m["source"].string].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(DilTheme.ink3)
                    }
                    .swipeActions { Button("Forget", role: .destructive) { Task { await forget(m["id"].string) } } }
                }
                if memory.isEmpty { Text(memoryError ?? "Nothing yet. Wonder notes your goals, preferences and what you find hard as you learn.").foregroundStyle(DilTheme.ink3) }
                HStack {
                    TextField("Tell Wonder something about you", text: $newFact).submitLabel(.done).onSubmit { Task { await add() } }
                    Button("Add") { Task { await add() } }.disabled(newFact.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if !memory.isEmpty { Button("Forget everything", role: .destructive) { confirmForget = true } }
            } header: { Text("What Wonder knows about you") } footer: { Text("Kept by the Wonder server and used in lessons, the tutor and the Teacher when the switch above is on.") }

            Section {
                TextField("http://localhost:8750", text: $server)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onSubmit { saveServer() }
                HStack {
                    Circle().fill(app.serverReachable == true ? DilTheme.success : app.serverReachable == false ? DilTheme.danger : DilTheme.ink3).frame(width: 8, height: 8)
                    Text(app.serverReachable == true ? "Connected · \(app.status?.mode == "claude" ? "Claude (\(app.status?.model ?? ""))" : "demo mode")" : app.serverReachable == false ? "Not reachable" : "Checking…")
                        .foregroundStyle(DilTheme.ink2)
                    Spacer()
                    Button("Check") { saveServer() }
                }
            } header: { Text("Server") } footer: {
                Text("Claude runs on the Wonder server (genui-lab/wonder, npm run dev); the app never holds an API key. The Simulator reaches your Mac at localhost; on an iPhone use your Mac’s address on the same network, for example http://192.168.1.20:8750.")
            }

            Section {
                Button("Erase all lessons, cards and progress", role: .destructive) { confirmErase = true }
            } footer: { Text("Wonder for iOS · the lesson UI is written by Claude as DIL and run by the same engine as the web app.") }
        }
        .navigationTitle("You")
        .onAppear { name = settings["name"].string ?? ""; Task { await loadMemory() } }
        .refreshable { await loadMemory(); await app.loadStatus() }
        .confirmationDialog("Erase everything on this device?", isPresented: $confirmErase, titleVisibility: .visible) {
            Button("Erase", role: .destructive) { _ = app.core.get("reset"); app.paths = [.today: [], .library: [], .review: [], .teacher: [], .you: []]; app.show("Everything on this device was erased") }
        }
        .confirmationDialog("Forget everything Wonder knows about you?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget everything", role: .destructive) { Task { _ = try? await API.delete("/api/memory", ["all": true]); await loadMemory() } }
        }
    }

    private func saveServer() {
        API.server = server.trimmingCharacters(in: .whitespacesAndNewlines)
        server = API.server
        Task { await app.loadStatus(); await loadMemory() }
    }

    private func loadMemory() async {
        do {
            memory = try await API.get("/api/memory")["items"].array
            memoryError = nil
        } catch {
            memoryError = "Memory lives on the server, which can’t be reached right now."
        }
    }

    private func forget(_ id: String?) async {
        guard let id, let q = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }
        _ = try? await API.delete("/api/memory?id=\(q)")
        await loadMemory()
    }

    private func add() async {
        let f = newFact.trimmingCharacters(in: .whitespaces)
        guard !f.isEmpty else { return }
        newFact = ""
        _ = try? await API.post("/api/memory", ["fact": .string(f), "kind": "background"])
        await loadMemory()
    }
}
