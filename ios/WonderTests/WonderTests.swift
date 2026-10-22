import XCTest
@testable import Wonder

/// Runs on the Simulator: the shared engine in real JavaScriptCore, the native tree, and the
/// pure Swift pieces of the renderer. Fixtures are the web app's recorded Claude output
/// (ios/engine/fixtures.mjs). Core tests only use stateless calls, so they leave the
/// Simulator's lessons alone.
@MainActor
final class WonderTests: XCTestCase {
    private func fixture(_ name: String, _ ext: String) throws -> String {
        let url = try XCTUnwrap(Bundle(for: WonderTests.self).url(forResource: name, withExtension: ext), "missing fixture \(name).\(ext)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func waitUntil(_ timeout: TimeInterval = 8, _ cond: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !cond() && Date() < end { try? await Task.sleep(for: .milliseconds(20)) }
    }

    private func find(_ n: DilNode, _ pred: (DilNode) -> Bool) -> DilNode? {
        if pred(n) { return n }
        for c in n.children { if let f = find(c, pred) { return f } }
        return nil
    }

    // MARK: engine

    func testSurfaceRendersARealClaudeLesson() async throws {
        let dil = try XCTUnwrap(JSON.parse(try fixture("vaccines.dil", "json")))
        let surface = DilSurface(viewportWidth: 390)
        surface.render(code: dil["code"].string ?? "", constants: dil["constants"], appData: dil["appData"])
        await waitUntil { surface.tree.nodeCount > 150 }
        XCTAssertNil(surface.lastError)
        XCTAssertGreaterThan(surface.tree.nodeCount, 150)
        let title = try XCTUnwrap(surface.tree.root.children.first)
        XCTAssertEqual(title.type, "title")
        XCTAssertFalse(title.plainText.isEmpty)
        XCTAssertGreaterThan(DilSurfaceView.pageNumbers(surface.tree.root.children).count, 2, "the lesson has pages")

        // a KeyTerm tap goes into the sandbox and comes back as a re-render
        let key = try XCTUnwrap(find(surface.tree.root) { $0["__component"].string == "KeyTerm" })
        let fn = try XCTUnwrap(key["onClick"].fnId)
        XCTAssertFalse(key["ariaPressed"].truthy)
        surface.invoke(fnId: fn)
        await waitUntil { key["ariaPressed"].truthy }
        XCTAssertTrue(key["ariaPressed"].truthy)
        surface.destroy()
    }

    func testProgramsCannotReachTheBridge() async throws {
        let surface = DilSurface(viewportWidth: 390)
        surface.render(code: #"DIL.render(__dil.jsx("text", null, [typeof __native, typeof fetch, typeof self, typeof postMessage].join(",")));"#, constants: [:], appData: [:])
        await waitUntil { !surface.tree.root.children.isEmpty }
        XCTAssertEqual(surface.tree.root.plainText, "undefined,undefined,undefined,undefined")
        surface.destroy()
    }

    func testWidgetStateComesBackAsSnapshots() async throws {
        let dil = try XCTUnwrap(JSON.parse(try fixture("vaccines.dil", "json")))
        let surface = DilSurface(viewportWidth: 390)
        var snapshots: [JSON] = []
        surface.onViewState = { if let s = $0 { snapshots.append(s) } }
        surface.render(code: dil["code"].string ?? "", constants: dil["constants"], appData: dil["appData"])
        await waitUntil { surface.tree.nodeCount > 150 }
        let next = try XCTUnwrap(find(surface.tree.root) { $0.type == "button" && $0.plainText.contains("Next") }, "a stepper or quiz button")
        surface.invoke(fnId: try XCTUnwrap(next["onClick"].fnId))
        await waitUntil { !snapshots.isEmpty }
        XCTAssertFalse(snapshots.last?["c"].object.isEmpty ?? true)
        surface.destroy()
    }

    // MARK: core

    func testCoreParsesARecordedTeacherTurn() throws {
        let core = WonderCore.shared
        let raw = try fixture("teacher-statistics", "ndjson")
        let id = try core.call("openStream")
        var contents = 0
        var reasoning = 0
        let chars = Array(raw)
        var i = 0
        while i < chars.count {
            let chunk = String(chars[i..<min(chars.count, i + 1500)])
            for e in try core.call("pushStream", ["id": id, "text": .string(chunk)]).array {
                if e["type"].string == "content" { contents += 1 }
                if e["type"].string == "reasoning" { reasoning += 1 }
            }
            i += 1500
        }
        let done = try core.call("finishStream", ["id": id])
        XCTAssertTrue(done["failure"].isNull)
        XCTAssertGreaterThan(contents, 0)
        XCTAssertGreaterThan(reasoning, 0, "tool status lines")
        let results = done["message"]["dil"]["appData"]["opGenui"]["componentResults"].object
        XCTAssertFalse(results.isEmpty, "Teacher tool cards are server-resolved components")
        XCTAssertTrue(results.values.contains { $0["state"]["kind"].string == "plan" })
    }

    func testCoreGradesPracticeItems() throws {
        let core = WonderCore.shared
        let mcq: JSON = ["type": "mcq", "prompt": "2+2?", "choices": [["id": "a", "text": "3", "isCorrect": false], ["id": "b", "text": "4", "isCorrect": true]], "explanation": ""]
        XCTAssertEqual(try core.call("grade", ["item": mcq, "answer": "b"])["correct"].bool, true)
        XCTAssertEqual(try core.call("grade", ["item": mcq, "answer": "a"])["rating"].int, 1)
        let cloze: JSON = ["type": "cloze", "prompt": "The ____ is the starting amount", "answer": "principal", "acceptableAnswers": []]
        let typo = try core.call("grade", ["item": cloze, "answer": "principl"])
        XCTAssertEqual(typo["correct"].bool, true)
        XCTAssertEqual(typo["typo"].bool, true)
        XCTAssertEqual(try core.call("pageCount", ["markdown": "# T\n\nhook\n\n## One\n\na\n\n## Two\n\nb"]).int, 2)
        XCTAssertFalse(core.get("icons")["arrow-right"].array.isEmpty)
    }

    // MARK: native pieces

    func testTreeAppliesRenderOps() {
        let tree = DilTree()
        tree.apply([
            ["op": "createElement", "id": 1, "type": "col"],
            ["op": "createText", "id": 2, "text": "hello"],
            ["op": "move", "id": 2, "parent": 1, "index": 0],
            ["op": "move", "id": 1, "parent": 0, "index": 0],
            ["op": "propChanged", "id": 1, "name": "gap", "value": 3],
            ["op": "textChanged", "id": 2, "text": "hello world"],
        ])
        XCTAssertEqual(tree.root.children.first?.type, "col")
        XCTAssertEqual(tree.root.children.first?["gap"].int, 3)
        XCTAssertEqual(tree.root.plainText, "hello world")
        tree.apply([["op": "propChanged", "id": 1, "name": "gap"], ["op": "destroy", "id": 2]])
        XCTAssertTrue(tree.root.children.first?["gap"].isNull ?? false, "a missing value removes the prop")
        XCTAssertEqual(tree.nodeCount, 1)
    }

    func testTeXBecomesReadableText() {
        XCTAssertEqual(TeX.unicode(#"x^2 + y_1"#), "x² + y₁")
        XCTAssertEqual(TeX.unicode(#"\frac{a}{b}"#), "a⁄b")
        XCTAssertEqual(TeX.unicode(#"P(A \mid B) = \frac{P(B \mid A) P(A)}{P(B)}"#), "P(A | B) = (P(B | A) P(A))⁄P(B)")
        XCTAssertEqual(TeX.unicode(#"\alpha \leq \sqrt{2}"#), "α ≤ √2")
    }

    func testSVGPathsParse() {
        let p = SVGPath.parse("M0 0L10 0l0 10h-10z")
        XCTAssertEqual(p.boundingRect.width, 10, accuracy: 0.01)
        XCTAssertEqual(p.boundingRect.height, 10, accuracy: 0.01)
        let arc = SVGPath.parse("M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18")
        XCTAssertEqual(arc.boundingRect.width, 18, accuracy: 0.5)
        XCTAssertFalse(Icons.path("arrow-right").isEmpty)
    }

    func testThemeResolvesHostTokens() {
        XCTAssertNotNil(DilTheme.color("surface-tertiary", .bg))
        XCTAssertNotNil(DilTheme.color("#10a37f"))
        XCTAssertNotNil(DilTheme.color("rgba(0, 0, 0, 0.5)"))
        XCTAssertEqual(DilTheme.space(4), 16)
        XCTAssertEqual(DilTheme.radius("full"), 9999)
        XCTAssertEqual(DilTheme.percent("36.5%") ?? 0, 0.365, accuracy: 0.0001)
        let flex = FlexSpec("1 1 auto", type: "row")
        XCTAssertEqual(flex.grow, 1)
        XCTAssertFalse(flex.basisZero)
        XCTAssertTrue(FlexSpec(.number(1), type: "pressable").basisZero)
    }
}
