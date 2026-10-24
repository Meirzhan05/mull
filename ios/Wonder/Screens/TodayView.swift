import SwiftUI

/// Today (#/ on the web): greeting, the lesson / course / Teacher command bar, Up next,
/// suggestions, today's goal, the saved study plan and recent lessons.
struct TodayView: View {
    @Environment(AppModel.self) private var app
    @State private var topic = ""
    @State private var level = "beginner"
    @State private var mode = Mode.lesson
    @FocusState private var focused: Bool
    @State private var t: JSON = .null

    enum Mode: String, CaseIterable { case lesson = "Lesson", course = "Course", teacher = "Teacher" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ServerBanner()
                header(t)
                composer(t)
                upNext(t["upNext"].array)
                goal(t)
                if let plan = t["plans"].array.first { planCard(plan) }
                recent(t["recent"].array)
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(DilTheme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle("Today")
        .toolbar(.hidden, for: .navigationBar)
        .refreshable { await app.loadStatus() }
        .task(id: app.core.revision) { t = app.core.get("today") } // not in body: typing re-renders this view
    }

    // MARK: sections

    private func header(_ t: JSON) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Date.now.formatted(.dateTime.weekday(.wide).month().day())).font(.system(size: 13)).foregroundStyle(DilTheme.ink3)
                Text([t["greeting"].string ?? "Hello", t["name"].string].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: ", "))
                    .font(.system(size: 28, weight: .semibold)).tracking(-0.6)
            }
            Spacer()
            HStack(spacing: 6) {
                Image(systemName: "flame.fill").foregroundStyle(t["streak"].int ?? 0 > 0 ? DilTheme.flame : DilTheme.ink3)
                Text("\(t["streak"].int ?? 0)").font(.system(size: 15, weight: .semibold).monospacedDigit())
            }
            .padding(.horizontal, 10).frame(height: 32)
            .background(Capsule().fill(DilTheme.surface))
            .overlay(Capsule().strokeBorder(DilTheme.line))
            .accessibilityLabel("\(t["streak"].int ?? 0) day streak")
        }
        .padding(.top, 8)
    }

    private func composer(_ t: JSON) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Mode", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)

            TextField(mode == .teacher ? "Ask the Teacher to plan, quiz or explain…" : "What do you want to learn?", text: $topic, axis: .vertical)
                .font(.system(size: 17))
                .lineLimit(1...4)
                .focused($focused)
                .submitLabel(.go)
                .onSubmit(submit)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface2))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(focused ? DilTheme.accent : DilTheme.line))

            HStack {
                if mode != .teacher {
                    Menu {
                        Picker("Level", selection: $level) {
                            Text("Beginner").tag("beginner")
                            Text("Intermediate").tag("intermediate")
                            Text("Advanced").tag("advanced")
                        }
                    } label: {
                        HStack(spacing: 4) { Text(level.capitalized); Image(systemName: "chevron.up.chevron.down").font(.system(size: 10)) }
                            .font(.system(size: 13, weight: .medium)).foregroundStyle(DilTheme.ink2)
                    }
                }
                Spacer()
                Button(action: submit) {
                    HStack(spacing: 6) {
                        if app.planningCourse && mode == .course { ProgressView().controlSize(.small) }
                        Text(mode == .lesson ? "Start lesson" : mode == .course ? "Plan a course" : "Ask")
                        Image(systemName: "arrow.right")
                    }
                }
                .buttonStyle(.primary)
                .disabled(topic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || app.planningCourse)
            }

            if mode != .teacher {
                ChipFlow(items: t["suggestions"].array.compactMap(\.string)) { s in
                    Chip(text: s, icon: "sparkles") { topic = s; submit() }
                }
            }
        }
        .card()
    }

    private func submit() {
        let text = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        focused = false
        switch mode {
        case .lesson: topic = ""; app.startLesson(text, level: level)
        case .course: Task { if await app.planCourse(text, level: level) { topic = "" } }
        case .teacher: topic = ""; app.askTeacher(text)
        }
    }

    @ViewBuilder
    private func upNext(_ items: [JSON]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Kicker(text: "Up next")
            VStack(spacing: 0) {
                ForEach(Array(items.prefix(4).enumerated()), id: \.offset) { i, item in
                    if i > 0 { Divider().overlay(DilTheme.line) }
                    upNextRow(item)
                }
            }
            .card(padding: 4)
        }
    }

    private func upNextRow(_ item: JSON) -> some View {
        let (icon, kicker, title, action): (String, String, String, () -> Void) = {
            switch item["kind"].string {
            case "continue":
                let id = item["lessonId"].string ?? ""
                return ("book", item["interrupted"].bool == true ? "Resume" : "Continue reading", item["title"].string ?? "", { app.open(.lesson(id)) })
            case "review":
                let n = item["due"].int ?? 0
                return ("rectangle.stack", "Review", "\(n) card\(n == 1 ? "" : "s") due", { app.tab = .review })
            case "strengthen":
                let names = item["concepts"].array.compactMap(\.string).prefix(2).joined(separator: ", ")
                return ("scope", "Strengthen", names.isEmpty ? "Shaky ideas" : names, { app.askTeacher("Quiz me on \(names) — I keep getting these wrong.") })
            case "refresh":
                let id = item["lessonId"].string ?? ""
                return ("arrow.clockwise", "Refresh", item["title"].string ?? "", { app.open(.reviewLesson(id), in: .today) })
            case "plan":
                let pid = item["planId"].string ?? "", di = item["dayIndex"].int ?? 0, ii = item["itemIndex"].int ?? 0
                return ("calendar", "Plan · day \(item["day"].int ?? di + 1)", item["title"].string ?? "", { app.openPlanItem(planId: pid, di: di, ii: ii) })
            case "course":
                let cid = item["courseId"].string ?? "", si = item["si"].int ?? 0, li = item["li"].int ?? 0
                return ("map", "Next in \(item["courseTitle"].string ?? "your course")", item["title"].string ?? "", { app.openCourseLesson(cid, si: si, li: li) })
            default:
                return ("sparkles", item["first"].bool == true ? "Start here" : "Something new", "Pick a topic above and Claude writes the lesson", { focused = true })
            }
        }()
        return Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon == "book" ? "book" : icon).font(.system(size: 15)).foregroundStyle(DilTheme.accent)
                    .frame(width: 34, height: 34).background(RoundedRectangle(cornerRadius: 8).fill(DilTheme.brandSubtle))
                VStack(alignment: .leading, spacing: 2) {
                    Text(kicker).font(.system(size: 12)).foregroundStyle(DilTheme.ink3)
                    Text(title).font(.system(size: 15, weight: .medium)).foregroundStyle(DilTheme.ink).lineLimit(2).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(DilTheme.ink3)
            }
            .padding(12)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressFeedbackStyle())
    }

    private func goal(_ t: JSON) -> some View {
        let d = t["daily"]
        let pct = min(1, d["pct"].double ?? 0)
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Kicker(text: "Today’s goal")
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(d["xp"].int ?? 0)").font(.system(size: 26, weight: .semibold).monospacedDigit())
                        Text("/ \(d["goal"].int ?? 30) XP").font(.system(size: 14)).foregroundStyle(DilTheme.ink3)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Kicker(text: "Deck")
                    Text("\(t["deck"]["due"].int ?? 0) due · \(t["deck"]["total"].int ?? 0) cards").font(.system(size: 14).monospacedDigit()).foregroundStyle(DilTheme.ink2)
                }
            }
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(DilTheme.surface3)
                    Capsule().fill(d["met"].bool == true ? DilTheme.success : DilTheme.accent).frame(width: max(6, g.size.width * pct))
                }
            }
            .frame(height: 8)
            HStack(spacing: 0) {
                ForEach(Array(t["week"].array.enumerated()), id: \.offset) { _, day in
                    VStack(spacing: 4) {
                        Circle()
                            .fill(day["met"].bool == true ? DilTheme.success : day["active"].bool == true ? DilTheme.brandMuted : DilTheme.surface3)
                            .frame(width: 22, height: 22)
                            .overlay { if day["today"].bool == true { Circle().strokeBorder(DilTheme.accent, lineWidth: 1.5) } }
                        Text(day["label"].string ?? "").font(.system(size: 11)).foregroundStyle(DilTheme.ink3)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .card()
    }

    private func planCard(_ plan: JSON) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Kicker(text: "Your study plan")
            Text(plan["goal"].string ?? "Study plan").font(.system(size: 17, weight: .semibold))
            ForEach(Array(plan["days"].array.prefix(7).enumerated()), id: \.offset) { di, day in
                VStack(alignment: .leading, spacing: 6) {
                    Text("Day \(day["day"].int ?? di + 1)\(day["focus"].string.map { " · \($0)" } ?? "")").font(.system(size: 13, weight: .medium)).foregroundStyle(DilTheme.ink2)
                    ChipFlow(items: Array(day["items"].array.enumerated().map { $0.offset })) { ii in
                        let it = day["items"][ii]
                        Chip(text: it["title"].string ?? "", icon: it["opened"].bool == true ? "checkmark" : (it["kind"].string == "review" ? "rectangle.stack" : it["kind"].string == "quiz" ? "questionmark.circle" : "book")) {
                            app.openPlanItem(planId: plan["id"].string ?? "", di: di, ii: ii)
                        }
                    }
                }
            }
        }
        .card()
    }

    @ViewBuilder
    private func recent(_ lessons: [JSON]) -> some View {
        if !lessons.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Kicker(text: "Recent lessons")
                VStack(spacing: 0) {
                    ForEach(Array(lessons.enumerated()), id: \.offset) { i, l in
                        if i > 0 { Divider().overlay(DilTheme.line) }
                        LessonRow(lesson: l) { app.open(.lesson(l["id"].string ?? "")) }
                    }
                }
                .card(padding: 4)
            }
        }
    }
}

struct LessonRow: View {
    let lesson: JSON
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(lesson["title"].string ?? "Lesson").font(.system(size: 15, weight: .medium)).foregroundStyle(DilTheme.ink).lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        Text(statusLabel).foregroundStyle(statusColor)
                        if let p = lesson["pages"].int, p > 0 { Text("· \(p) page\(p == 1 ? "" : "s")") }
                        if let q = lesson["quizScore"]["total"].int, q > 0 { Text("· quiz \(lesson["quizScore"]["score"].int ?? 0)/\(q)") }
                    }
                    .font(.system(size: 12)).foregroundStyle(DilTheme.ink3)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(DilTheme.ink3)
            }
            .padding(12)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressFeedbackStyle())
    }

    private var statusLabel: String {
        if lesson["finished"].bool == true { return "Finished" }
        switch lesson["phase"].string {
        case "complete": return "Ready to read"
        case "interrupted": return "Interrupted"
        case "streaming": return "Writing…"
        default: return lesson["status"].string == "failed" ? "Failed" : "Not started"
        }
    }

    private var statusColor: Color {
        if lesson["finished"].bool == true { return DilTheme.success }
        return lesson["phase"].string == "interrupted" || lesson["status"].string == "failed" ? DilTheme.warning : DilTheme.ink3
    }
}
