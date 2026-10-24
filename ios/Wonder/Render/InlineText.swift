import SwiftUI

/// Paragraph rendering: a DIL text element and its inline children (bold, italic, code, links,
/// inline math, inline pressables such as KeyTerm and Cite) become one AttributedString, so text
/// wraps and selects like native text. Inline pressables are links to `dil-fn://<id>`, which the
/// surface's openURL handler turns into invokeFunction calls.
enum InlineText {
    static let textish: Set<String> = ["text", "title", "caption", "label", "bold", "italic", "underline", "strikethrough", "code", "shimmer-text", "badge", "link", "blockquote", "math"]
    static let inlineOnly: Set<String> = ["bold", "italic", "underline", "strikethrough", "code", "link", "math", "shimmer-text", "caption", "label", "text", "title", "badge"]

    /// Can this subtree be drawn as one run of text?
    static func canInline(_ n: DilNode) -> Bool {
        if n.isText { return true }
        if n.type == "pressable" { return n["inline"].truthy && n.children.allSatisfy(canInline) }
        if n.type == "math" { return !n["display"].truthy }
        if n.type == "icon" { return true }
        guard inlineOnly.contains(n.type) else { return false }
        return n.children.allSatisfy(canInline)
    }

    struct Style {
        var size: CGFloat
        var weight: Font.Weight = .regular
        var italic = false
        var mono = false
        var serif = false
        var color: Color? = nil
        var background: Color? = nil
        var underline: Text.LineStyle? = nil
        var strike = false
        var link: URL? = nil
        var tracking: CGFloat = 0

        var font: Font {
            var f = Font.system(size: size, weight: weight, design: mono ? .monospaced : serif ? .serif : .default)
            if italic { f = f.italic() }
            return f
        }
    }

    /// The text style a DIL element sets on itself (host.js computePresentation, text branch).
    static func style(for n: DilNode, base: Style) -> Style {
        var s = base
        let p = n.props
        let isTitle = n.type == "title"
        let scale = isTitle ? DilTheme.titleSizes : DilTheme.textSizes
        let sz = p["size"] ?? (isTitle ? "md" : .null)
        if let key = sz.string, let t = scale[key] { s.size = t.0 * base.size / 16 } else if let px = sz.double, !isTitle || px > 4 { s.size = CGFloat(px) }
        if let fs = p["fontSize"], let px = fs.double ?? fs.string.flatMap(DilTheme.cssLength).map(Double.init) { s.size = CGFloat(px) }
        if let w = DilTheme.weight(p["weight"] ?? .null) { s.weight = w } else if isTitle { s.weight = .semibold }
        if n.type == "bold" || p["strong"]?.truthy == true { s.weight = heavier(s.weight, .semibold) }
        if n.type == "italic" || p["italic"]?.truthy == true { s.italic = true }
        if n.type == "underline" || p["underline"]?.truthy == true { s.underline = .single }
        if n.type == "strikethrough" || p["lineThrough"]?.truthy == true { s.strike = true }
        if n.type == "code" { s.mono = true; s.size *= 0.92; s.background = DilTheme.surface3 }
        if n.type == "math" { s.serif = true; s.italic = true }
        if n.type == "link" {
            s.color = p["color"].flatMap { DilTheme.color($0) } ?? DilTheme.accent
            s.underline = .single
            if let href = p["href"]?.string { s.link = URL(string: href) }
        } else if n.type != "badge", let c = p["color"].flatMap({ DilTheme.color($0, .text) }) {
            s.color = c
        }
        if n.type == "badge" {
            s.size = 12 * base.size / 16
            s.weight = .medium
            let (bg, fg) = badgeColors(p["color"]?.string)
            s.background = p["background"].flatMap { DilTheme.color($0, .bg) } ?? bg
            s.color = fg
        }
        return s
    }

    static func badgeColors(_ c: String?) -> (Color, Color) {
        switch c {
        case "danger": return (DilTheme.dangerSubtle, DilTheme.danger)
        case "success": return (DilTheme.successSubtle, DilTheme.success)
        case "warning": return (DilTheme.warningSubtle, DilTheme.warning)
        case "info": return (DilTheme.brandSubtle, DilTheme.accent)
        case "subtle", "secondary": return (DilTheme.surface3, DilTheme.ink2)
        default: return (DilTheme.surface3, DilTheme.ink)
        }
    }

    /// Build the attributed run for `n` (an element whose children all canInline).
    static func attributed(_ n: DilNode, base: Style, isRoot: Bool = true) -> AttributedString {
        if n.isText { return run(n.text, base) }
        var s = isRoot ? base : style(for: n, base: base)
        if n.type == "math" {
            return run(TeX.unicode(n.plainText), s)
        }
        if n.type == "icon" { return AttributedString() }
        if n.type == "pressable" {
            let variant = n["variant"].string ?? "plain"
            if let fn = n["onClick"].fnId, !n["disabled"].truthy { s.link = URL(string: "dil-fn://\(fn)") }
            switch variant {
            case "keyterm":
                s.color = DilTheme.accent
                s.weight = heavier(s.weight, .medium)
                s.underline = n["ariaPressed"].truthy ? .single : Text.LineStyle(pattern: .dash)
                if n["ariaPressed"].truthy { s.background = DilTheme.highlight }
            case "keyterm-more":
                s.color = DilTheme.accent
                s.weight = .medium
                s.underline = .single
            case "cite", "citation":
                var c = s
                c.size = max(10, s.size * 0.66)
                c.weight = .semibold
                c.color = n["ariaPressed"].truthy ? .white : DilTheme.ink2
                c.background = n["ariaPressed"].truthy ? DilTheme.accent : DilTheme.surface3
                c.underline = nil
                var out = AttributedString("\u{2009}")
                var inner = AttributedString("\u{2009}")
                for ch in n.children { inner += attributed(ch, base: c, isRoot: false) }
                inner += AttributedString("\u{2009}")
                inner.font = c.font
                inner.foregroundColor = c.color
                inner.backgroundColor = c.background
                inner.baselineOffset = s.size * 0.28
                if let l = c.link { inner.link = l }
                out += inner
                return out
            case "entity":
                s.underline = .single
            default:
                break
            }
        }
        var out = AttributedString()
        if n.type == "badge" { out += run("\u{2009}", s) }
        for ch in n.children { out += attributed(ch, base: s, isRoot: false) }
        if n.type == "badge" { out += run("\u{2009}", s) }
        return out
    }

    static func run(_ text: String, _ s: Style) -> AttributedString {
        var a = AttributedString(text)
        a.font = s.font
        if let c = s.color { a.foregroundColor = c }
        if let b = s.background { a.backgroundColor = b }
        if let u = s.underline { a.underlineStyle = u }
        if s.strike { a.strikethroughStyle = .single }
        if let l = s.link { a.link = l }
        if s.tracking != 0 { a.tracking = s.tracking }
        return a
    }

    // MARK: TextOnly markdown (host.js renderMiniMarkdown / inlineMd)

    /// Inline markdown: **bold**, *italic*, `code`, [links](url), $math$ and \(math\).
    static func markdown(_ src: String, base: Style) -> AttributedString {
        var out = AttributedString()
        let pattern = #"(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\\\([^)]*\\\)|\$[^$\n]+\$)"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return run(src, base) }
        let ns = src as NSString
        var last = 0
        for m in re.matches(in: src, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > last { out += run(ns.substring(with: NSRange(location: last, length: m.range.location - last)), base) }
            let t = ns.substring(with: m.range)
            if t.hasPrefix("**") || t.hasPrefix("__") {
                var b = base; b.weight = heavier(b.weight, .semibold)
                out += markdown(String(t.dropFirst(2).dropLast(2)), base: b)
            } else if t.hasPrefix("`") {
                var c = base; c.mono = true; c.size *= 0.92; c.background = DilTheme.surface3
                out += run(String(t.dropFirst().dropLast()), c)
            } else if t.hasPrefix("[") {
                let label = t.dropFirst().prefix(while: { $0 != "]" })
                let url = t.drop(while: { $0 != "(" }).dropFirst().dropLast()
                var l = base; l.color = DilTheme.accent; l.underline = .single; l.link = URL(string: String(url))
                out += run(String(label), l)
            } else if t.hasPrefix("\\(") || (t.hasPrefix("$") && !(t.dropFirst().first?.isNumber ?? false)) {
                var mth = base; mth.serif = true; mth.italic = true
                out += run(TeX.unicode(t.hasPrefix("$") ? String(t.dropFirst().dropLast()) : String(t.dropFirst(2).dropLast(2))), mth)
            } else if t.hasPrefix("$") {
                out += run(t, base)
            } else {
                var i = base; i.italic = true
                out += markdown(String(t.dropFirst().dropLast()), base: i)
            }
            last = m.range.location + m.range.length
        }
        if last < ns.length { out += run(ns.substring(from: last), base) }
        return out
    }
}

/// Plain-text math for inline formulas (the web shows KaTeX; this keeps formulas readable in a
/// single run of native text): Greek letters, operators, super/subscripts, \frac and \sqrt.
enum TeX {
    private static let symbols: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ",
        "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ",
        "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω", "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π",
        "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω", "times": "×", "cdot": "·", "div": "÷", "pm": "±", "mp": "∓", "leq": "≤", "le": "≤",
        "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠", "approx": "≈", "sim": "∼", "equiv": "≡", "propto": "∝", "infty": "∞", "sum": "Σ", "prod": "∏",
        "int": "∫", "partial": "∂", "nabla": "∇", "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒", "Leftarrow": "⇐", "leftrightarrow": "↔",
        "iff": "⇔", "implies": "⇒", "in": "∈", "notin": "∉", "subset": "⊂", "subseteq": "⊆", "cup": "∪", "cap": "∩", "forall": "∀", "exists": "∃",
        "emptyset": "∅", "ldots": "…", "cdots": "⋯", "dots": "…", "circ": "∘", "degree": "°", "angle": "∠", "perp": "⊥", "parallel": "∥", "hbar": "ℏ",
        "ell": "ℓ", "log": "log", "ln": "ln", "sin": "sin", "cos": "cos", "tan": "tan", "exp": "exp", "lim": "lim", "max": "max", "min": "min",
        "quad": "\u{2003}", "qquad": "\u{2003}\u{2003}", ",": "\u{2009}", ";": "\u{2005}", ":": "\u{2005}", "!": "", " ": " ", "%": "%", "$": "$", "&": "&",
        "#": "#", "_": "_", "{": "{", "}": "}", "langle": "⟨", "rangle": "⟩", "lvert": "|", "rvert": "|", "mid": "|", "neg": "¬", "land": "∧", "lor": "∨",
    ]
    private static let sup: [Character: Character] = ["0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ", "x": "ˣ", "y": "ʸ", "a": "ᵃ", "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "k": "ᵏ", "m": "ᵐ", "t": "ᵗ", "T": "ᵀ", "−": "⁻"]
    private static let sub: [Character: Character] = ["0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", "a": "ₐ", "e": "ₑ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ", "n": "ₙ", "o": "ₒ", "r": "ᵣ", "t": "ₜ", "x": "ₓ", "m": "ₘ", "p": "ₚ", "s": "ₛ"]

    static func unicode(_ src: String) -> String {
        var p = Parser(chars: Array(src))
        return p.parse(until: nil).replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    private struct Parser {
        let chars: [Character]
        var i = 0

        mutating func group() -> String {
            skipSpaces()
            guard i < chars.count else { return "" }
            if chars[i] == "{" { i += 1; return parse(until: "}") }
            if chars[i] == "\\" { return command() }
            let c = chars[i]; i += 1
            return String(c)
        }

        mutating func skipSpaces() { while i < chars.count, chars[i] == " " { i += 1 } }

        mutating func command() -> String {
            i += 1 // backslash
            guard i < chars.count else { return "" }
            var name = ""
            if chars[i].isLetter { while i < chars.count, chars[i].isLetter { name.append(chars[i]); i += 1 } } else { name = String(chars[i]); i += 1 }
            switch name {
            case "frac", "dfrac", "tfrac":
                let a = group(), b = group()
                return "\(wrap(a))⁄\(wrap(b))"
            case "sqrt":
                skipSpaces()
                if i < chars.count, chars[i] == "[" { i += 1; var n = ""; while i < chars.count, chars[i] != "]" { n.append(chars[i]); i += 1 }; i += 1; return "\(script(n, sup) ?? n)√\(wrap(group()))" }
                return "√\(wrap(group()))"
            case "text", "mathrm", "mathbf", "mathit", "operatorname", "textbf", "textit", "mathsf", "boldsymbol", "mathcal", "mathbb":
                return group()
            case "left", "right", "big", "Big", "bigg", "Bigg", "displaystyle", "textstyle", "limits":
                return ""
            case "overline", "bar": return group() + "\u{0305}"
            case "hat": return group() + "\u{0302}"
            case "vec": return group() + "\u{20D7}"
            case "dot": return group() + "\u{0307}"
            default:
                return symbols[name] ?? name
            }
        }

        func wrap(_ s: String) -> String { s.count > 1 && s.contains(where: { "+-−×·/ ".contains($0) }) ? "(\(s))" : s }

        func script(_ s: String, _ table: [Character: Character]) -> String? {
            var out = ""
            for c in s { guard let m = table[c] else { return nil }; out.append(m) }
            return out
        }

        mutating func parse(until end: Character?) -> String {
            var out = ""
            while i < chars.count {
                let c = chars[i]
                if let end, c == end { i += 1; return out }
                switch c {
                case "\\": out += command()
                case "^":
                    i += 1
                    let g = group()
                    out += script(g, TeX.sup) ?? "^(\(g))"
                case "_":
                    i += 1
                    let g = group()
                    out += script(g, TeX.sub) ?? "_(\(g))"
                case "{": i += 1; out += parse(until: "}")
                case "}": i += 1
                case "-": i += 1; out += "−"
                case "*": i += 1; out += "·"
                default: i += 1; out.append(c)
                }
            }
            return out
        }
    }
}

private let weightOrder: [Font.Weight] = [.ultraLight, .thin, .light, .regular, .medium, .semibold, .bold, .heavy, .black]

/// The heavier of two font weights (Font.Weight is not Comparable).
func heavier(_ a: Font.Weight, _ b: Font.Weight) -> Font.Weight {
    (weightOrder.firstIndex(of: a) ?? 3) >= (weightOrder.firstIndex(of: b) ?? 3) ? a : b
}
