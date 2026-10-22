import SwiftUI

/// Library (#/library): every lesson and course on this device, with search and filters.
struct LibraryView: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""
    @State private var filter = Filter.all

    enum Filter: String, CaseIterable { case all = "All", progress = "In progress", finished = "Finished", courses = "Courses" }

    var body: some View {
        let _ = app.core.revision
        let lessons = app.core.get("lessons").array.filter(matches)
        let courses = app.core.get("courses").array.filter { query.isEmpty || ($0["title"].string ?? "").localizedCaseInsensitiveContains(query) }
        List {
            Section {
                Picker("Filter", selection: $filter) { ForEach(Filter.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            if filter == .all || filter == .courses, !courses.isEmpty {
                Section("Courses") {
                    ForEach(Array(courses.enumerated()), id: \.offset) { _, c in
                        NavigationLink(value: Route.course(c["id"].string ?? "")) { courseRow(c) }
                            .swipeActions { Button("Delete", role: .destructive) { _ = app.core.get("deleteCourse", ["id": c["id"]]) } }
                    }
                }
            }
            if filter != .courses {
                Section(lessons.isEmpty ? "" : "Lessons") {
                    if lessons.isEmpty {
                        Text(query.isEmpty ? "Lessons you start appear here." : "No lessons match “\(query)”.").foregroundStyle(DilTheme.ink3)
                    }
                    ForEach(Array(lessons.enumerated()), id: \.offset) { _, l in
                        NavigationLink(value: Route.lesson(l["id"].string ?? "")) { lessonRow(l) }
                            .swipeActions { Button("Delete", role: .destructive) { _ = app.core.get("deleteLesson", ["id": l["id"]]) } }
                    }
                }
            }
        }
        .searchable(text: $query, prompt: "Search lessons and courses")
        .navigationTitle("Library")
    }

    private func matches(_ l: JSON) -> Bool {
        if !query.isEmpty && !((l["title"].string ?? "") + " " + (l["topic"].string ?? "")).localizedCaseInsensitiveContains(query) { return false }
        switch filter {
        case .all: return true
        case .progress: return l["finished"].bool != true
        case .finished: return l["finished"].bool == true
        case .courses: return false
        }
    }

    private func lessonRow(_ l: JSON) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(l["title"].string ?? "Lesson").font(.system(size: 16, weight: .medium))
            HStack(spacing: 6) {
                Text(l["finished"].bool == true ? "Finished" : l["phase"].string == "complete" ? "Ready" : l["phase"].string == "interrupted" ? "Interrupted" : l["status"].string == "failed" ? "Failed" : "Not started")
                if let p = l["pages"].int, p > 0 { Text("· \(p) pages") }
                if let d = Date.iso(l["updatedAt"].string) { Text("· \(d.formatted(.relative(presentation: .named)))") }
            }
            .font(.system(size: 12)).foregroundStyle(DilTheme.ink3)
        }
        .padding(.vertical, 2)
    }

    private func courseRow(_ c: JSON) -> some View {
        let done = c["progress"]["done"].int ?? 0, total = c["progress"]["total"].int ?? 0
        return HStack(spacing: 12) {
            ZStack {
                Circle().stroke(DilTheme.surface3, lineWidth: 4)
                Circle().trim(from: 0, to: total > 0 ? CGFloat(done) / CGFloat(total) : 0).stroke(DilTheme.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round)).rotationEffect(.degrees(-90))
            }
            .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 3) {
                Text(c["title"].string ?? "Course").font(.system(size: 16, weight: .medium))
                Text("\(done) of \(total) lessons · \(c["level"].string ?? "beginner")").font(.system(size: 12)).foregroundStyle(DilTheme.ink3)
            }
        }
        .padding(.vertical, 2)
    }
}

/// A course path (#/course/<id>).
struct CourseView: View {
    let courseId: String
    @Environment(AppModel.self) private var app

    var body: some View {
        let _ = app.core.revision
        if let course = app.core.get("courses").array.first(where: { $0["id"].string == courseId }) {
            content(course)
        } else {
            ContentUnavailableView("Not found", systemImage: "map", description: Text("This course is no longer stored on this device."))
        }
    }

    private func content(_ course: JSON) -> some View {
        let done = course["progress"]["done"].int ?? 0, total = course["progress"]["total"].int ?? 0
        let first = firstOpen(course)
        let sections = course["sections"].array
        let offsets = sections.indices.map { i in sections[..<i].map { $0["lessons"].array.count }.reduce(0, +) }
        return ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Kicker(text: "A course in \(total) lessons · \(course["level"].string ?? "beginner")")
                    Text(course["title"].string ?? "").font(.system(size: 26, weight: .semibold)).tracking(-0.6)
                    if let d = course["description"].string { Text(d).font(.system(size: 15)).foregroundStyle(DilTheme.ink2) }
                    HStack {
                        Text("\(done) of \(total) lessons").font(.system(size: 13).monospacedDigit()).foregroundStyle(DilTheme.ink3)
                        Spacer()
                    }
                    ProgressView(value: total > 0 ? Double(done) / Double(total) : 0).tint(DilTheme.accent)
                    if let f = first {
                        Button { app.openCourseLesson(courseId, si: f.si, li: f.li) } label: { Label(done > 0 ? "Continue: \(f.title)" : "Start the course", systemImage: "play.fill") }
                            .buttonStyle(.wonder(.primary, large: true))
                    } else {
                        Text("Every lesson in this course is finished.").font(.system(size: 14)).foregroundStyle(DilTheme.success)
                    }
                }
                .card()
                ForEach(Array(sections.enumerated()), id: \.offset) { si, s in
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Part \(app.core.get("roman", ["n": .number(Double(si + 1))]).string ?? "\(si + 1)") · \(s["title"].string ?? "")").font(.system(size: 13, weight: .semibold)).foregroundStyle(DilTheme.ink2)
                        ForEach(Array(s["lessons"].array.enumerated()), id: \.offset) { li, l in
                            pathNode(l, number: offsets[si] + li + 1, current: first?.si == si && first?.li == li) { app.openCourseLesson(courseId, si: si, li: li) }
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(DilTheme.bg)
        .navigationTitle(course["title"].string ?? "Course")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func firstOpen(_ course: JSON) -> (si: Int, li: Int, title: String)? {
        for (si, s) in course["sections"].array.enumerated() {
            for (li, l) in s["lessons"].array.enumerated() where l["lesson"]["finished"].bool != true { return (si, li, l["title"].string ?? "") }
        }
        return nil
    }

    private func pathNode(_ l: JSON, number: Int, current: Bool, open: @escaping () -> Void) -> some View {
        let lesson = l["lesson"]
        let done = lesson["finished"].bool == true
        let label = done ? "Revisit" : lesson["phase"].string == "complete" ? "Continue" : lesson["phase"].string == "interrupted" ? "Resume" : "Start"
        return HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle().fill(done ? DilTheme.success : current ? DilTheme.accent : DilTheme.surface3)
                if done { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white) }
                else { Text("\(number)").font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(current ? .white : DilTheme.ink2) }
            }
            .frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 4) {
                Text(l["title"].string ?? "").font(.system(size: 15, weight: .medium))
                if let s = l["summary"].string { Text(s).font(.system(size: 13)).foregroundStyle(DilTheme.ink2) }
                if let q = lesson["quizScore"]["total"].int, q > 0 { Text("Quiz \(lesson["quizScore"]["score"].int ?? 0)/\(q)").font(.system(size: 12)).foregroundStyle(DilTheme.ink3) }
            }
            Spacer(minLength: 8)
            Button(label, action: open).buttonStyle(.wonder(current ? .primary : .secondary))
        }
        .card(padding: 12)
    }
}
