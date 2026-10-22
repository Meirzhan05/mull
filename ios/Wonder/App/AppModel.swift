import SwiftUI
import Observation

enum Tab: Hashable { case today, library, review, teacher, you }

enum Route: Hashable {
    case lesson(String)
    case course(String)
    case reviewLesson(String)
}

/// App-wide state and the actions screens share (app.js: startLesson, planCourse, askTeacher,
/// openPlanItem, openCourseLesson, giveXp, the status banner and toasts).
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    var tab: Tab = .today
    var paths: [Tab: [Route]] = [.today: [], .library: [], .review: [], .teacher: [], .you: []]
    var toast: String?
    var status: (mode: String, model: String)? = nil
    var serverReachable: Bool? = nil
    /// A message (or check-in) the Teacher screen should send when it opens.
    var pendingTeacher: PendingTeacher? = nil
    var planningCourse = false

    struct PendingTeacher: Equatable { var message: String?; var opener: Bool; var threadId: String? }

    let core = WonderCore.shared
    @ObservationIgnored private var toastTask: Task<Void, Never>?

    func path(_ tab: Tab) -> Binding<[Route]> {
        Binding(get: { self.paths[tab] ?? [] }, set: { self.paths[tab] = $0 })
    }

    func show(_ message: String?, seconds: Double = 2.6) {
        guard let message, !message.isEmpty else { return }
        toastTask?.cancel()
        withAnimation(.spring(duration: 0.3)) { toast = message }
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) { self?.toast = nil }
        }
    }

    func open(_ route: Route, in tab: Tab? = nil) {
        let t = tab ?? self.tab
        self.tab = t
        paths[t, default: []].append(route)
    }

    // MARK: status

    func loadStatus() async {
        do {
            let s = try await API.get("/api/status")
            status = (s["mode"].string ?? "demo", s["model"].string ?? "")
            serverReachable = true
        } catch {
            serverReachable = false
        }
    }

    // MARK: actions

    func startLesson(_ topic: String, level: String = "beginner", extra: JSON = [:]) {
        let t = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        var fields: [String: JSON] = ["topic": .string(t), "title": .string(t), "level": .string(level)]
        for (k, v) in extra.object { fields[k] = v }
        guard let id = core.createLesson(.object(fields)) else { return }
        open(.lesson(id))
    }

    func planCourse(_ topic: String, level: String = "beginner") async -> Bool {
        let t = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !planningCourse else { return false }
        planningCourse = true
        defer { planningCourse = false }
        show("Planning your course…", seconds: 8)
        do {
            let r = try await API.post("/api/course/plan", ["topic": .string(t), "level": .string(level)])
            guard let id = try core.call("addCourse", ["plan": r["plan"], "topic": .string(t), "level": .string(level)]).string else { return false }
            toast = nil
            open(.course(id))
            return true
        } catch {
            show(error.localizedDescription)
            return false
        }
    }

    func openCourseLesson(_ courseId: String, si: Int, li: Int) {
        if let id = core.get("openCourseLesson", ["courseId": .string(courseId), "si": .number(Double(si)), "li": .number(Double(li))]).string {
            open(.lesson(id))
        }
    }

    func askTeacher(_ text: String) {
        pendingTeacher = PendingTeacher(message: text, opener: false, threadId: nil)
        tab = .teacher
    }

    func teacherCheckIn() {
        pendingTeacher = PendingTeacher(message: nil, opener: true, threadId: nil)
        tab = .teacher
    }

    func openPlanItem(planId: String, di: Int, ii: Int) {
        let r = core.get("openPlanItem", ["planId": .string(planId), "di": .number(Double(di)), "ii": .number(Double(ii))])
        if r["review"].bool == true { tab = .review; return }
        if let msg = r["teacher"].string { pendingTeacher = PendingTeacher(message: msg, opener: false, threadId: r["threadId"].string); tab = .teacher; return }
        if let id = r["openLesson"].string { open(.lesson(id), in: .today) }
    }

    func giveXp(_ amount: Int, why: String) {
        let r = core.get("giveXp", ["amount": .number(Double(amount))])
        if r["goalMet"].bool == true { show("Today’s goal is met · +\(amount) XP", seconds: 3.6) } else if amount > 0 { show("+\(amount) XP · \(why)") }
    }

    /// Open a link from a widget (open_url): web sources outside the app, never other schemes.
    func openExternal(_ raw: String) {
        if raw.hasPrefix("/api/materials/file?id=") {
            if let u = try? API.url(raw) { UIApplication.shared.open(u) }
            return
        }
        guard let u = URL(string: raw), u.scheme == "https" || u.scheme == "http" else { return }
        UIApplication.shared.open(u)
    }
}
