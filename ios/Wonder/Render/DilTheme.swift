import SwiftUI
import UIKit

/// Wonder's design tokens (app/styles/styles.css) and the DIL host's token tables
/// (chatgpt-dil host.js: spacing scale, radii, type scale, color names), resolved for SwiftUI.
enum DilTheme {
    // MARK: palette (light, dark) from styles.css :root and its dark theme

    static let bg = dyn(0xFFFFFF, 0x0A0A0A)
    static let surface = dyn(0xFFFFFF, 0x111111)
    static let surface2 = dyn(0xFAFAFA, 0x161616)
    static let surface3 = dyn(0xF2F2F2, 0x1F1F1F)
    static let hover = dyn(0xF5F5F5, 0x1A1A1A)
    static let ink = dyn(0x171717, 0xEDEDED)
    static let ink2 = dyn(0x4D4D4D, 0xA1A1A1)
    static let ink3 = dyn(0x8F8F8F, 0x737373)
    static let line = dyn(0xEBEBEB, 0x1F1F1F)
    static let lineStrong = dyn(0xE0E0E0, 0x2E2E2E)
    static let controlBorder = dyn(0xE0E0E0, 0x2E2E2E)
    static let brand = dyn(0x171717, 0xEDEDED)
    static let brandInk = dyn(0xFFFFFF, 0x0A0A0A)
    static let accent = dyn(0x0070F3, 0x3291FF)
    static let brandStrong = dyn(0x0068D6, 0x52A8FF)
    static let brandSubtle = dyn(0xEBF5FF, 0x0D1F33)
    static let brandMuted = dyn(0xCDE5FF, 0x12385E)
    static let success = dyn(0x18794E, 0x3FB971)
    static let successSubtle = dyn(0xE9F9EF, 0x0B2618)
    static let danger = dyn(0xD93036, 0xFF5C63)
    static let dangerSubtle = dyn(0xFFEBEC, 0x2E0F11)
    static let warning = dyn(0xA35200, 0xF5A623)
    static let warningSubtle = dyn(0xFFF4E5, 0x2B1B05)
    static let flame = dyn(0xF5A623, 0xF5A623)
    static let highlight = Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(red: 50 / 255, green: 145 / 255, blue: 1, alpha: 0.2) : UIColor(red: 0, green: 112 / 255, blue: 243 / 255, alpha: 0.14) })

    static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }

    static func alpha(_ pct: Double) -> Color {
        Color(UIColor { t in (t.userInterfaceStyle == .dark ? UIColor(hex: 0xEDEDED) : UIColor(hex: 0x171717)).withAlphaComponent(pct / 100) })
    }

    // MARK: spacing, radii, type (host.js tokens; 1rem = 16pt, --d-spacing = 4pt)

    static let spacingUnit: CGFloat = 4

    static func space(_ v: JSON) -> CGFloat? {
        if let n = v.double { return CGFloat(n) * spacingUnit }
        if let s = v.string { return cssLength(s) }
        return nil
    }

    /// Wonder's stylesheet replaces every inline radius except true circles with --r-md (8pt).
    static func radius(_ v: JSON) -> CGFloat? {
        if v.isNull { return nil }
        if v.string == "full" { return 9999 }
        if v.string == "none" || v.double == 0 { return 0 }
        if let n = v.double, n >= 999 { return 9999 }
        if let s = v.string, s.hasSuffix("%"), (Double(s.dropLast()) ?? 0) >= 50 { return 9999 }
        return 8
    }

    static let textSizes: [String: (CGFloat, CGFloat)] = ["xs": (12, 16), "sm": (14, 20), "md": (16, 24), "lg": (18, 26), "xl": (20, 28), "2xl": (24, 32), "3xl": (30, 36)]
    static let titleSizes: [String: (CGFloat, CGFloat)] = ["xs": (14, 20), "sm": (16, 24), "md": (18, 26), "lg": (20, 28), "xl": (24, 32), "2xl": (30, 36), "3xl": (36, 40)]
    static let iconSizes: [String: CGFloat] = ["xs": 12, "sm": 16, "md": 18, "lg": 20, "xl": 24, "2xl": 32]

    static func weight(_ v: JSON) -> Font.Weight? {
        switch v.string {
        case "light": return .light
        case "regular", "normal": return .regular
        case "medium": return .medium
        case "semibold": return .semibold
        case "bold": return .bold
        default:
            if let n = v.double { return n >= 700 ? .bold : n >= 600 ? .semibold : n >= 500 ? .medium : n <= 300 ? .light : .regular }
            return nil
        }
    }

    /// A CSS length: px / rem / em / plain number. Percentages and calc() return nil.
    static func cssLength(_ s: String) -> CGFloat? {
        let t = s.trimmingCharacters(in: .whitespaces)
        if t.hasSuffix("px"), let n = Double(t.dropLast(2)) { return CGFloat(n) }
        if t.hasSuffix("rem"), let n = Double(t.dropLast(3)) { return CGFloat(n) * 16 }
        if t.hasSuffix("em"), let n = Double(t.dropLast(2)) { return CGFloat(n) * 16 }
        if let n = Double(t) { return CGFloat(n) }
        return nil
    }

    /// "37.5%" -> 0.375
    static func percent(_ v: JSON) -> CGFloat? {
        guard let s = v.string?.trimmingCharacters(in: .whitespaces), s.hasSuffix("%"), let n = Double(s.dropLast()) else { return nil }
        return CGFloat(n / 100)
    }

    // MARK: colors (host.js resolveColor, Wonder's --d-color-* overrides)

    enum Context { case text, bg, border }

    private static let palette: [String: UInt32] = [
        "green-400": 0x34c38f, "green-500": 0x10a37f, "green-600": 0x0e8c6d, "red-400": 0xf2555a, "red-500": 0xe02e2a, "red-600": 0xc32323,
        "blue-400": 0x4f9cf9, "blue-500": 0x2f7bf5, "blue-600": 0x1d63d6, "orange-400": 0xff9a4d, "orange-500": 0xf97316, "yellow-400": 0xf5c542,
        "yellow-500": 0xe9a23b, "purple-400": 0xa78bfa, "purple-500": 0x8b5cf6, "gray-100": 0xf4f4f4, "gray-200": 0xe8e8e8, "gray-300": 0xd4d4d4,
        "gray-400": 0xa3a3a3, "gray-500": 0x737373, "gray-600": 0x525252,
    ]

    static func color(_ v: JSON, _ ctx: Context = .text) -> Color? {
        guard let s = v.string, !s.isEmpty else { return nil }
        if s == "transparent" || s == "none" { return .clear }
        if s == "currentColor" || s == "inherit" { return nil }
        if let c = parseCSSColor(s) { return c }
        if s.hasPrefix("alpha-"), let n = Double(s.dropFirst(6)) { return alpha(n) }
        switch ctx {
        case .text:
            switch s {
            case "default", "primary": return ink
            case "secondary": return ink2
            case "tertiary", "subtle": return ink3
            case "inverse": return surface
            default: break
            }
        case .bg:
            switch s {
            case "default", "surface", "surface-primary": return surface
            case "surface-secondary", "subtle", "secondary": return surface2
            case "surface-tertiary": return surface3
            case "primary": return ink
            default: break
            }
        case .border:
            switch s {
            case "default", "subtle", "secondary", "tertiary": return line
            case "strong", "heavy": return lineStrong
            case "primary": return ink
            default: break
            }
        }
        switch s {
        case "danger", "error", "red": return danger
        case "success", "positive", "green": return success
        case "warning": return warning
        case "info", "accent", "link": return brandStrong
        case "white": return .white
        case "black": return Color(UIColor(hex: 0x0d0d0d))
        case "danger-subtle": return dangerSubtle
        case "success-subtle": return successSubtle
        case "warning-subtle": return warningSubtle
        case "primary": return ink
        case "secondary": return ink2
        case "tertiary": return ink3
        // Wonder's --d-color-* tokens
        case "brand": return brand
        case "brand-strong": return brandStrong
        case "brand-subtle": return brandSubtle
        case "brand-muted": return brandMuted
        case "on-brand": return brandInk
        case "surface": return surface
        case "surface-secondary": return surface2
        case "surface-tertiary": return surface3
        case "border-timeline": return lineStrong
        case "compare-left": return brandSubtle
        case "compare-right": return warningSubtle
        case "callout-insight": return brandSubtle
        case "callout-insight-edge", "callout-insight-ink": return brandStrong
        case "callout-tip": return warningSubtle
        case "callout-tip-edge", "callout-tip-ink": return warning
        case "callout-info": return surface2
        case "callout-info-edge": return ink3
        case "callout-info-ink": return ink2
        case "callout-warning": return dangerSubtle
        case "callout-warning-edge", "callout-warning-ink": return danger
        case "callout-example": return successSubtle
        case "callout-example-edge", "callout-example-ink": return success
        default: break
        }
        if let hex = palette[s] { return Color(UIColor(hex: hex)) }
        return nil
    }

    /// #rgb, #rrggbb, #rrggbbaa, rgb()/rgba(), and var(--d-…) references to the tokens above.
    static func parseCSSColor(_ raw: String) -> Color? {
        let s = raw.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") {
            var hex = String(s.dropFirst())
            if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
            guard let v = UInt64(hex, radix: 16) else { return nil }
            if hex.count == 6 { return Color(UIColor(hex: UInt32(v))) }
            if hex.count == 8 { return Color(UIColor(hex: UInt32(v >> 8)).withAlphaComponent(CGFloat(v & 0xff) / 255)) }
            return nil
        }
        if s.hasPrefix("rgb") {
            let inner = s.drop(while: { $0 != "(" }).dropFirst().prefix(while: { $0 != ")" })
            let parts = inner.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" }).compactMap { Double($0.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "%", with: "")) }
            guard parts.count >= 3 else { return nil }
            let a = parts.count > 3 ? (parts[3] > 1 ? parts[3] / 100 : parts[3]) : 1
            return Color(.sRGB, red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, opacity: a)
        }
        if s.hasPrefix("var(--") {
            let name = s.dropFirst(6).prefix(while: { $0 != ")" && $0 != "," })
            let token = name.hasPrefix("d-color-") ? String(name.dropFirst(8)) : name.hasPrefix("d-") ? String(name.dropFirst(2)) : String(name)
            switch token {
            case "text-primary": return ink
            case "text-secondary": return ink2
            case "text-tertiary": return ink3
            case "accent": return brandStrong
            case "accent-subtle": return brandSubtle
            case "border-default", "border-subtle": return line
            case "border-strong": return lineStrong
            default: return color(.string(token), .text)
            }
        }
        return nil
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
}
