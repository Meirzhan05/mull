import SwiftUI
import Observation

/// A lesson's lifecycle on iOS, ported from app.js renderLesson / streamLesson: stream the
/// lesson from /api/lesson/stream into a DIL surface, persist it as it grows, steer it live,
/// resume an interrupted one, revise from a page, and route widget actions.
@MainActor
@Observable
final class LessonController {
    let lessonId: String
    let surface: DilSurface
    let tutor: TutorController

    enum SteerMode { case hidden, live, resume, revise }

    private(set) var title = ""
    private(set) var markdown = ""
    private(set) var streaming = false
    private(set) var reasoning: String? = nil
    private(set) var error: String? = nil
    private(set) var status = "new"
    private(set) var finished = false
    private(set) var quality: JSON = .null
    var steerMode: SteerMode = .hidden
    var steerStatus: String? = nil
    var steerBusy = false
    var interruptedNote: String? = nil
    var currentPage = 0
    var collecting = false
    var pack: PackData? = nil

    struct PackData: Identifiable { let id = UUID(); let cards: [JSON]; let items: [JSON] }

    @ObservationIgnored private let core = WonderCore.shared
    @ObservationIgnored private let app = AppModel.shared
    @ObservationIgnored private var dil: JSON = .null       // the lesson's program {code, constants, appData}
    @ObservationIgnored private var widgetAppData: JSON = .null // server widget results (quiz grades)
    @ObservationIgnored private var busy = false
    @ObservationIgnored private var queued: (instruction: String, fromPage: Int, fallback: Bool)? = nil
    @ObservationIgnored private var task: Task<Void, Never>? = nil
    @ObservationIgnored private var operationId: String? = nil
    @ObservationIgnored private var pageId: String
    @ObservationIgnored private var started = false

    init(lessonId: String) {
        self.lessonId = lessonId
        let core = WonderCore.shared
        let lesson = core.lesson(lessonId)
        pageId = core.get("constants")["pageId"].string ?? "ios"
        var vs: JSON? = nil
        if !lesson["dil"].isNull, core.get("hasViewState", ["viewState": lesson["viewState"]]).bool == true {
            vs = core.get("pruneViewState", ["viewState": lesson["viewState"], "dil": lesson["dil"]])
        }
        surface = DilSurface(viewState: vs, viewportWidth: 360)
        tutor = TutorController(lessonId: lessonId)
        title = lesson["title"].string ?? lesson["topic"].string ?? "Lesson"
        markdown = lesson["markdown"].string ?? ""
        status = lesson["status"].string ?? "new"
        finished = lesson["finished"].bool == true
        dil = lesson["dil"]
        widgetAppData = lesson["appData"]
        quality = lesson["quality"]
        surface.onAction = { [weak self] a in self?.handleAction(a) }
        surface.onViewState = { [weak self] vs in
            guard let self else { return }
            self.core.saveLesson(self.lessonId, ["viewState": vs ?? .null])
        }
        tutor.lesson = self
    }

    var lesson: JSON { core.lesson(lessonId) }
    var pageCount: Int { core.get("pageCount", ["markdown": .string(markdown)]).int ?? 0 }
    var pageTitles: [String] { core.get("pageTitles", ["markdown": .string(markdown)]).array.compactMap(\.string) }
    var isComplete: Bool { status == "complete" && !streaming }

    // MARK: lifecycle

    func start() {
        guard !started else { return }
        started = true
        let phase = core.get("lessonPhase", ["id": .string(lessonId)]).string ?? "new"
        if !dil.isNull && phase != "new" { renderStored() }
        switch phase {
        case "complete":
            steerMode = .revise
        case "interrupted", "streaming":
            if status != "interrupted" { core.saveLesson(lessonId, ["status": "interrupted", "streamOwner": .null]); status = "interrupted" }
            showInterrupted(lesson["interruptedReason"].string)
        default:
            runStream(nil)
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        tutor.stop()
    }

    func teardown() {
        stop()
        surface.destroy()
        tutor.destroy()
        core.flush()
    }

    private func appDataFor() -> JSON {
        core.mergeComponentResults(dil["appData"], widgetAppData["opGenui"]["componentResults"])
    }

    private func renderStored() {
        let l = lesson
        dil = l["dil"]
        widgetAppData = l["appData"]
        if let code = dil["code"].string { surface.render(code: code, constants: dil["constants"], appData: appDataFor()) }
        markdown = l["markdown"].string ?? markdown
        if let t = Self.titleFrom(markdown) { title = t }
    }

    private func showInterrupted(_ note: String?) {
        reasoning = nil
        steerMode = .resume
        interruptedNote = note ?? "The lesson stopped before it was finished. Resume to continue from the last complete paragraph."
    }

    static func titleFrom(_ md: String) -> String? {
        for line in md.split(separator: "\n", omittingEmptySubsequences: true) {
            if line.hasPrefix("# ") { return String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces) }
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { return nil }
        }
        return nil
    }

    // MARK: streaming

    /// Resume (no instruction), steer after the stream ended, or revise from page N.
    func continueLesson(instruction: String = "", fromPage: Int = 0, fallback: Bool = false) {
        if streaming || busy { queued = (instruction, fromPage, fallback); return }
        guard !(lesson["markdown"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { runStream(nil); return }
        let req = core.get("continueRequest", ["id": .string(lessonId), "instruction": .string(instruction), "fromPage": .number(Double(fromPage)), "fallback": .bool(fallback), "dilAppData": dil["appData"]])
        runStream(req)
    }

    func retry() {
        error = nil
        surface.clear()
        runStream(nil)
    }

    private func runStream(_ continueFrom: JSON?) {
        busy = true
        task = Task { [weak self] in
            guard let self else { return }
            await self.streamLesson(continueFrom)
            self.busy = false
            if let q = self.queued, !Task.isCancelled {
                self.queued = nil
                self.continueLesson(instruction: q.instruction, fromPage: q.fromPage, fallback: q.fallback)
            }
        }
    }

    private func streamLesson(_ continueFrom: JSON?) async {
        streaming = true
        error = nil
        interruptedNote = nil
        operationId = nil
        let l = lesson
        let prevPhase = continueFrom == nil ? "new" : (core.get("lessonPhase", ["id": .string(lessonId)]).string ?? "new")
        let prev: (dilAppData: JSON, widgetAppData: JSON)? = continueFrom == nil ? nil : (dil["appData"], widgetAppData)
        var carried: JSON? = nil
        var began = continueFrom == nil
        var messageId: JSON = continueFrom == nil ? .null : l["messageId"]
        var latest: (markdown: String, dil: JSON) = (continueFrom == nil ? "" : (l["markdown"].string ?? ""), continueFrom == nil ? .null : dil)
        var lastSave = Date.distantPast
        var failureCode: String? = nil
        let persist = { [self] (status: String) in
            core.saveLesson(lessonId, [
                "status": .string(status), "streamOwner": status == "streaming" ? .string(pageId) : .null, "markdown": .string(latest.markdown),
                "dil": latest.dil, "appData": widgetAppData, "messageId": messageId, "interruptedReason": .null,
            ])
            self.status = status
        }
        if continueFrom == nil { dil = .null; persist("streaming") }
        let instruction = continueFrom?["instruction"].string ?? ""
        reasoning = continueFrom == nil ? "Planning the lesson…" : (instruction.isEmpty ? "Resuming the lesson…" : "Steering…")
        steerMode = .live
        steerStatus = nil

        var body = core.get("lessonRequest", ["id": .string(lessonId)]).object
        if let continueFrom { body["continueFrom"] = continueFrom }
        do {
            let r = try await API.streamTurn("/api/lesson/stream", .object(body)) { [self] event in
                switch event {
                case .control(let d):
                    if d["kind"].string == "quality-report" { quality = d["report"]; return }
                    onControl(d)
                case .reasoning(let s):
                    reasoning = s["active"].bool == false ? nil : (s["text"].string ?? "Thinking…")
                case .content(let msg, let rec):
                    if let mid = rec["messageId"].string { messageId = .string(mid) }
                    if !began && (rec["revision"].int ?? 0) > 1 { began = true } // rev 1 is the empty start, rev 2 the kept pages
                    guard began else { return }
                    if !rec["dil"].isNull {
                        if let prev, carried == nil {
                            let c = core.get("carryOver", ["dilAppData": prev.dilAppData, "widgetAppData": prev.widgetAppData, "keptDil": rec["dil"]])
                            carried = c["carried"]
                            widgetAppData = c["widgetAppData"]
                        }
                        var next = rec["dil"].object
                        if let carried { next["appData"] = core.get("mergeContinuedAppData", ["carried": carried, "appData": rec["dil"]["appData"]]) }
                        dil = .object(next)
                        surface.render(code: dil["code"].string ?? "", constants: dil["constants"], appData: appDataFor(),
                                       animated: rec["status"].string != "complete" && rec["mode"].string != "replace")
                    }
                    latest = (msg["markdown"].string ?? "", dil)
                    markdown = latest.markdown
                    if let t = Self.titleFrom(markdown) { title = t }
                    if Date().timeIntervalSince(lastSave) > 1 { lastSave = Date(); persist("streaming") }
                }
            }
            if !r.failure.isNull {
                failureCode = r.failure["code"].string ?? "failed"
                throw API.APIError(message: r.failure["message"].string ?? "Generation failed")
            }
            let m = r.message
            var final: JSON = .null
            if !m["dil"].isNull {
                let appData = carried.map { core.get("mergeContinuedAppData", ["carried": $0, "appData": m["dil"]["appData"]]) } ?? m["dil"]["appData"]
                final = ["code": m["dil"]["code"], "constants": m["dil"]["constants"], "appData": appData, "requiredComponents": m["dil"]["requiredComponents"]]
            }
            dil = final
            latest = (m["markdown"].string ?? "", final)
            markdown = latest.markdown
            streaming = false
            reasoning = nil
            let newTitle = Self.titleFrom(markdown) ?? (l["title"].string ?? title)
            title = newTitle
            core.saveLesson(lessonId, [
                "status": "complete", "streamOwner": .null, "markdown": .string(markdown), "dil": final, "appData": widgetAppData, "messageId": messageId,
                "title": .string(newTitle), "truncated": .bool(r.final["debug"]["truncated"].bool == true), "interruptedReason": .null, "quality": quality,
            ])
            status = "complete"
            core.flush()
            if !final.isNull { surface.pruneViewState(keep: core.get("resolutionIdsOf", ["dil": final]).array.compactMap(\.string)) }
            if r.final["debug"]["truncated"].bool == true { app.show("The lesson was cut short (length limit).") }
            if let qs = core.get("quality", ["report": quality]).object["tone"]?.string, qs == "fixed", let head = core.get("quality", ["report": quality])["headline"].string { app.show(head, seconds: 4) }
            steerMode = .revise
            steerBusy = false
            steerStatus = nil
        } catch {
            streaming = false
            reasoning = nil
            steerBusy = false
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                if began { persist("interrupted"); core.flush() }
                return
            }
            let message = error.localizedDescription
            if !began {
                // the continuation never started: what is saved is unchanged
                app.show(message.isEmpty ? "Could not continue the lesson" : message)
                if prevPhase == "complete" { steerMode = .revise; status = "complete" } else { showInterrupted(nil) }
                steerStatus = message
                return
            }
            let next = core.get("statusAfterStop", ["markdown": .string(latest.markdown), "failureCode": failureCode.map { .string($0) } ?? .null]).string
            if next == "interrupted" {
                let note = failureCode != nil ? message : "The connection dropped. Resume to continue from the last complete paragraph."
                persist("interrupted")
                if failureCode != nil { core.saveLesson(lessonId, ["interruptedReason": .string(note)]) }
                core.flush()
                showInterrupted(note)
                return
            }
            core.saveLesson(lessonId, ["status": "failed", "streamOwner": .null])
            status = "failed"
            steerMode = .hidden
            self.error = message.isEmpty ? "Something went wrong." : message
        }
    }

    // MARK: steering (steer-bar.js)

    private func onControl(_ d: JSON) {
        if operationId == nil, let op = d["operationId"].string { operationId = op }
        if d["kind"].string == "steering-status" {
            switch d["status"].string {
            case "accepted": steerStatus = "Rewriting the rest with your instruction…"
            case "applied", "completed": steerStatus = nil; steerBusy = false
            case "rejected": steerStatus = d["message"].string ?? "Could not steer right now"; steerBusy = false
            default: break
            }
        }
    }

    func steer(_ instruction: String) {
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        switch steerMode {
        case .revise:
            steerBusy = true
            steerStatus = currentPage > 1 ? "Rewriting from page \(currentPage)…" : "Rewriting the lesson…"
            continueLesson(instruction: text, fromPage: max(1, currentPage))
        case .resume:
            steerBusy = true
            steerStatus = "Resuming…"
            continueLesson(instruction: text)
        case .live:
            guard let op = operationId else { app.show("The lesson has not started yet"); return }
            steerBusy = true
            steerStatus = "Steering…"
            Task {
                do {
                    _ = try await API.post("/api/lesson/steer", ["operationId": .string(op), "instruction": .string(text)])
                } catch let e as API.APIError where e.status == 409 && e.body["reason"].string == "not_streaming" {
                    steerStatus = "Applying after the last page…"
                    continueLesson(instruction: text, fallback: true)
                } catch {
                    steerStatus = error.localizedDescription
                    steerBusy = false
                }
            }
        case .hidden:
            break
        }
    }

    func resume() {
        steerBusy = true
        steerStatus = "Resuming…"
        continueLesson()
    }

    // MARK: widget actions

    func handleAction(_ a: JSON) {
        if a["handler"].string == "server" {
            Task {
                do {
                    let res = try await API.widgetAction(a)
                    if !res["componentResults"].isNull {
                        widgetAppData = core.mergeComponentResults(widgetAppData, res["componentResults"])
                        core.saveLesson(lessonId, ["appData": widgetAppData])
                        surface.setAppData(appDataFor())
                    }
                    if let m = res["issueTurn"]["message"].string { tutor.open = true; tutor.send(m) }
                } catch {
                    NSLog("widget action failed: %@", error.localizedDescription)
                }
            }
            return
        }
        let p = a["payload"]
        switch a["type"].string {
        case "issue_new_turn":
            if let q = p["query"].string { tutor.open = true; tutor.send(q) }
        case "open_url":
            if let u = p["url"].string { app.openExternal(u) }
        default:
            let r = core.get("clientAction", ["scope": "lesson", "lessonId": .string(lessonId), "action": a])
            app.show(r["toast"].string)
        }
    }

    /// The lesson menu's "Reset interactive widgets".
    func resetWidgets() {
        let graded = core.get("quizResolutionIds", ["appData": widgetAppData]).array.compactMap(\.string)
        widgetAppData = .null
        if !dil.isNull { surface.setAppData(appDataFor()) } // grades first, then remount
        surface.resetViewState()
        core.saveLesson(lessonId, ["viewState": .null, "appData": .null])
        for rid in Set(graded + tutor.resetWidgets()) {
            Task { _ = try? await API.post("/api/widget_action", ["componentName": "Quiz", "action_type": "quiz_restart", "resolutionId": .string(rid), "payload": ["attempt": 0]]) }
        }
        app.show("Interactive widgets reset")
    }

    func savePage(_ n: Int) {
        currentPage = n
        guard isComplete, n != (lesson["readPage"].int ?? 0) else { return }
        core.saveLesson(lessonId, ["readPage": .number(Double(n))])
    }

    // MARK: finishing (finishLesson / showPack)

    func collectCards() async {
        guard isComplete, !collecting else { return }
        collecting = true
        defer { collecting = false }
        do {
            let data = try await API.post("/api/practice/extract", ["lessonMarkdown": .string(markdown)])
            pack = PackData(cards: data["cards"].array, items: data["items"].array)
            let mem = core.get("markMemoryExtracted", ["lessonId": .string(lessonId)])
            if !mem.isNull {
                Task {
                    if let r = try? await API.post("/api/memory/extract", mem), let fact = r["added"][0]["fact"].string {
                        try? await Task.sleep(for: .seconds(1.4))
                        app.show("Wonder will remember: \(fact)", seconds: 4.2)
                    }
                }
            }
        } catch {
            app.show(error.localizedDescription.isEmpty ? "Could not create practice cards" : error.localizedDescription)
        }
    }

    func fileCards(_ items: [JSON]) -> JSON {
        let r = core.get("fileCards", ["lessonId": .string(lessonId), "items": .array(items)])
        finished = true
        if let g = r["gained"].int, g > 0 { app.show("+\(g) XP · lesson finished") } else {
            let added = r["added"].int ?? 0
            app.show(added > 0 ? "\(added) new cards filed" : "These cards are already in your deck")
        }
        return r
    }
}
