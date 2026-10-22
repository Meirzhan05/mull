import SwiftUI

// The native DIL host: SwiftUI views for the primitives the sandbox renders
// (chatgpt-dil host.js does the same for the DOM). Props map through DilTheme's tokens; layout
// containers use FlexLayout; text runs use InlineText.

// MARK: environment

@MainActor
final class DilActions {
    weak var surface: DilSurface?
    init(surface: DilSurface?) { self.surface = surface }
    func invoke(_ fn: Int, _ args: [JSON] = []) { surface?.invoke(fnId: fn, args: args) }
    func open(_ url: URL) { surface?.onAction?(["handler": "client", "type": "open_url", "payload": ["url": .string(url.absoluteString)]]) }
}

private struct DilActionsKey: EnvironmentKey { static let defaultValue: DilActions? = nil }
private struct DilBaseKey: EnvironmentKey { static let defaultValue: CGFloat = 16 }
private struct DilLineKey: EnvironmentKey { static let defaultValue: CGFloat = 1.5 }
private struct DilStretchKey: EnvironmentKey { static let defaultValue = true }
private struct DilParentRowKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    var dilActions: DilActions? { get { self[DilActionsKey.self] } set { self[DilActionsKey.self] = newValue } }
    /// Base font size of the surface (1rem); the lesson scales it with the reader's text size.
    var dilBase: CGFloat { get { self[DilBaseKey.self] } set { self[DilBaseKey.self] = newValue } }
    /// CSS line-height of body text (lesson 1.75, messages 1.5).
    var dilLine: CGFloat { get { self[DilLineKey.self] } set { self[DilLineKey.self] = newValue } }
    /// The parent column stretches its children across (CSS align-items: stretch).
    var dilStretch: Bool { get { self[DilStretchKey.self] } set { self[DilStretchKey.self] = newValue } }
    var dilParentRow: Bool { get { self[DilParentRowKey.self] } set { self[DilParentRowKey.self] = newValue } }
}

// MARK: surface root

/// A whole DIL surface: a lesson, a tutor reply or a Teacher reply.
struct DilSurfaceView: View {
    enum Kind { case lesson, message }
    let surface: DilSurface
    var kind: Kind = .message
    var scale: CGFloat = 1
    var onPageAnchor: ((Int) -> String)? = nil

    var body: some View {
        let actions = DilActions(surface: surface)
        let base: CGFloat = (kind == .lesson ? 17 : 15) * scale
        let kids = surface.tree.root.children
        let pageNumbers = Self.pageNumbers(kids)
        FlexLayout(row: false, gap: kind == .lesson ? 16 : 12, align: .stretch, fillsWidth: true) {
            ForEach(Array(kids.enumerated()), id: \.element.id) { i, c in
                rootChild(c, index: i, kids: kids, page: pageNumbers[c.id], base: base)
            }
        }
        .environment(\.dilActions, actions)
        .environment(\.dilBase, base)
        .environment(\.dilLine, kind == .lesson ? 1.7 : 1.5)
        .environment(\.dilStretch, true)
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "dil-fn", let id = Int(url.host ?? "") { actions.invoke(id); return .handled }
            actions.open(url)
            return .handled
        })
        .font(.system(size: base))
        .foregroundStyle(DilTheme.ink)
        .tint(DilTheme.accent)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { w in surface.setViewport(width: w) }
    }

    /// Lesson pages: each top-level `## ` heading (a `title size="lg"`) starts page n.
    static func pageNumbers(_ kids: [DilNode]) -> [Int: Int] {
        var out: [Int: Int] = [:]
        var n = 0
        for c in kids where c.type == "title" && c["size"].string == "lg" { n += 1; out[c.id] = n }
        return out
    }

    @ViewBuilder
    private func rootChild(_ c: DilNode, index: Int, kids: [DilNode], page: Int?, base: CGFloat) -> some View {
        if kind == .lesson, c.type == "title", let size = c["size"].string, ["xl", "2xl", "3xl"].contains(size) {
            DilTextView(node: c, override: InlineText.Style(size: base * 1.85, weight: .semibold, tracking: -0.8), line: 1.15)
                .padding(.bottom, 4)
        } else if kind == .lesson, let page {
            VStack(alignment: .leading, spacing: 12) {
                Rectangle().fill(DilTheme.line).frame(height: 1).padding(.bottom, 20)
                Text("Page \(page)")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(DilTheme.accent)
                    .padding(.horizontal, 8).frame(height: 22)
                    .background(Capsule().fill(DilTheme.brandSubtle))
                DilTextView(node: c, override: InlineText.Style(size: base * 1.35, weight: .semibold, tracking: -0.5), line: 1.25)
            }
            .padding(.top, 16)
            .background(GeometryReader { g in Color.clear.preference(key: PageOffsetKey.self, value: [page: g.frame(in: .named("lessonScroll")).minY]) })
            .id("page-\(page)")
        } else if kind == .lesson, c.type == "text", index > 0, kids[index - 1].type == "title", ["xl", "2xl", "3xl"].contains(kids[index - 1]["size"].string ?? "") {
            DilTextView(node: c, override: InlineText.Style(size: base * 1.125, color: DilTheme.ink2), line: 1.6)
                .padding(.bottom, 8)
        } else if c["__component"].string != nil {
            DilNodeView(node: c).padding(.vertical, 8)
        } else {
            DilNodeView(node: c)
        }
    }
}

// MARK: node dispatch

struct DilNodeView: View {
    let node: DilNode

    var body: some View {
        switch node.type {
        case "#text":
            Text(node.text)
        case "markdown", "text-only-markdown":
            DilMarkdownView(node: node)
        case "math":
            if node["display"].truthy { DilMathBlock(node: node) } else { DilTextView(node: node) }
        case "button":
            DilButtonView(node: node)
        case "icon", "loading-indicator":
            DilIcon(node: node)
        case "svg":
            DilSVGView(node: node)
        case "divider":
            DilDivider(node: node)
        case "spacer":
            DilSpacer(node: node)
        case "list":
            DilListView(node: node)
        case "image", "search-image":
            DilImagePlaceholder(node: node)
        case "text-input":
            DilTextInput(node: node)
        case "loading-block":
            DilLoadingBlock(node: node)
        case "grid", "flow":
            DilGridView(node: node)
        case "carousel":
            DilCarousel(node: node)
        case "table", "table-section", "table-row", "table-cell":
            DilTableView(node: node)
        case "celebration":
            DilChildren(node: node) // Wonder's stylesheet hides the confetti; children still render
        case "blockquote":
            DilBlockquote(node: node)
        default:
            if InlineText.textish.contains(node.type) {
                if InlineText.canInline(node) { DilTextView(node: node) } else { DilContainerView(node: node, forceColumn: true) }
            } else if node.type == "pressable", node["inline"].truthy, InlineText.canInline(node) {
                DilTextView(node: node, isPressable: true)
            } else {
                DilContainerView(node: node)
            }
        }
    }
}

/// Children in a plain column (fallback for unknown containers).
struct DilChildren: View {
    let node: DilNode
    var body: some View {
        FlexLayout(row: false, gap: 0, align: .stretch, fillsWidth: true) {
            ForEach(node.children) { c in AnyView(DilNodeView(node: c)) }
        }
    }
}

// MARK: text

struct DilTextView: View {
    let node: DilNode
    var override: InlineText.Style? = nil
    var line: CGFloat? = nil
    var isPressable = false
    @Environment(\.dilBase) private var base
    @Environment(\.dilLine) private var lineHeight
    @Environment(\.dilStretch) private var stretch

    private var style: InlineText.Style {
        let baseStyle = InlineText.Style(size: base)
        var style = isPressable ? baseStyle : InlineText.style(for: node, base: baseStyle)
        if let o = override {
            style.size = o.size; style.weight = o.weight; style.tracking = o.tracking
            if let c = o.color { style.color = c }
        }
        return style
    }

    var body: some View {
        let style = self.style
        let attributed = isPressable ? InlineText.attributed(node, base: style, isRoot: true) : InlineText.attributed(node, base: style)
        let lh = line ?? (node.type == "title" ? 1.3 : lineHeight)
        let align = textAlignment
        let text = Text(attributed)
            .lineSpacing(max(0, style.size * (lh - 1.2)))
            .multilineTextAlignment(align.text)
            .lineLimit(node["maxLines"].int ?? (node["truncate"].truthy ? 1 : nil))
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
        if node.type == "badge" {
            text
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(InlineText.badgeColors(node["color"].string).0))
        } else {
            text
                .frame(maxWidth: stretch ? .infinity : nil, alignment: align.frame)
                .accessibilityAddTraits(node.type == "title" ? .isHeader : [])
        }
    }

    private var textAlignment: (text: TextAlignment, frame: Alignment) {
        switch node["textAlign"].string {
        case "center": return (.center, .center)
        case "right", "end": return (.trailing, .trailing)
        default: return (.leading, .leading)
        }
    }
}

struct DilMarkdownView: View {
    let node: DilNode
    @Environment(\.dilBase) private var base
    @Environment(\.dilLine) private var lineHeight

    private var style: InlineText.Style {
        var style = InlineText.Style(size: base)
        if let k = node["size"].string, let t = DilTheme.textSizes[k] { style.size = t.0 * base / 16 }
        if let w = DilTheme.weight(node["weight"]) { style.weight = w }
        if let c = DilTheme.color(node["color"]) { style.color = c }
        return style
    }

    var body: some View {
        let style = self.style
        let src = node.plainText
        let blocks = node.type == "markdown" ? Self.blocks(src) : [Block.para(src.replacingOccurrences(of: "\n", with: " "))]
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                switch b {
                case .para(let s):
                    Text(InlineText.markdown(s, base: style))
                        .lineSpacing(max(0, style.size * (lineHeight - 1.2)))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let s):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(s).font(.system(size: style.size * 0.85, design: .monospaced)).padding(14)
                    }
                    .background(RoundedRectangle(cornerRadius: 12).fill(DilTheme.surface2))
                }
            }
        }
    }

    enum Block { case para(String), code(String) }

    static func blocks(_ src: String) -> [Block] {
        let trimmed = src.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
            var lines = trimmed.components(separatedBy: "\n")
            lines.removeFirst()
            if let l = lines.last, l.trimmingCharacters(in: .whitespaces).hasPrefix("```") || l.trimmingCharacters(in: .whitespaces).hasPrefix("~~~") { lines.removeLast() }
            return [.code(lines.joined(separator: "\n"))]
        }
        return src.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map { .para($0) }
    }
}

struct DilBlockquote: View {
    let node: DilNode
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 1.5).fill(DilTheme.lineStrong).frame(width: 3)
            if InlineText.canInline(node) { DilTextView(node: node) } else { DilChildren(node: node) }
        }
        .fixedSize(horizontal: false, vertical: true)
        .foregroundStyle(DilTheme.ink2)
    }
}

// MARK: containers

struct DilContainerView: View {
    let node: DilNode
    var forceColumn = false
    @Environment(\.dilStretch) private var stretched
    @Environment(\.dilActions) private var actions

    var body: some View {
        let p = node.props
        let dir = forceColumn ? "col" : (p["direction"]?.string ?? (node.type == "row" ? "row" : "col"))
        let row = dir == "row"
        let align = FlexLayout.Align(p["align"] ?? .null, row: row)
        let percent = DilTheme.percent(p["width"] ?? .null)
        let fills = (stretched && p["width"]?.double == nil && !(p["inline"]?.truthy ?? false)) || percent != nil
        let layout = FlexLayout(row: row, gap: DilTheme.space(p["gap"] ?? .null) ?? 0, crossGap: DilTheme.space(p["rowGap"] ?? .null),
                                align: align, justify: FlexLayout.Justify(p["justify"] ?? .null), wrap: p["wrap"]?.truthy ?? false, fillsWidth: fills)
        let content = layout {
            ForEach(node.children) { c in flexChild(c, row: row, stretch: !row && align == .stretch) }
        }
        .environment(\.dilParentRow, row)
        let box = BoxStyle(node: node, fills: fills)
        if node.type == "pressable" {
            PressableView(node: node, box: box, actions: actions) { content }
        } else {
            content.modifier(BoxModifier(box: box))
        }
    }

    private func flexChild(_ c: DilNode, row: Bool, stretch: Bool) -> some View {
        var spec = FlexSpec(c["flex"], type: c.type)
        if c.type == "spacer" && c["size"].isNull && c["flex"].isNull { spec.grow = 1; spec.basisZero = false }
        if c["width"].double != nil || (c["size"].double != nil && !InlineText.textish.contains(c.type)) { spec.shrink = 0 }
        // a column stretches its children across; in a row, a growing item takes the width the row gives it
        let fill = row ? (spec.grow > 0 || spec.basisZero) : stretch
        return AnyView(DilNodeView(node: c).environment(\.dilStretch, fill))
            .layoutValue(key: FlexGrow.self, value: row ? spec.grow : 0)
            .layoutValue(key: FlexShrink.self, value: spec.shrink)
            .layoutValue(key: FlexBasisZero.self, value: row && spec.basisZero)
            .layoutValue(key: FlexPercentWidth.self, value: DilTheme.percent(c["width"]))
    }
}

/// Box decoration for a container: host.js computePresentation's padding, size, background,
/// border, radius, clip and opacity, plus Wonder's pressable variants (styles.css).
struct BoxStyle {
    var padding = EdgeInsets()
    var margin = EdgeInsets()
    var width: CGFloat? = nil
    var height: CGFloat? = nil
    var minWidth: CGFloat? = nil
    var maxWidth: CGFloat? = nil
    var minHeight: CGFloat? = nil
    var maxHeight: CGFloat? = nil
    var fills = false
    var aspect: CGFloat? = nil
    var background: Color? = nil
    var border: Color? = nil
    var borderWidth: CGFloat = 1
    var dashed = false
    /// host.js borderStyle `side`: one edge only (Callout's accent rule)
    var borderSide: Edge? = nil
    var radius: CGFloat = 0
    var clip = false
    var opacity: Double = 1
    var foreground: Color? = nil
    var shadow = false
    var alignment: Alignment = .topLeading

    init(node: DilNode, fills: Bool) {
        let p = node.props
        let type = node.type
        padding = Self.insets(p["padding"] ?? .null)
        margin = Self.insets(p["margin"] ?? .null)
        let isText = InlineText.textish.contains(type)
        if let s = p["size"]?.double, !isText, type != "icon", type != "button" { width = CGFloat(s); height = CGFloat(s) }
        if let w = p["width"]?.double { width = CGFloat(w) } else if let w = p["width"]?.string.flatMap(DilTheme.cssLength) { width = w }
        if let h = p["height"]?.double { height = CGFloat(h) } else if let h = p["height"]?.string.flatMap(DilTheme.cssLength) { height = h }
        minWidth = p["minWidth"]?.double.map { CGFloat($0) }.flatMap { $0 > 0 ? $0 : nil }
        maxWidth = p["maxWidth"]?.double.map { CGFloat($0) }
        minHeight = p["minHeight"]?.double.map { CGFloat($0) }
        maxHeight = p["maxHeight"]?.double.map { CGFloat($0) }
        self.fills = fills && width == nil
        if let a = p["aspectRatio"] {
            if let n = a.double { aspect = CGFloat(n) } else if let s = a.string {
                let parts = s.replacingOccurrences(of: ":", with: "/").split(separator: "/").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
                if parts.count == 2, parts[1] > 0 { aspect = CGFloat(parts[0] / parts[1]) }
            }
        }
        if type == "card" {
            if p["border"] == nil { border = DilTheme.line }
            if p["padding"] == nil { padding = EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16) }
            radius = 8
        }
        if type == "pressable" { applyVariant(node) }
        if let bg = p["background"], let c = DilTheme.color(bg, .bg) { background = c }
        if let b = p["border"] { applyBorder(b) }
        if let r = p["radius"], let rr = DilTheme.radius(r) { radius = rr }
        clip = (p["clip"]?.truthy ?? false) || (p["scrollable"]?.truthy ?? false)
        if let o = p["opacity"]?.double { opacity = o }
        if type == "pressable", p["disabled"]?.truthy == true, p["dimWhenDisabled"]?.truthy == true { opacity *= 0.45 }
    }

    static func insets(_ v: JSON) -> EdgeInsets {
        if v.isNull { return EdgeInsets() }
        if case .object(let o) = v {
            func s(_ keys: [String]) -> CGFloat { for k in keys { if let x = o[k], let c = DilTheme.space(x) { return c } }; return 0 }
            return EdgeInsets(top: s(["top", "y", "vertical"]), leading: s(["left", "start", "x", "horizontal"]), bottom: s(["bottom", "y", "vertical"]), trailing: s(["right", "end", "x", "horizontal"]))
        }
        let a = DilTheme.space(v) ?? 0
        return EdgeInsets(top: a, leading: a, bottom: a, trailing: a)
    }

    private mutating func applyBorder(_ v: JSON) {
        switch v {
        case .bool(let b): border = b ? DilTheme.line : nil
        case .number(let n): border = DilTheme.line; borderWidth = CGFloat(n)
        case .string(let s): border = s == "none" ? nil : (DilTheme.color(v, .border) ?? DilTheme.line); if s == "none" { borderWidth = 0 }
        case .object(let o):
            borderWidth = CGFloat(o["size"]?.double ?? o["width"]?.double ?? 1)
            border = DilTheme.color(o["color"] ?? "default", .border) ?? DilTheme.line
            if o["style"]?.string == "dashed" { dashed = true }
            switch o["side"]?.string {
            case "left", "start": borderSide = .leading
            case "right", "end": borderSide = .trailing
            case "top": borderSide = .top
            case "bottom": borderSide = .bottom
            default: break
            }
        default: break
        }
    }

    private mutating func applyVariant(_ node: DilNode) {
        let v = node["variant"].string ?? "plain"
        let pressed = node["ariaPressed"].truthy
        switch v {
        case "option-idle": background = DilTheme.surface; border = DilTheme.controlBorder; shadow = true
        case "option-picked": background = DilTheme.brandSubtle; border = DilTheme.accent
        case "option-correct": background = DilTheme.successSubtle; border = DilTheme.success
        case "option-wrong": background = DilTheme.dangerSubtle; border = DilTheme.danger
        case "option-dim": background = DilTheme.surface; border = DilTheme.controlBorder; opacity = 0.5
        case "flash-front": background = DilTheme.brandSubtle; border = DilTheme.line; shadow = true; alignment = .center
        case "flash-back": background = DilTheme.surface2; border = DilTheme.line; alignment = .center
        case "node-decision": background = DilTheme.surface2; border = DilTheme.controlBorder; dashed = true
        case "node-start", "node-end": background = DilTheme.surface2; border = DilTheme.controlBorder
        case "node-sub": background = DilTheme.surface2; border = DilTheme.controlBorder; dashed = true
        case "node-on": background = DilTheme.brandSubtle; border = DilTheme.accent
        case "segment": foreground = DilTheme.ink2
        case "segment-on": background = DilTheme.surface; border = DilTheme.line; foreground = DilTheme.ink; shadow = true
        case "stop", "stepper": background = DilTheme.surface; border = DilTheme.controlBorder; foreground = DilTheme.ink
        case "stop-on": background = DilTheme.ink; border = DilTheme.ink; foreground = DilTheme.bg
        case "track": background = DilTheme.surface3
        case "track-on": background = pressed ? DilTheme.accent : DilTheme.ink
        case "selected": background = DilTheme.alpha(10)
        case "cite", "citation": background = pressed ? DilTheme.accent : DilTheme.surface3; foreground = pressed ? .white : DilTheme.ink2; radius = 9999
        case "keyterm": foreground = DilTheme.accent
        default:
            if v.hasPrefix("node-") { background = DilTheme.surface; border = DilTheme.controlBorder }
        }
    }
}

struct BoxModifier: ViewModifier {
    let box: BoxStyle

    /// Full radii (9999) become a capsule: a rounded rectangle with a huge radius draws nothing.
    private var shape: AnyShape {
        box.radius >= 999 ? AnyShape(Capsule(style: .continuous)) : AnyShape(RoundedRectangle(cornerRadius: box.radius, style: .continuous))
    }

    func body(content: Content) -> some View {
        let shape = self.shape
        content
            .padding(box.padding)
            .frame(width: box.width, height: box.height, alignment: box.alignment)
            .frame(minWidth: box.minWidth, maxWidth: box.fills ? .infinity : box.maxWidth, minHeight: box.minHeight, maxHeight: box.maxHeight, alignment: box.alignment)
            .modifier(AspectIf(ratio: box.aspect))
            .foregroundStyle(box.foreground.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.foreground))
            .background {
                if let bg = box.background {
                    shape.fill(bg).shadow(color: box.shadow ? .black.opacity(0.05) : .clear, radius: 1, y: 1)
                }
            }
            .overlay {
                if let b = box.border, box.borderWidth > 0 {
                    if let side = box.borderSide {
                        edge(side, b).clipShape(shape)
                    } else {
                        shape.stroke(b, style: StrokeStyle(lineWidth: box.borderWidth, dash: box.dashed ? [5, 4] : [])).padding(box.borderWidth / 2)
                    }
                }
            }
            .modifier(ClipIf(on: box.clip, shape: shape))
            .opacity(box.opacity)
            .padding(box.margin)
            #if DEBUG
            .overlay { if Self.debugOutlines { Rectangle().stroke(.red.opacity(0.6), lineWidth: 0.5) } }
            #endif
    }

    #if DEBUG
    /// Launch with `-wonder.debugLayout YES` to outline every DIL box.
    static let debugOutlines = UserDefaults.standard.bool(forKey: "wonder.debugLayout")
    #endif
}

/// `.aspectRatio(nil)` is not a no-op (it fits the view to its ideal aspect): only apply a real ratio.
struct AspectIf: ViewModifier {
    let ratio: CGFloat?
    func body(content: Content) -> some View {
        if let ratio, ratio > 0 { content.aspectRatio(ratio, contentMode: .fit) } else { content }
    }
}

extension BoxModifier {
    @ViewBuilder
    fileprivate func edge(_ side: Edge, _ color: Color) -> some View {
        switch side {
        case .leading: HStack(spacing: 0) { color.frame(width: box.borderWidth); Spacer(minLength: 0) }
        case .trailing: HStack(spacing: 0) { Spacer(minLength: 0); color.frame(width: box.borderWidth) }
        case .top: VStack(spacing: 0) { color.frame(height: box.borderWidth); Spacer(minLength: 0) }
        case .bottom: VStack(spacing: 0) { Spacer(minLength: 0); color.frame(height: box.borderWidth) }
        }
    }
}

struct ClipIf: ViewModifier {
    let on: Bool
    let shape: AnyShape
    func body(content: Content) -> some View {
        if on { content.clipShape(shape) } else { content }
    }
}

struct PressableView<Content: View>: View {
    let node: DilNode
    let box: BoxStyle
    let actions: DilActions?
    @ViewBuilder var content: () -> Content

    var body: some View {
        let fn = node["onClick"].fnId
        let disabled = node["disabled"].truthy
        Button {
            if let fn, !disabled { actions?.invoke(fn) }
        } label: {
            content().modifier(BoxModifier(box: box)).contentShape(Rectangle())
        }
        .buttonStyle(PressFeedbackStyle())
        .disabled(disabled || fn == nil)
        .accessibilityLabel(node["ariaLabel"].string.map { Text($0) } ?? Text(node.plainText))
        .accessibilityAddTraits(node["ariaPressed"].truthy ? .isSelected : [])
    }
}

struct PressFeedbackStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.65 : 1)
    }
}

// MARK: controls

struct DilButtonView: View {
    let node: DilNode
    @Environment(\.dilActions) private var actions
    @Environment(\.dilBase) private var base

    var body: some View {
        let variant = node["variant"].string ?? "solid"
        let size = node["size"].string ?? "md"
        let disabled = node["disabled"].truthy
        let (h, fs, ph): (CGFloat, CGFloat, CGFloat) = size == "sm" ? (30, 13, 12) : size == "lg" ? (44, 15, 20) : (36, 14, 15)
        let colors: (bg: Color, fg: Color, border: Color?) = {
            switch variant {
            case "outline", "secondary": return (DilTheme.surface, DilTheme.ink, DilTheme.controlBorder)
            case "ghost": return (.clear, DilTheme.accent, nil)
            case "soft": return (DilTheme.alpha(6), DilTheme.ink, nil)
            default:
                if node["color"].string == "danger" { return (DilTheme.danger, .white, nil) }
                return (DilTheme.brand, DilTheme.brandInk, nil)
            }
        }()
        Button {
            if let fn = node["onClick"].fnId { actions?.invoke(fn) }
        } label: {
            HStack(spacing: 6) {
                if let label = node["label"].string { Text(label) }
                ForEach(node.children) { c in AnyView(DilNodeView(node: c)) }
            }
            .font(.system(size: fs * base / 16, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, ph)
            .frame(height: h)
            .frame(maxWidth: node["block"].truthy ? .infinity : nil)
            .foregroundStyle(colors.fg)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(colors.bg))
            .overlay { if let b = colors.border { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(b) } }
            .contentShape(Rectangle())
        }
        .buttonStyle(PressFeedbackStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
        .environment(\.dilStretch, false)
        .fixedSize(horizontal: !node["block"].truthy, vertical: true)
    }
}

struct DilIcon: View {
    let node: DilNode
    var body: some View {
        let spinner = node.type == "loading-indicator"
        let size: CGFloat = node["size"].double.map { CGFloat($0) } ?? DilTheme.iconSizes[node["size"].string ?? ""] ?? 18
        DilIconView(name: spinner ? "loader" : (node["name"].string ?? "circle"), size: size, color: DilTheme.color(node["color"]), weight: node["weight"].string == "bold" ? 2.4 : 1.9, spinning: spinner)
    }
}

struct DilDivider: View {
    let node: DilNode
    @Environment(\.dilParentRow) private var inRow
    var body: some View {
        let c = DilTheme.color(node["color"].isNull ? "default" : node["color"], .border) ?? DilTheme.line
        let spacing = DilTheme.space(node["spacing"]) ?? 0
        if inRow {
            Rectangle().fill(c).frame(width: 1).frame(maxHeight: .infinity).padding(.horizontal, spacing)
        } else {
            Rectangle().fill(c).frame(height: 1).frame(maxWidth: .infinity).padding(.vertical, spacing)
        }
    }
}

struct DilSpacer: View {
    let node: DilNode
    @Environment(\.dilParentRow) private var inRow
    var body: some View {
        if let s = node["size"].double {
            Color.clear.frame(width: inRow ? CGFloat(s) : 0, height: inRow ? 0 : CGFloat(s))
        } else {
            Color.clear.frame(width: 0, height: 0)
        }
    }
}

struct DilListView: View {
    let node: DilNode
    var body: some View {
        let numbered = node["marker"].string == "number"
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(node.children.enumerated()), id: \.element.id) { i, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(numbered ? "\(i + 1)." : "•").foregroundStyle(DilTheme.ink3).monospacedDigit()
                    if item.type == "list-item" {
                        if InlineText.canInline(item) { DilTextView(node: item) } else { DilChildren(node: item) }
                    } else {
                        AnyView(DilNodeView(node: item))
                    }
                }
            }
        }
        .padding(.leading, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct DilImagePlaceholder: View {
    let node: DilNode
    var body: some View {
        // host.js: remote images stay a placeholder unless the host allows them (privacy)
        VStack(spacing: 4) {
            DilIconView(name: "image", size: 22, color: DilTheme.ink3, weight: 1.6)
            Text(node["alt"].string ?? "Remote image").font(.caption2).foregroundStyle(DilTheme.ink3).lineLimit(3).multilineTextAlignment(.center)
        }
        .padding(8)
        .frame(maxWidth: .infinity, minHeight: 120)
        .modifier(AspectIf(ratio: DilTheme.cssLength(node["aspectRatio"].string ?? "") ?? node["aspectRatio"].double.map { CGFloat($0) }))
        .background(RoundedRectangle(cornerRadius: 12).fill(DilTheme.surface3))
    }
}

struct DilLoadingBlock: View {
    let node: DilNode
    @State private var dim = false
    var body: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(DilTheme.surface3)
            .frame(height: node["height"].double.map { CGFloat($0) } ?? (node["aspectRatio"].isNull ? 48 : nil))
            .frame(maxWidth: .infinity)
            .opacity(dim ? 0.5 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { dim = true } }
            .accessibilityLabel(node["label"].string ?? "Loading")
    }
}

struct DilTextInput: View {
    let node: DilNode
    @Environment(\.dilActions) private var actions
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        let rows = max(1, min(12, node["rows"].int ?? 3))
        TextField(node["placeholder"].string ?? "", text: $text, axis: .vertical)
            .lineLimit(rows...max(rows, 12))
            .focused($focused)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 8).fill(DilTheme.surface))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(focused ? DilTheme.accent : DilTheme.controlBorder))
            .disabled(node["disabled"].truthy)
            .accessibilityLabel(node["ariaLabel"].string ?? "Answer")
            .onAppear { text = node["value"].string ?? "" }
            .onChange(of: text) { _, v in
                let limit = node["maxLength"].int ?? 2000
                if v.count > limit { text = String(v.prefix(limit)); return }
                if v != (node["value"].string ?? ""), let fn = node["onChange"].fnId { actions?.invoke(fn, [.string(v)]) }
            }
            .onChange(of: node["value"].string ?? "") { _, v in if !focused && v != text { text = v } }
    }
}

struct DilGridView: View {
    let node: DilNode
    var body: some View {
        let gap = DilTheme.space(node["gap"]) ?? 0
        let cols: [GridItem] = {
            if let n = node["columns"].int, n > 0 { return Array(repeating: GridItem(.flexible(), spacing: gap, alignment: .top), count: n) }
            return [GridItem(.adaptive(minimum: 140), spacing: gap, alignment: .top)]
        }()
        LazyVGrid(columns: cols, alignment: .leading, spacing: DilTheme.space(node["rowGap"]) ?? gap) {
            ForEach(node.children) { c in AnyView(DilNodeView(node: c)).environment(\.dilStretch, true) }
        }
    }
}

struct DilCarousel: View {
    let node: DilNode
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: DilTheme.space(node["gap"]) ?? 12) {
                ForEach(node.children) { c in
                    AnyView(DilNodeView(node: c)).frame(width: c["width"].double.map { CGFloat($0) } ?? 260).environment(\.dilStretch, true)
                }
            }
        }
    }
}

struct DilTableView: View {
    let node: DilNode
    var body: some View {
        switch node.type {
        case "table", "table-section":
            VStack(alignment: .leading, spacing: 0) { ForEach(node.children) { c in AnyView(DilTableView(node: c)) } }
        case "table-row":
            HStack(alignment: .top, spacing: 12) { ForEach(node.children) { c in AnyView(DilTableView(node: c)).frame(maxWidth: .infinity, alignment: .leading) } }
                .padding(.vertical, 6)
                .overlay(alignment: .bottom) { Rectangle().fill(DilTheme.line).frame(height: 1) }
        default:
            if InlineText.canInline(node) { DilTextView(node: node) } else { DilChildren(node: node) }
        }
    }
}

struct DilMathBlock: View {
    let node: DilNode
    @Environment(\.dilBase) private var base
    var body: some View {
        MathView(latex: node.plainText, display: true, fontSize: base * 1.1)
            .frame(maxWidth: .infinity)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 8).fill(DilTheme.surface2))
    }
}
