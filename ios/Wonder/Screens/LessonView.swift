import SwiftUI

struct PageOffsetKey: PreferenceKey {
    static let defaultValue: [Int: CGFloat] = [:]
    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) { value.merge(nextValue(), uniquingKeysWith: { $1 }) }
}

/// The lesson reader: the model-written lesson rendered natively from its DIL program, with
/// page progress, live Steer / Resume / Revise, the tutor, and collecting the cards at the end.
struct LessonView: View {
    let lessonId: String
    @Environment(AppModel.self) private var app
    @State private var controller: LessonController?

    var body: some View {
        Group {
            if let controller { LessonReader(c: controller) } else { Color.clear }
        }
        .onAppear {
            if controller == nil {
                if app.core.lesson(lessonId).isNull { return }
                controller = LessonController(lessonId: lessonId)
            }
            controller?.start()
        }
        .onDisappear { controller?.teardown(); controller = nil }
        .overlay { if app.core.lesson(lessonId).isNull && controller == nil { ContentUnavailableView("Not found", systemImage: "questionmark.folder", description: Text("This lesson is no longer stored on this device.")) } }
    }
}

private struct LessonReader: View {
    @Bindable var c: LessonController
    @Environment(AppModel.self) private var app
    @State private var steerText = ""
    @State private var steerOpen = false
    @State private var jump: Int? = nil
    @State private var fontScale: CGFloat = 1
    @FocusState private var steerFocused: Bool

    private static let scales: [(CGFloat, String)] = [(0.9, "Small"), (1, "Default"), (1.12, "Large"), (1.25, "Larger")]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statusRow
                    VStack(alignment: .leading, spacing: 0) {
                        if !c.surface.hasContent && c.error == nil { SkeletonLines() }
                        DilSurfaceView(surface: c.surface, kind: .lesson, scale: fontScale)
                    }
                    .padding(.horizontal, 20).padding(.vertical, 24)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(DilTheme.surface))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(DilTheme.line))
                    if let e = c.error { errorCard(e) }
                    if c.steerMode == .revise { steerBar.id("revise") }
                    endPanel
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .coordinateSpace(name: "lessonScroll")
            .onPreferenceChange(PageOffsetKey.self) { offsets in
                let line: CGFloat = 260
                let n = offsets.filter { $0.value < line }.map(\.key).max() ?? 0
                if n != c.currentPage { c.savePage(n) }
            }
            .onChange(of: jump) { _, n in
                guard let n else { return }
                withAnimation { proxy.scrollTo(n == 0 ? "top" : "page-\(n)", anchor: .top) }
                jump = nil
            }
        }
        .background(DilTheme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(c.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .safeAreaInset(edge: .top, spacing: 0) { progress }
        .toolbar(.hidden, for: .tabBar)
        .sheet(isPresented: Binding(get: { c.tutor.open }, set: { c.tutor.open = $0 })) { TutorView(tutor: c.tutor, lessonTitle: c.title).presentationDetents([.medium, .large]) }
        .sheet(item: $c.pack) { pack in PackSheet(c: c, pack: pack) }
        .onAppear { fontScale = CGFloat(app.core.get("settings")["fontScale"].double ?? 1) }
    }

    // MARK: chrome

    private var progress: some View {
        let total = max(c.pageCount, 1)
        return VStack(spacing: 6) {
            HStack(spacing: 3) {
                ForEach(1...total, id: \.self) { n in
                    Capsule()
                        .fill(segmentColor(n, total: total))
                        .frame(height: 4)
                        .onTapGesture { jump = n }
                }
            }
            Text(pageLabel).font(.system(size: 11).monospacedDigit()).foregroundStyle(DilTheme.ink3).frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(pageLabel)
    }

    private func segmentColor(_ n: Int, total: Int) -> Color {
        if c.streaming { return n < total ? DilTheme.accent : DilTheme.brandMuted }
        if c.finished || n < c.currentPage || (c.currentPage == total && n == total) { return DilTheme.accent }
        return n == c.currentPage ? DilTheme.brandMuted : DilTheme.surface3
    }

    private var pageLabel: String {
        let total = c.pageCount
        if c.streaming { return total > 0 ? "Writing page \(total)…" : "Writing…" }
        if !c.isComplete { return total > 0 ? "\(total) page\(total == 1 ? "" : "s") so far" : "" }
        if c.currentPage > 0 { return "Page \(c.currentPage) of \(total)" }
        return total > 0 ? "\(total) pages · \(c.minutes) min read" : ""
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Menu {
                Button { jump = 0 } label: { Label("Introduction", systemImage: "book") }
                ForEach(Array(c.pageTitles.enumerated()), id: \.offset) { i, t in
                    Button { jump = i + 1 } label: { Text("\(i + 1). \(t)") }
                }
            } label: { Image(systemName: "list.bullet") }
            .accessibilityLabel("Lesson contents")

            Button { c.tutor.open = true } label: { Image(systemName: "bubble.left.and.text.bubble.right") }
                .accessibilityLabel("Tutor")

            Menu {
                Picker("Text size", selection: Binding(get: { fontScale }, set: { v in fontScale = v; app.core.setSetting("fontScale", .number(Double(v))) })) {
                    ForEach(Self.scales, id: \.0) { Text($0.1).tag($0.0) }
                }
                Button { c.resetWidgets() } label: { Label("Reset interactive widgets", systemImage: "arrow.counterclockwise") }
                Button { app.askTeacher("I just studied “\(c.title)”. What should I learn next?") } label: { Label("Ask the Teacher about this", systemImage: "graduationcap") }
            } label: { Image(systemName: "ellipsis.circle") }
            .accessibilityLabel("More lesson options")
        }
    }

    // MARK: status + steer

    @ViewBuilder
    private var statusRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let r = c.reasoning { ReasoningLine(text: r) }
            if c.steerMode == .live || c.steerMode == .resume { steerBar }
        }
        .id("top")
    }

    private var steerBar: some View {
        let chips = app.constants["STEER_CHIPS"].array
        let title: String = {
            switch c.steerMode {
            case .live: return "Steer this lesson"
            case .resume: return "This lesson was interrupted"
            case .revise: return c.currentPage > 1 ? "Revise from page \(c.currentPage)" : "Revise this lesson"
            case .hidden: return ""
            }
        }()
        let collapsed = c.steerMode == .live && !steerOpen
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: c.steerMode == .resume ? "pause.circle" : "wand.and.stars").foregroundStyle(DilTheme.accent)
                Text(title).font(.system(size: 14, weight: .semibold))
                Spacer()
                if c.steerMode == .resume {
                    Button { c.resume() } label: { Label("Resume", systemImage: "play.fill") }.buttonStyle(.primary).disabled(c.steerBusy)
                } else if c.steerMode == .live {
                    Button(steerOpen ? "Close" : "Steer") { withAnimation { steerOpen.toggle() } }.buttonStyle(.secondary)
                } else if !steerOpen {
                    Button("Revise") { withAnimation { steerOpen = true } }.buttonStyle(.secondary)
                } else {
                    Button("Close") { withAnimation { steerOpen = false } }.buttonStyle(.secondary)
                }
            }
            if let note = c.interruptedNote, c.steerMode == .resume { Text(note).font(.system(size: 13)).foregroundStyle(DilTheme.ink2) }
            if let s = c.steerStatus { ReasoningLine(text: s) }
            if !collapsed && (c.steerMode != .revise || steerOpen) {
                ChipFlow(items: chips.compactMap { $0["label"].string }) { label in
                    Chip(text: label) {
                        if let ins = chips.first(where: { $0["label"].string == label })?["instruction"].string { c.steer(ins); steerOpen = false }
                    }
                    .disabled(c.steerBusy)
                }
                HStack(spacing: 8) {
                    TextField(c.steerMode == .resume ? "Or say how to continue…" : "Simpler, more examples, focus on…", text: $steerText)
                        .focused($steerFocused)
                        .submitLabel(.send)
                        .onSubmit { send() }
                        .padding(.horizontal, 12).frame(height: 38)
                        .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface2))
                    Button { send() } label: { Image(systemName: "arrow.up") }.buttonStyle(.primary).disabled(steerText.trimmingCharacters(in: .whitespaces).isEmpty || c.steerBusy)
                }
            }
        }
        .card(padding: 14)
    }

    private func send() {
        let t = steerText
        steerText = ""
        steerFocused = false
        steerOpen = false
        c.steer(t)
    }

    private func errorCard(_ e: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("The lesson could not be generated").font(.system(size: 17, weight: .semibold))
            Text(e).font(.system(size: 14)).foregroundStyle(DilTheme.ink2)
            Button { c.retry() } label: { Label("Try again", systemImage: "arrow.clockwise") }.buttonStyle(.primary)
        }
        .card()
    }

    // MARK: end of lesson

    @ViewBuilder
    private var endPanel: some View {
        if c.streaming || !c.isComplete {
            Text(c.streaming ? "The lesson is being written. You can start reading right away." : "The end of the lesson appears here once it is complete.")
                .font(.system(size: 13)).foregroundStyle(DilTheme.ink3)
                .frame(maxWidth: .infinity)
                .card(padding: 18, dashed: true)
        } else if !c.finished {
            VStack(spacing: 10) {
                Kicker(text: "End of the lesson")
                Text("File what you have learned").font(.system(size: 20, weight: .semibold))
                Text("The key ideas become index cards in your review deck. Each returns just before you would forget it.")
                    .font(.system(size: 14)).foregroundStyle(DilTheme.ink2).multilineTextAlignment(.center)
                HStack(spacing: 8) {
                    if c.pageCount > 0 { Tag(text: "\(c.pageCount) pages") }
                    if let q = c.lesson["quizScore"]["total"].int, q > 0 { Tag(text: "Quiz \(c.lesson["quizScore"]["score"].int ?? 0)/\(q)", tone: .brand) }
                    Tag(text: "+50 XP")
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { collectButton(full: false); tutorFirstButton(full: false) }
                    VStack(spacing: 8) { collectButton(full: true); tutorFirstButton(full: true) }
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity)
            .card(padding: 24)
        } else {
            VStack(spacing: 10) {
                Kicker(text: "Finished")
                Text("This lesson is filed").font(.system(size: 20, weight: .semibold))
                Text("Its cards are in your review deck. Come back to the text any time, or continue.").font(.system(size: 14)).foregroundStyle(DilTheme.ink2).multilineTextAlignment(.center)
                nextSteps
            }
            .frame(maxWidth: .infinity)
            .card(padding: 24)
            .background(RoundedRectangle(cornerRadius: 16).fill(LinearGradient(colors: [DilTheme.successSubtle, DilTheme.surface], startPoint: .top, endPoint: .center)))
        }
    }

    private func collectButton(full: Bool) -> some View {
        Button { Task { await c.collectCards() } } label: {
            HStack { if c.collecting { ProgressView().controlSize(.small).tint(DilTheme.brandInk) }; Text(c.collecting ? "Collecting your cards…" : "Collect the cards") }
        }
        .buttonStyle(.wonder(.primary, large: true, full: full))
        .disabled(c.collecting)
    }

    private func tutorFirstButton(full: Bool) -> some View {
        Button("Ask the tutor first") { c.tutor.open = true }.buttonStyle(.wonder(.secondary, large: true, full: full))
    }

    private var nextSteps: some View {
        let l = c.lesson
        let next = l["courseId"].string.map { app.core.get("nextInCourse", ["courseId": .string($0), "lessonId": .string(c.lessonId)]) } ?? .null
        let due = app.core.get("deckStats")["due"].int ?? 0
        return VStack(spacing: 8) {
            if !next.isNull, let cid = l["courseId"].string {
                Button { app.openCourseLesson(cid, si: next["si"].int ?? 0, li: next["li"].int ?? 0) } label: { Label("Next: \(next["title"].string ?? "")", systemImage: "arrow.right") }
                    .buttonStyle(.wonder(.primary, large: true, full: true))
            }
            if due > 0 { Button("Review \(due) card\(due == 1 ? "" : "s")") { app.tab = .review }.buttonStyle(.wonder(next.isNull ? .primary : .secondary, large: true, full: true)) }
            Button("Back to Today") { app.paths[app.tab] = []; app.tab = .today }.buttonStyle(.wonder(.secondary, large: true, full: true))
        }
        .padding(.top, 4)
    }
}

/// The pack opening: turn each new index card over, then file them in the deck.
struct PackSheet: View {
    let c: LessonController
    let pack: LessonController.PackData
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var app
    @State private var flipped: Set<Int> = []
    @State private var filed: JSON? = nil

    var body: some View {
        NavigationStack {
            ScrollView {
                if let r = filed { done(r) } else { cards }
            }
            .background(DilTheme.bg)
            .navigationTitle(c.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Close") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                if filed == nil {
                    HStack(spacing: 8) {
                        Button("Turn all") { withAnimation(.spring) { flipped = Set(pack.cards.indices) } }.buttonStyle(.wonder(.secondary, large: true))
                        Button("File \(pack.items.count) card\(pack.items.count == 1 ? "" : "s") in my deck") { filed = c.fileCards(pack.items) }.buttonStyle(.wonder(.primary, large: true, full: true))
                    }
                    .padding(12)
                    .background(.bar)
                }
            }
        }
    }

    private var cards: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(pack.cards.count) idea\(pack.cards.count == 1 ? "" : "s") worth keeping").font(.system(size: 22, weight: .semibold))
            Text(flipped.count == pack.cards.count ? "All turned. File them to review them later." : "Turn each card over to read it.").font(.system(size: 14)).foregroundStyle(DilTheme.ink2)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 12)], spacing: 12) {
                ForEach(Array(pack.cards.enumerated()), id: \.offset) { i, card in
                    let on = flipped.contains(i)
                    Button { withAnimation(.spring(duration: 0.45)) { _ = flipped.insert(i) } } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("No. \(String(format: "%02d", i + 1))").font(.system(size: 11, weight: .medium).monospacedDigit()).foregroundStyle(DilTheme.ink3)
                            if on {
                                Text(card["term"].string ?? "").font(.system(size: 16, weight: .semibold))
                                Text(InlineText.markdown(card["definition"].string ?? "", base: .init(size: 14))).foregroundStyle(DilTheme.ink2)
                                if let ex = card["example"].string, !ex.isEmpty { Text(ex).font(.system(size: 13)).italic().foregroundStyle(DilTheme.ink3) }
                            } else {
                                Spacer(minLength: 0)
                                Text(c.title).font(.system(size: 15, weight: .semibold)).lineLimit(3)
                                Text("Turn over").font(.system(size: 12)).foregroundStyle(DilTheme.accent)
                            }
                        }
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 14).fill(on ? DilTheme.surface : DilTheme.brandSubtle))
                        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(DilTheme.line))
                    }
                    .buttonStyle(PressFeedbackStyle())
                    .foregroundStyle(DilTheme.ink)
                }
            }
        }
        .padding(16)
    }

    private func done(_ r: JSON) -> some View {
        let added = r["added"].int ?? 0
        let day = r["daily"]
        return VStack(alignment: .leading, spacing: 16) {
            Kicker(text: "Filed")
            Text("\(added) card\(added == 1 ? "" : "s") added to your deck").font(.system(size: 22, weight: .semibold))
            HStack(spacing: 24) {
                VStack(alignment: .leading) { Kicker(text: "Earned"); Text("+\(r["gained"].int ?? 0) XP").font(.system(size: 22, weight: .semibold).monospacedDigit()) }
                VStack(alignment: .leading) { Kicker(text: "Today"); Text("\(day["xp"].int ?? 0) / \(day["goal"].int ?? 30) XP").font(.system(size: 22, weight: .semibold).monospacedDigit()) }
            }
            .card()
            Kicker(text: "What next")
            VStack(spacing: 8) {
                if let n = r["next"].object["title"]?.string, let cid = c.lesson["courseId"].string {
                    Button("Next: \(n)") { dismiss(); app.openCourseLesson(cid, si: r["next"]["si"].int ?? 0, li: r["next"]["li"].int ?? 0) }.buttonStyle(.wonder(.primary, large: true, full: true))
                }
                if let due = r["due"].int, due > 0 { Button("Review \(due) card\(due == 1 ? "" : "s") now") { dismiss(); app.tab = .review }.buttonStyle(.wonder(.secondary, large: true, full: true)) }
                Button("Back to Today") { dismiss(); app.paths[app.tab] = []; app.tab = .today }.buttonStyle(.wonder(.secondary, large: true, full: true))
                Button("Stay with this lesson") { dismiss() }.buttonStyle(.wonder(.ghost, large: true, full: true))
            }
        }
        .padding(16)
    }
}
