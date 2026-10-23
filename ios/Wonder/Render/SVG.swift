import SwiftUI

/// SVG path data -> Path (M L H V C S Q T A Z, absolute and relative). Used for the icon set
/// (chatgpt-dil icons.js, shared through the core) and the `svg` / `path` primitives.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var t = Tokenizer(Array(d.utf8))
        var cmd: UInt8 = 0
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCtrl: CGPoint? = nil
        var lastCmd: UInt8 = 0
        while true {
            if let c = t.command() { cmd = c } else if cmd == 0 || !t.hasNumber() { break }
            let rel = cmd >= 97
            let up = rel ? cmd - 32 : cmd
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y) }
            switch up {
            case UInt8(ascii: "M"):
                guard let x = t.number(), let y = t.number() else { return path }
                cur = pt(x, y); start = cur; path.move(to: cur)
                cmd = rel ? UInt8(ascii: "l") : UInt8(ascii: "L") // implicit lineto
                lastCtrl = nil
            case UInt8(ascii: "L"):
                guard let x = t.number(), let y = t.number() else { return path }
                cur = pt(x, y); path.addLine(to: cur); lastCtrl = nil
            case UInt8(ascii: "H"):
                guard let x = t.number() else { return path }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur); lastCtrl = nil
            case UInt8(ascii: "V"):
                guard let y = t.number() else { return path }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur); lastCtrl = nil
            case UInt8(ascii: "C"):
                guard let x1 = t.number(), let y1 = t.number(), let x2 = t.number(), let y2 = t.number(), let x = t.number(), let y = t.number() else { return path }
                let c1 = pt(x1, y1), c2 = pt(x2, y2), e = pt(x, y)
                path.addCurve(to: e, control1: c1, control2: c2); cur = e; lastCtrl = c2
            case UInt8(ascii: "S"):
                guard let x2 = t.number(), let y2 = t.number(), let x = t.number(), let y = t.number() else { return path }
                let c1 = (lastCmd == UInt8(ascii: "C") || lastCmd == UInt8(ascii: "S")) && lastCtrl != nil ? CGPoint(x: 2 * cur.x - lastCtrl!.x, y: 2 * cur.y - lastCtrl!.y) : cur
                let c2 = pt(x2, y2), e = pt(x, y)
                path.addCurve(to: e, control1: c1, control2: c2); cur = e; lastCtrl = c2
            case UInt8(ascii: "Q"):
                guard let x1 = t.number(), let y1 = t.number(), let x = t.number(), let y = t.number() else { return path }
                let c = pt(x1, y1), e = pt(x, y)
                path.addQuadCurve(to: e, control: c); cur = e; lastCtrl = c
            case UInt8(ascii: "T"):
                guard let x = t.number(), let y = t.number() else { return path }
                let c = (lastCmd == UInt8(ascii: "Q") || lastCmd == UInt8(ascii: "T")) && lastCtrl != nil ? CGPoint(x: 2 * cur.x - lastCtrl!.x, y: 2 * cur.y - lastCtrl!.y) : cur
                let e = pt(x, y)
                path.addQuadCurve(to: e, control: c); cur = e; lastCtrl = c
            case UInt8(ascii: "A"):
                guard let rx = t.number(), let ry = t.number(), let rot = t.number(), let large = t.flag(), let sweep = t.flag(), let x = t.number(), let y = t.number() else { return path }
                let e = pt(x, y)
                arc(&path, from: cur, to: e, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                cur = e; lastCtrl = nil
            case UInt8(ascii: "Z"):
                path.closeSubpath(); cur = start; lastCtrl = nil
                cmd = 0
            default:
                return path
            }
            lastCmd = up
        }
        return path
    }

    /// Endpoint arc -> cubic Béziers (SVG implementation notes F.6).
    private static func arc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rx0: CGFloat, ry ry0: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rx0), ry = abs(ry0)
        if rx == 0 || ry == 0 || p0 == p1 { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180
        let cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var coef = sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx
        let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
        let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && dTheta > 0 { dTheta -= 2 * .pi } else if sweep && dTheta < 0 { dTheta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(dTheta) / (.pi / 2))))
        let delta = dTheta / CGFloat(segments)
        let k = 4 / 3 * tan(delta / 4)
        var t = theta1
        for _ in 0..<segments {
            let c1 = cos(t), s1 = sin(t), c2 = cos(t + delta), s2 = sin(t + delta)
            func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: cx + cosP * rx * x - sinP * ry * y, y: cy + sinP * rx * x + cosP * ry * y) }
            path.addCurve(to: map(c2, s2), control1: map(c1 - k * s1, s1 + k * c1), control2: map(c2 + k * s2, s2 - k * c2))
            t += delta
        }
    }

    private struct Tokenizer {
        let b: [UInt8]
        var i = 0
        init(_ b: [UInt8]) { self.b = b }

        mutating func skip() { while i < b.count, b[i] == 32 || b[i] == 44 || b[i] == 9 || b[i] == 10 || b[i] == 13 { i += 1 } }

        mutating func command() -> UInt8? {
            skip()
            guard i < b.count else { return nil }
            let c = b[i]
            if (c >= 65 && c <= 90) || (c >= 97 && c <= 122), c != UInt8(ascii: "e"), c != UInt8(ascii: "E") { i += 1; return c }
            return nil
        }

        mutating func hasNumber() -> Bool {
            skip()
            guard i < b.count else { return false }
            let c = b[i]
            return (c >= 48 && c <= 57) || c == 45 || c == 43 || c == 46
        }

        mutating func flag() -> Bool? {
            skip()
            guard i < b.count else { return nil }
            let c = b[i]
            if c == 48 { i += 1; return false }
            if c == 49 { i += 1; return true }
            return nil
        }

        mutating func number() -> CGFloat? {
            skip()
            let s = i
            if i < b.count, b[i] == 45 || b[i] == 43 { i += 1 }
            var dot = false, digits = false
            while i < b.count {
                let c = b[i]
                if c >= 48 && c <= 57 { digits = true; i += 1 }
                else if c == 46 && !dot { dot = true; i += 1 }
                else if (c == 101 || c == 69) && digits {
                    i += 1
                    if i < b.count, b[i] == 45 || b[i] == 43 { i += 1 }
                    while i < b.count, b[i] >= 48 && b[i] <= 57 { i += 1 }
                    break
                } else { break }
            }
            guard digits, let str = String(bytes: b[s..<i], encoding: .ascii), let v = Double(str) else { i = s; return nil }
            return CGFloat(v)
        }
    }
}

/// The 24×24 stroke icon set, loaded once from the core (chatgpt-dil icons.js).
@MainActor
enum Icons {
    private static var paths: [String: [String]]? = nil
    private static var cache: [String: Path] = [:]

    static func path(_ name: String) -> Path {
        if let p = cache[name] { return p }
        if paths == nil {
            var out: [String: [String]] = [:]
            for (k, v) in WonderCore.shared.get("icons").object { out[k] = v.array.compactMap(\.string) }
            paths = out
        }
        let ds = paths?[name] ?? paths?["circle"] ?? []
        var p = Path()
        for d in ds { p.addPath(SVGPath.parse(d)) }
        cache[name] = p
        return p
    }
}

struct DilIconView: View {
    let name: String
    let size: CGFloat
    var color: Color? = nil
    var weight: CGFloat = 1.9
    var spinning = false
    @State private var angle: Double = 0

    var body: some View {
        let path = Icons.path(name)
        Canvas { ctx, sz in
            let s = min(sz.width, sz.height) / 24
            let p = path.applying(CGAffineTransform(scaleX: s, y: s))
            ctx.stroke(p, with: .foreground, style: StrokeStyle(lineWidth: weight * s, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .foregroundStyle(color.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.foreground))
        .rotationEffect(.degrees(angle))
        .onAppear {
            guard spinning else { return }
            withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { angle = 360 }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - svg primitive

/// The `svg` primitive and its shape children, drawn in one Canvas in viewBox coordinates.
struct DilSVGView: View {
    let node: DilNode

    struct Shape {
        var path: Path
        var fill: Color?
        var stroke: Color?
        var strokeWidth: CGFloat
        var dash: [CGFloat]
        var cap: CGLineCap
        var join: CGLineJoin
        var opacity: Double
        var nonScaling: Bool
    }

    var body: some View {
        let vb = viewBox
        let shapes = collect(node, inherited: Inherited())
        let aspect = vb.width > 0 && vb.height > 0 ? vb.width / vb.height : 1
        let heightProp = node["height"].double
        let widthProp = node["width"].double
        Canvas { ctx, size in
            let sx = size.width / vb.width, sy = size.height / vb.height
            let s = min(sx, sy)
            let ox = (size.width - vb.width * s) / 2 - vb.minX * s, oy = (size.height - vb.height * s) / 2 - vb.minY * s
            let tf = CGAffineTransform(translationX: ox, y: oy).scaledBy(x: s, y: s)
            for sh in shapes {
                let p = sh.path.applying(tf)
                var c = ctx
                c.opacity = sh.opacity
                if let f = sh.fill { c.fill(p, with: .color(f)) }
                if let st = sh.stroke, sh.strokeWidth > 0 {
                    let w = sh.nonScaling ? sh.strokeWidth : sh.strokeWidth * s
                    c.stroke(p, with: .color(st), style: StrokeStyle(lineWidth: w, lineCap: sh.cap, lineJoin: sh.join, dash: sh.dash.map { sh.nonScaling ? $0 : $0 * s }))
                }
            }
        }
        .modifier(AspectIf(ratio: heightProp == nil ? aspect : nil))
        .frame(width: widthProp.map { CGFloat($0) }, height: heightProp.map { CGFloat($0) })
        .frame(maxWidth: widthProp == nil ? .infinity : nil)
        .accessibilityLabel(node["ariaLabel"].string ?? "")
    }

    private var viewBox: CGRect {
        let parts = (node["viewBox"].string ?? "0 0 100 100").split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
        guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { return CGRect(x: 0, y: 0, width: 100, height: 100) }
        return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }

    struct Inherited {
        var fill: JSON = .null
        var stroke: JSON = .null
        var strokeWidth: JSON = .null
        var opacity: Double = 1
        var offset = CGPoint.zero
    }

    private func collect(_ n: DilNode, inherited: Inherited) -> [Shape] {
        var inh = inherited
        let p = n.props
        if let f = p["fill"] { inh.fill = f }
        if let s = p["stroke"] { inh.stroke = s }
        if let w = p["strokeWidth"] { inh.strokeWidth = w }
        if n.type == "g", let t = p["transform"]?.string, let tr = translate(t) { inh.offset = CGPoint(x: inh.offset.x + tr.x, y: inh.offset.y + tr.y) }
        var out: [Shape] = []
        if n.type != "svg" && n.type != "g", var path = shapePath(n) {
            if inh.offset != .zero { path = path.applying(CGAffineTransform(translationX: inh.offset.x, y: inh.offset.y)) }
            let fillOpacity = p["fillOpacity"]?.double ?? 1
            let strokeOpacity = p["strokeOpacity"]?.double ?? 1
            let fill: Color? = inh.fill.string == "none" ? nil : (inh.fill.isNull ? (n.type == "line" || n.type == "polyline" ? nil : DilTheme.ink) : DilTheme.color(inh.fill)).map { $0.opacity(fillOpacity) }
            let stroke: Color? = inh.stroke.isNull || inh.stroke.string == "none" ? nil : DilTheme.color(inh.stroke).map { $0.opacity(strokeOpacity) }
            let dash = (p["strokeDasharray"]?.string ?? p["strokeDasharray"]?.double.map { String($0) } ?? "").split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }.map { CGFloat($0) }
            out.append(Shape(path: path, fill: fill, stroke: stroke, strokeWidth: CGFloat(inh.strokeWidth.double ?? 1), dash: dash,
                             cap: cap(p["strokeLinecap"]?.string), join: join(p["strokeLinejoin"]?.string), opacity: (p["opacity"]?.double ?? 1) * inh.opacity,
                             nonScaling: p["vectorEffect"]?.string == "non-scaling-stroke"))
        }
        for c in n.children where !c.isText { out += collect(c, inherited: inh) }
        return out
    }

    private func translate(_ t: String) -> CGPoint? {
        guard t.hasPrefix("translate(") else { return nil }
        let nums = t.dropFirst(10).prefix(while: { $0 != ")" }).split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
        return CGPoint(x: nums.first ?? 0, y: nums.count > 1 ? nums[1] : 0)
    }

    private func shapePath(_ n: DilNode) -> Path? {
        let num = { (k: String) in CGFloat(n[k].double ?? 0) }
        switch n.type {
        case "path": return n["d"].string.map(SVGPath.parse)
        case "circle": let r = num("r"); return Path(ellipseIn: CGRect(x: num("cx") - r, y: num("cy") - r, width: 2 * r, height: 2 * r))
        case "ellipse": return Path(ellipseIn: CGRect(x: num("cx") - num("rx"), y: num("cy") - num("ry"), width: 2 * num("rx"), height: 2 * num("ry")))
        case "rect":
            let r = CGRect(x: num("x"), y: num("y"), width: CGFloat(n["width"].double ?? 0), height: CGFloat(n["height"].double ?? 0))
            let rx = num("rx")
            return rx > 0 ? Path(roundedRect: r, cornerRadius: rx) : Path(r)
        case "line":
            var p = Path(); p.move(to: CGPoint(x: num("x1"), y: num("y1"))); p.addLine(to: CGPoint(x: num("x2"), y: num("y2"))); return p
        case "polyline", "polygon":
            let v = (n["points"].string ?? "").split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
            guard v.count >= 4 else { return nil }
            var p = Path()
            p.move(to: CGPoint(x: v[0], y: v[1]))
            var i = 2
            while i + 1 < v.count { p.addLine(to: CGPoint(x: v[i], y: v[i + 1])); i += 2 }
            if n.type == "polygon" { p.closeSubpath() }
            return p
        default: return nil
        }
    }

    private func cap(_ s: String?) -> CGLineCap { s == "round" ? .round : s == "square" ? .square : .butt }
    private func join(_ s: String?) -> CGLineJoin { s == "round" ? .round : s == "bevel" ? .bevel : .miter }
}
