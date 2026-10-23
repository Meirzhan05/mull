import SwiftUI

/// The CSS flexbox subset the DIL host uses (host.js computePresentation: direction, gap, align,
/// justify, wrap; children's flex grow/shrink and percentage widths), as a SwiftUI Layout.
struct FlexLayout: Layout {
    enum Align { case start, center, end, stretch, baseline }
    enum Justify { case start, center, end, between, around, evenly }

    var row: Bool
    var gap: CGFloat = 0
    var crossGap: CGFloat? = nil
    var align: Align = .stretch
    var justify: Justify = .start
    var wrap = false
    /// A block-level flex container takes the width it is offered (CSS `display: flex`).
    var fillsWidth = false

    struct Cache { var forWidth: CGFloat? = nil; var widths: [CGFloat] = []; var sizes: [CGSize] = [] }
    func makeCache(subviews: Subviews) -> Cache { Cache() }

    // MARK: sizing

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        if subviews.isEmpty { return CGSize(width: fillsWidth ? (proposal.width ?? 0) : 0, height: 0) }
        if row { return wrap ? wrapSize(proposal, subviews) : rowSize(proposal, subviews, &cache) }
        return colSize(proposal, subviews, &cache)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        if subviews.isEmpty { return }
        if row {
            if wrap { placeWrapped(bounds, subviews) } else { placeRow(bounds, proposal, subviews, &cache) }
        } else {
            placeCol(bounds, subviews, &cache)
        }
    }

    // MARK: column

    private func colWidth(_ s: LayoutSubview, _ w: CGFloat?) -> CGFloat? {
        guard let w, w.isFinite else { return nil }
        if let pct = s[FlexPercentWidth.self] { return w * pct }
        return w
    }

    private func colSize(_ proposal: ProposedViewSize, _ subviews: Subviews, _ cache: inout Cache) -> CGSize {
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        var sizes: [CGSize] = []
        for s in subviews {
            sizes.append(s.sizeThatFits(ProposedViewSize(width: colWidth(s, w), height: nil)))
        }
        cache.sizes = sizes
        cache.forWidth = w
        let content = sizes.map(\.width).max() ?? 0
        let height = sizes.map(\.height).reduce(0, +) + gap * CGFloat(max(0, subviews.count - 1))
        let width = (fillsWidth || align == .stretch) ? (w ?? content) : min(w ?? content, content)
        return CGSize(width: width, height: max(height, proposal.height.flatMap { $0.isFinite && justify != .start ? $0 : nil } ?? 0))
    }

    private func placeCol(_ bounds: CGRect, _ subviews: Subviews, _ cache: inout Cache) {
        let w = bounds.width
        var sizes = cache.sizes
        if sizes.count != subviews.count || cache.forWidth.map({ abs($0 - w) > 0.5 }) ?? true {
            sizes = subviews.map { $0.sizeThatFits(ProposedViewSize(width: colWidth($0, w), height: nil)) }
        }
        let total = sizes.map(\.height).reduce(0, +) + gap * CGFloat(max(0, subviews.count - 1))
        let (start, between) = distribute(free: bounds.height - total, count: subviews.count)
        var y = bounds.minY + start
        for (i, s) in subviews.enumerated() {
            let size = sizes[i]
            let cw = colWidth(s, w) ?? size.width
            let childW = align == .stretch || s[FlexPercentWidth.self] != nil ? cw : min(size.width, w)
            let x: CGFloat
            switch align {
            case .center: x = bounds.minX + (w - childW) / 2
            case .end: x = bounds.maxX - childW
            default: x = bounds.minX
            }
            s.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: childW, height: size.height))
            y += size.height + gap + between
        }
    }

    // MARK: row

    /// Main-axis widths: CSS flex-basis, then grow into free space or shrink to fit.
    private func rowWidths(_ width: CGFloat?, _ subviews: Subviews) -> [CGFloat] {
        let gaps = gap * CGFloat(max(0, subviews.count - 1))
        var basis: [CGFloat] = []
        for s in subviews {
            if let pct = s[FlexPercentWidth.self], let width, width.isFinite { basis.append(width * pct); continue }
            if s[FlexBasisZero.self] { basis.append(0); continue }
            basis.append(s.sizeThatFits(.unspecified).width)
        }
        guard let width, width.isFinite else { return basis }
        let free = width - gaps - basis.reduce(0, +)
        if free > 0.5 {
            let grow = subviews.map { $0[FlexGrow.self] }
            let total = grow.reduce(0, +)
            if total > 0 { return zip(basis, grow).map { $0 + free * $1 / total } }
            return basis
        }
        if free < -0.5 {
            // shrink in proportion to basis; items that do not shrink keep their size
            let shrink = subviews.map { $0[FlexShrink.self] }
            let weights = zip(basis, shrink).map { $0 * $1 }
            let total = weights.reduce(0, +)
            guard total > 0 else { return basis }
            return zip(basis, weights).map { max(0, $0 - (-free) * $1 / total) }
        }
        return basis
    }

    private func rowSize(_ proposal: ProposedViewSize, _ subviews: Subviews, _ cache: inout Cache) -> CGSize {
        let widths = rowWidths(proposal.width, subviews)
        var sizes: [CGSize] = []
        for (i, s) in subviews.enumerated() { sizes.append(s.sizeThatFits(ProposedViewSize(width: widths[i], height: nil))) }
        cache.widths = widths
        cache.sizes = sizes
        cache.forWidth = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        let used = zip(widths, sizes).map { max($0, $1.width) }.reduce(0, +) + gap * CGFloat(max(0, subviews.count - 1))
        let growing = subviews.contains { $0[FlexGrow.self] > 0 }
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil }
        let width: CGFloat
        if let w, fillsWidth || growing || justify == .between || justify == .around || justify == .evenly || justify == .end || justify == .center { width = w }
        else { width = min(w ?? used, used) }
        return CGSize(width: width, height: sizes.map(\.height).max() ?? 0)
    }

    private func placeRow(_ bounds: CGRect, _ proposal: ProposedViewSize, _ subviews: Subviews, _ cache: inout Cache) {
        var widths = cache.widths
        var sizes = cache.sizes
        if widths.count != subviews.count || sizes.count != subviews.count || cache.forWidth.map({ abs($0 - bounds.width) > 0.5 }) ?? true {
            widths = rowWidths(bounds.width, subviews)
            sizes = subviews.enumerated().map { $1.sizeThatFits(ProposedViewSize(width: widths[$0], height: nil)) }
        }
        let used = widths.reduce(0, +) + gap * CGFloat(max(0, subviews.count - 1))
        let (start, between) = distribute(free: bounds.width - used, count: subviews.count)
        var x = bounds.minX + start
        for (i, s) in subviews.enumerated() {
            let w = widths[i]
            let h = align == .stretch ? bounds.height : sizes[i].height
            let y: CGFloat
            switch align {
            case .start, .stretch, .baseline: y = bounds.minY
            case .center: y = bounds.minY + (bounds.height - h) / 2
            case .end: y = bounds.maxY - h
            }
            s.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: w, height: h))
            x += w + gap + between
        }
    }

    // MARK: wrapping row

    /// CSS flex-wrap: break lines by each item's flex-basis (its ideal width), then let growing
    /// items share the line's free space; heights are measured at the final widths.
    private func lines(_ width: CGFloat, _ subviews: Subviews) -> [[(Int, CGSize)]] {
        var rows: [[(Int, CGFloat)]] = [[]]
        var x: CGFloat = 0
        for (i, s) in subviews.enumerated() {
            var w: CGFloat
            if let pct = s[FlexPercentWidth.self] { w = width * pct } else { w = s[FlexBasisZero.self] ? 0 : s.sizeThatFits(.unspecified).width }
            w = min(w, width)
            if !rows[rows.count - 1].isEmpty && x + gap + w > width + 0.5 {
                rows.append([])
                x = 0
            }
            x += (rows[rows.count - 1].isEmpty ? 0 : gap) + w
            rows[rows.count - 1].append((i, w))
        }
        return rows.map { line in
            let used = line.map(\.1).reduce(0, +) + gap * CGFloat(max(0, line.count - 1))
            let free = max(0, width - used)
            let grow = line.map { subviews[$0.0][FlexGrow.self] }
            let total = grow.reduce(0, +)
            return line.enumerated().map { k, item in
                let w = total > 0 ? item.1 + free * grow[k] / total : item.1
                let h = subviews[item.0].sizeThatFits(ProposedViewSize(width: w, height: nil)).height
                return (item.0, CGSize(width: w, height: h))
            }
        }
    }

    private func wrapSize(_ proposal: ProposedViewSize, _ subviews: Subviews) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? subviews.map { $0.sizeThatFits(.unspecified).width }.reduce(0, +) + gap * CGFloat(max(0, subviews.count - 1))
        let ls = lines(width, subviews)
        let vgap = crossGap ?? gap
        let height = ls.map { $0.map(\.1.height).max() ?? 0 }.reduce(0, +) + vgap * CGFloat(max(0, ls.count - 1))
        let widest = ls.map { l in l.map(\.1.width).reduce(0, +) + gap * CGFloat(max(0, l.count - 1)) }.max() ?? 0
        return CGSize(width: fillsWidth || justify != .start ? width : min(width, widest), height: height)
    }

    private func placeWrapped(_ bounds: CGRect, _ subviews: Subviews) {
        let ls = lines(bounds.width, subviews)
        let vgap = crossGap ?? gap
        var y = bounds.minY
        for l in ls {
            let lh = l.map(\.1.height).max() ?? 0
            let used = l.map(\.1.width).reduce(0, +) + gap * CGFloat(max(0, l.count - 1))
            let (start, between) = distribute(free: bounds.width - used, count: l.count)
            var x = bounds.minX + start
            for (i, size) in l {
                let yy: CGFloat = align == .center ? y + (lh - size.height) / 2 : align == .end ? y + lh - size.height : y
                subviews[i].place(at: CGPoint(x: x, y: yy), anchor: .topLeading, proposal: ProposedViewSize(width: size.width, height: size.height))
                x += size.width + gap + between
            }
            y += lh + vgap
        }
    }

    // MARK: justify-content

    private func distribute(free: CGFloat, count: Int) -> (start: CGFloat, between: CGFloat) {
        guard free > 0.5, count > 0 else { return (0, 0) }
        switch justify {
        case .start: return (0, 0)
        case .center: return (free / 2, 0)
        case .end: return (free, 0)
        case .between: return count > 1 ? (0, free / CGFloat(count - 1)) : (0, 0)
        case .around: return (free / CGFloat(count) / 2, free / CGFloat(count))
        case .evenly: return (free / CGFloat(count + 1), free / CGFloat(count + 1))
        }
    }
}

struct FlexGrow: LayoutValueKey { static let defaultValue: CGFloat = 0 }
struct FlexShrink: LayoutValueKey { static let defaultValue: CGFloat = 1 }
struct FlexBasisZero: LayoutValueKey { static let defaultValue = false }
struct FlexPercentWidth: LayoutValueKey { static let defaultValue: CGFloat? = nil }

extension FlexLayout.Align {
    init(_ v: JSON, row: Bool) {
        switch v.string {
        case "start", "flex-start": self = .start
        case "center": self = .center
        case "end", "flex-end": self = .end
        case "baseline": self = .baseline
        case "stretch": self = .stretch
        default: self = row ? .center : .stretch // host.js: rows center by default, columns stretch
        }
    }
}

extension FlexLayout.Justify {
    init(_ v: JSON) {
        switch v.string {
        case "center": self = .center
        case "end", "flex-end": self = .end
        case "between", "space-between": self = .between
        case "around", "space-around": self = .around
        case "evenly", "space-evenly": self = .evenly
        default: self = .start
        }
    }
}

/// A child's CSS `flex` shorthand: grow, shrink and whether its basis is 0.
struct FlexSpec {
    var grow: CGFloat = 0
    var shrink: CGFloat = 1
    var basisZero = false

    init(_ v: JSON, type: String) {
        // host.js: badges, buttons, icons and sized boxes are `flex: 0 0 auto`
        if ["badge", "button", "icon", "loading-indicator"].contains(type) { shrink = 0 }
        if let n = v.double { grow = CGFloat(n); basisZero = true; return }
        guard let s = v.string?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return }
        if s == "none" { grow = 0; shrink = 0; return }
        if s == "auto" { grow = 1; return }
        let parts = s.split(separator: " ").map(String.init)
        if let g = Double(parts[0]) { grow = CGFloat(g) }
        if parts.count > 1, let sh = Double(parts[1]) { shrink = CGFloat(sh) }
        if parts.count > 2 { basisZero = parts[2] == "0" || parts[2] == "0%" || parts[2] == "0px" } else if parts.count == 1 { basisZero = true }
    }
}
