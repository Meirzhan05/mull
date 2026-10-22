import SwiftUI

/// Review (#/review): an FSRS session over due cards (or one lesson's weakest cards), graded by
/// the shared practice-core and scheduled by the shared deck/FSRS in the core context.
struct ReviewView: View {
    let lessonId: String?
    @Environment(AppModel.self) private var app
    @State private var queue: [JSON] = []
    @State private var index = 0
    @State private var answered = 0
    @State private var correct = 0
    @State private var xp = 0
    @State private var results: [(prompt: String, correct: Bool, next: String)] = []
    @State private var loaded = false
    @State private var feedback: Feedback? = nil
    @State private var picked: String? = nil
    @State private var clozeText = ""
    @State private var explainText = ""
    @State private var grading = false
    @State private var revealed = false

    struct Feedback { var correct: Bool; var title: String; var expected: String; var explanation: String; var next: String; var criteria: [JSON] = []; var sample: String = "" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !loaded { ProgressView().frame(maxWidth: .infinity).padding(.top, 60) }
                else if queue.isEmpty { empty }
                else if index >= queue.count { done }
                else { header; card(queue[index]) }
            }
            .padding(16)
            .frame(maxWidth: 680)
            .frame(maxWidth: .infinity)
        }
        .background(DilTheme.bg)
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(lessonId == nil ? "Review" : "Refresh")
        .onAppear { if !loaded { load() } }
    }

    private func load() {
        var args: [String: JSON] = ["limit": 20]
        if let lessonId { args["lessonId"] = .string(lessonId) }
        queue = app.core.get("reviewQueue", .object(args)).array
        index = 0; answered = 0; correct = 0; xp = 0; results = []
        resetCard()
        loaded = true
    }

    private func resetCard() { feedback = nil; picked = nil; clozeText = ""; explainText = ""; revealed = false; grading = false }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("\(min(index + 1, queue.count)) / \(queue.count)").font(.system(size: 13, weight: .medium).monospacedDigit()).foregroundStyle(DilTheme.ink2)
                Spacer()
                if answered > 0 { Text("\(Int((Double(correct) / Double(answered) * 100).rounded()))% correct · +\(xp) XP").font(.system(size: 13).monospacedDigit()).foregroundStyle(DilTheme.ink3) }
            }
            ProgressView(value: Double(index), total: Double(max(queue.count, 1))).tint(DilTheme.accent)
        }
    }

    private static let typeLabel = ["mcq": "Multiple choice", "cloze": "Fill in the blank", "binary_choice": "True or false", "flashcard": "Flashcard", "explain": "Explain it"]

    private func md(_ s: String, size: CGFloat = 19, weight: Font.Weight = .semibold) -> Text {
        Text(InlineText.markdown(s, base: .init(size: size, weight: weight)))
    }

    @ViewBuilder
    private func card(_ entry: JSON) -> some View {
        let item = entry["item"]
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Tag(text: Self.typeLabel[item["type"].string ?? ""] ?? "Practice", tone: .brand)
                if let t = entry["lessonTitle"].string, !t.isEmpty { Text(t).font(.system(size: 12)).foregroundStyle(DilTheme.ink3).lineLimit(1) }
            }
            switch item["type"].string {
            case "mcq": mcq(entry, item)
            case "binary_choice": trueFalse(entry, item)
            case "cloze": cloze(entry, item)
            case "explain": explain(entry, item)
            default: flashcard(entry, item)
            }
            if let f = feedback { feedbackView(f) }
        }
        .card(padding: 20)
        .id(entry["id"].string ?? "")
    }

    private func choiceButton(_ label: String, letter: String?, state: ChoiceState, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if let letter {
                    Text(letter).font(.system(size: 13, weight: .semibold)).frame(width: 26, height: 26).background(Circle().fill(DilTheme.surface3))
                }
                md(label, size: 16, weight: .regular).multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                if state == .correct { Image(systemName: "checkmark.circle.fill").foregroundStyle(DilTheme.success) }
                if state == .wrong { Image(systemName: "xmark.circle.fill").foregroundStyle(DilTheme.danger) }
            }
            .foregroundStyle(DilTheme.ink)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 10).fill(state == .correct ? DilTheme.successSubtle : state == .wrong ? DilTheme.dangerSubtle : DilTheme.surface))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(state == .correct ? DilTheme.success : state == .wrong ? DilTheme.danger : DilTheme.controlBorder))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressFeedbackStyle())
        .disabled(feedback != nil)
    }

    enum ChoiceState { case idle, correct, wrong }

    private func mcq(_ entry: JSON, _ item: JSON) -> some View {
        let seed = (entry["id"].string?.count ?? 0) + index
        let choices = Self.shuffle(item["choices"].array, seed: seed)
        return VStack(alignment: .leading, spacing: 10) {
            md(item["prompt"].string ?? "")
            ForEach(Array(choices.enumerated()), id: \.offset) { i, c in
                let id = c["id"].string ?? ""
                let state: ChoiceState = feedback == nil ? .idle : c["isCorrect"].bool == true ? .correct : picked == id ? .wrong : .idle
                choiceButton(c["text"].string ?? "", letter: String("ABCDE".map { $0 }[min(i, 4)]), state: state) {
                    picked = id
                    answer(entry, item, answer: .string(id))
                }
            }
        }
    }

    private func trueFalse(_ entry: JSON, _ item: JSON) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Is this statement true or false?").font(.system(size: 13)).foregroundStyle(DilTheme.ink3)
            md(item["prompt"].string ?? "")
            HStack(spacing: 10) {
                ForEach([("True", true), ("False", false)], id: \.0) { label, val in
                    let state: ChoiceState = feedback == nil ? .idle : picked == label ? (feedback?.correct == true ? .correct : .wrong) : .idle
                    choiceButton(label, letter: nil, state: state) { picked = label; answer(entry, item, answer: .bool(val)) }
                }
            }
        }
    }

    private func cloze(_ entry: JSON, _ item: JSON) -> some View {
        let parts = (item["prompt"].string ?? "").components(separatedBy: "____")
        return VStack(alignment: .leading, spacing: 12) {
            md((parts.first ?? "") + " _____ " + (parts.count > 1 ? parts[1...].joined(separator: " ") : ""))
            HStack(spacing: 8) {
                TextField("Missing word", text: $clozeText)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { if !clozeText.trimmingCharacters(in: .whitespaces).isEmpty { answer(entry, item, answer: .string(clozeText)) } }
                    .padding(.horizontal, 12).frame(height: 42)
                    .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface2))
                    .disabled(feedback != nil)
                Button("Check") { answer(entry, item, answer: .string(clozeText)) }
                    .buttonStyle(.primary)
                    .disabled(feedback != nil || clozeText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func explain(_ entry: JSON, _ item: JSON) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Explain it in your own words.").font(.system(size: 13)).foregroundStyle(DilTheme.ink3)
            md(item["prompt"].string ?? "")
            TextField("A few sentences is plenty.", text: $explainText, axis: .vertical)
                .lineLimit(4...10)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface2))
                .disabled(feedback != nil || grading)
            HStack {
                if grading { ReasoningLine(text: "Grading your answer…") }
                Spacer()
                Button("Check my answer") { Task { await gradeExplain(entry, item) } }
                    .buttonStyle(.primary)
                    .disabled(feedback != nil || grading || explainText.trimmingCharacters(in: .whitespacesAndNewlines).count < 12)
            }
        }
    }

    private func flashcard(_ entry: JSON, _ item: JSON) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            md(item["front"].string ?? "")
            if !revealed {
                Button("Show answer") { withAnimation(.spring) { revealed = true } }.buttonStyle(.wonder(.primary, large: true, full: true))
            } else {
                md(item["back"].string ?? "", size: 16, weight: .regular).foregroundStyle(DilTheme.ink2)
                    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface2))
                Text("How well did you remember it?").font(.system(size: 13)).foregroundStyle(DilTheme.ink3)
                HStack(spacing: 8) {
                    ForEach([("Again", "again", 1), ("Hard", "hard", 2), ("Good", "good", 3), ("Easy", "easy", 4)], id: \.1) { label, key, r in
                        Button {
                            let g = app.core.get("grade", ["item": item, "answer": .string(key)])
                            _ = record(entry, rating: g["rating"].int ?? r, correct: g["correct"].bool == true)
                            next()
                        } label: {
                            VStack(spacing: 2) {
                                Text(label).font(.system(size: 14, weight: .semibold))
                                Text(entry["previews"][String(r)].string ?? "").font(.system(size: 11)).foregroundStyle(DilTheme.ink3)
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                            .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.surface))
                            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(DilTheme.controlBorder))
                        }
                        .buttonStyle(PressFeedbackStyle())
                        .foregroundStyle(DilTheme.ink)
                    }
                }
            }
        }
    }

    private func feedbackView(_ f: Feedback) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: f.correct ? "checkmark.circle.fill" : "xmark.circle.fill").foregroundStyle(f.correct ? DilTheme.success : DilTheme.danger)
                Text(f.title).font(.system(size: 15, weight: .semibold))
            }
            if !f.correct && !f.expected.isEmpty { (Text("Answer: ").bold() + md(f.expected, size: 14, weight: .regular)).font(.system(size: 14)) }
            if !f.explanation.isEmpty { md(f.explanation, size: 14, weight: .regular).foregroundStyle(DilTheme.ink2) }
            ForEach(Array(f.criteria.enumerated()), id: \.offset) { _, c in
                Label(c["criterion"].string ?? "", systemImage: c["met"].bool == true ? "checkmark" : "xmark").font(.system(size: 13)).foregroundStyle(c["met"].bool == true ? DilTheme.success : DilTheme.ink3)
            }
            if !f.sample.isEmpty { DisclosureGroup("Show a model answer") { md(f.sample, size: 14, weight: .regular) }.font(.system(size: 13)) }
            HStack {
                Text("Next review \(f.next)").font(.system(size: 12)).foregroundStyle(DilTheme.ink3)
                Spacer()
                Button("Continue") { next() }.buttonStyle(.primary)
            }
            .padding(.top, 4)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(f.correct ? DilTheme.successSubtle : DilTheme.dangerSubtle))
    }

    private func answer(_ entry: JSON, _ item: JSON, answer: JSON) {
        guard feedback == nil else { return }
        let g = app.core.get("grade", ["item": item, "answer": answer])
        let ok = g["correct"].bool == true
        let next = record(entry, rating: g["rating"].int ?? 1, correct: ok)
        withAnimation(.spring(duration: 0.3)) {
            feedback = Feedback(correct: ok, title: ok ? (g["typo"].bool == true ? "Correct (check the spelling)" : "Correct") : "Not quite", expected: g["expected"].string ?? "", explanation: item["explanation"].string ?? "", next: next)
        }
    }

    private static let gradeWords = ["Not yet", "Partly", "Good", "Excellent"]

    private func gradeExplain(_ entry: JSON, _ item: JSON) async {
        grading = true
        defer { grading = false }
        do {
            let r = try await API.post("/api/widget_action", ["componentName": "Review", "action_type": "practice_grade", "payload": ["item": item, "answer": .string(explainText)]])
            let grade = r["result"]["grade"]
            let g = app.core.get("grade", ["item": item, "answer": grade])
            let ok = g["correct"].bool == true
            let next = record(entry, rating: g["rating"].int ?? 1, correct: ok)
            let score = max(0, min(3, grade["score"].int ?? 0))
            feedback = Feedback(correct: ok, title: "\(Self.gradeWords[score]) · \(score)/3", expected: "", explanation: grade["feedback"].string ?? "", next: next, criteria: grade["criteria"].array, sample: item["sampleAnswer"].string ?? "")
        } catch {
            app.show(error.localizedDescription.isEmpty ? "Could not grade that. Try again." : error.localizedDescription)
        }
    }

    /// review.js record(): schedule with FSRS, award XP, and log mastery evidence.
    private func record(_ entry: JSON, rating: Int, correct ok: Bool) -> String {
        let r = app.core.get("reviewRecord", ["entryId": entry["id"], "rating": .number(Double(rating)), "correct": .bool(ok)])
        answered += 1
        if ok { correct += 1 }
        xp += r["gained"].int ?? 0
        let item = entry["item"]
        results.append(((item["prompt"].string ?? item["front"].string ?? ""), ok, r["nextLabel"].string ?? ""))
        return r["nextLabel"].string ?? ""
    }

    private func next() {
        withAnimation(.easeInOut(duration: 0.2)) {
            index += 1
            resetCard()
        }
    }

    private var empty: some View {
        let stats = app.core.get("deckStats")
        return VStack(spacing: 12) {
            Image(systemName: "checkmark.seal").font(.system(size: 40)).foregroundStyle(DilTheme.success)
            Text(stats["total"].int ?? 0 > 0 ? "Nothing is due" : "Your deck is empty").font(.system(size: 20, weight: .semibold))
            Text(stats["total"].int ?? 0 > 0 ? "Cards come back just before you would forget them." : "Finish a lesson and collect its cards to start reviewing.")
                .font(.system(size: 14)).foregroundStyle(DilTheme.ink2).multilineTextAlignment(.center)
            Button("Check again") { load() }.buttonStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    private var done: some View {
        let stats = app.core.get("deckStats")
        let streak = app.core.get("today")["streak"].int ?? 0
        return VStack(alignment: .leading, spacing: 16) {
            Kicker(text: "Review")
            Text(answered > 0 ? "Session complete" : "Session ended").font(.system(size: 24, weight: .semibold))
            HStack(spacing: 0) {
                stat("\(answered)", "reviewed"); stat("\(answered > 0 ? Int((Double(correct) / Double(answered) * 100).rounded()) : 0)%", "correct"); stat("+\(xp)", "XP"); stat("\(streak)", "day streak")
            }
            .card(padding: 12)
            ForEach(Array(results.prefix(6).enumerated()), id: \.offset) { _, r in
                HStack(spacing: 8) {
                    Circle().fill(r.correct ? DilTheme.success : DilTheme.danger).frame(width: 8, height: 8)
                    md(r.prompt, size: 14, weight: .regular).lineLimit(2)
                    Spacer()
                    Text(r.next).font(.system(size: 12)).foregroundStyle(DilTheme.ink3)
                }
            }
            HStack {
                if (stats["due"].int ?? 0) > 0 && lessonId == nil { Button("Keep going") { load() }.buttonStyle(.secondary) }
                Spacer()
                Button("Done") { if lessonId != nil { app.paths[app.tab]?.removeLast() } else { app.tab = .today } }.buttonStyle(.primary)
            }
        }
    }

    private func stat(_ v: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(v).font(.system(size: 20, weight: .semibold).monospacedDigit())
            Text(label).font(.system(size: 11)).foregroundStyle(DilTheme.ink3)
        }
        .frame(maxWidth: .infinity)
    }

    static func shuffle(_ a: [JSON], seed: Int) -> [JSON] {
        var out = a
        var x = UInt64(max(1, seed)) &* 2654435761
        for i in stride(from: out.count - 1, to: 0, by: -1) {
            x = x &* 6364136223846793005 &+ 1442695040888963407
            let j = Int((x >> 33) % UInt64(i + 1))
            out.swapAt(i, j)
        }
        return out
    }
}
