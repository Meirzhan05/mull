import SwiftUI

// Shared chrome in Wonder's design system: neutral cards with a hairline border, filled
// controls, one blue accent (app/styles/styles.css).

struct CardModifier: ViewModifier {
    var padding: CGFloat = 16
    var dashed = false
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(DilTheme.surface))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(DilTheme.line, style: StrokeStyle(lineWidth: 1, dash: dashed ? [5, 4] : [])))
            .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
    }
}

extension View {
    func card(padding: CGFloat = 16, dashed: Bool = false) -> some View { modifier(CardModifier(padding: padding, dashed: dashed)) }
}

struct WonderButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, ghost }
    var kind: Kind = .primary
    var large = false
    var full = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let (bg, fg, border): (Color, Color, Color?) = {
            switch kind {
            case .primary: return (DilTheme.brand, DilTheme.brandInk, nil)
            case .secondary: return (DilTheme.surface, DilTheme.ink, DilTheme.controlBorder)
            case .ghost: return (.clear, DilTheme.accent, nil)
            }
        }()
        configuration.label
            .font(.system(size: large ? 16 : 14, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, large ? 18 : 14)
            .frame(height: large ? 46 : 36)
            .frame(maxWidth: full ? .infinity : nil)
            .foregroundStyle(fg)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(bg))
            .overlay { if let border { RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(border) } }
            .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == WonderButtonStyle {
    static var primary: WonderButtonStyle { WonderButtonStyle(kind: .primary) }
    static var secondary: WonderButtonStyle { WonderButtonStyle(kind: .secondary) }
    static var ghostLink: WonderButtonStyle { WonderButtonStyle(kind: .ghost) }
    static func wonder(_ kind: WonderButtonStyle.Kind, large: Bool = false, full: Bool = false) -> WonderButtonStyle { WonderButtonStyle(kind: kind, large: large, full: full) }
}

struct Tag: View {
    let text: String
    var icon: String? = nil
    var tone: Tone = .neutral
    enum Tone { case neutral, brand, success, warning, danger }
    var body: some View {
        let (bg, fg): (Color, Color) = {
            switch tone {
            case .neutral: return (DilTheme.surface3, DilTheme.ink2)
            case .brand: return (DilTheme.brandSubtle, DilTheme.accent)
            case .success: return (DilTheme.successSubtle, DilTheme.success)
            case .warning: return (DilTheme.warningSubtle, DilTheme.warning)
            case .danger: return (DilTheme.dangerSubtle, DilTheme.danger)
            }
        }()
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.system(size: 10, weight: .semibold)) }
            Text(text)
        }
        .font(.system(size: 12, weight: .medium))
        .padding(.horizontal, 8).frame(height: 22)
        .foregroundStyle(fg)
        .background(Capsule().fill(bg))
    }
}

struct Kicker: View {
    let text: String
    var body: some View {
        Text(text.uppercased()).font(.system(size: 11, weight: .semibold)).tracking(0.6).foregroundStyle(DilTheme.ink3)
    }
}

struct ToastView: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(DilTheme.brandInk)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Capsule().fill(DilTheme.brand))
            .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
            .padding(.horizontal, 24)
            .multilineTextAlignment(.center)
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityAddTraits(.isStaticText)
    }
}

/// A pulsing dot and a status line ("Planning the lesson…").
struct ReasoningLine: View {
    let text: String
    @State private var on = false
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(DilTheme.accent).frame(width: 7, height: 7).scaleEffect(on ? 0.75 : 1).opacity(on ? 0.35 : 1)
            Text(text).font(.system(size: 13)).foregroundStyle(DilTheme.ink2).lineLimit(2)
        }
        .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { on = true } }
        .accessibilityElement(children: .combine)
    }
}

struct SkeletonLines: View {
    @State private var dim = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            RoundedRectangle(cornerRadius: 6).frame(height: 30).frame(maxWidth: 240)
                .padding(.bottom, 8)
            ForEach([1.0, 0.92, 0.84, 0.6], id: \.self) { w in
                RoundedRectangle(cornerRadius: 4).frame(height: 12).frame(maxWidth: .infinity).scaleEffect(x: w, anchor: .leading)
            }
        }
        .foregroundStyle(DilTheme.surface3)
        .opacity(dim ? 0.55 : 1)
        .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { dim = true } }
        .accessibilityHidden(true)
    }
}

struct TypingDots: View {
    @State private var phase = 0
    let timer = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3) { i in Circle().fill(DilTheme.ink3).frame(width: 6, height: 6).opacity(phase == i ? 1 : 0.35) }
        }
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
        .accessibilityLabel("Typing")
    }
}

/// Chips that wrap onto several lines.
struct ChipFlow<Item: Hashable, Label: View>: View {
    let items: [Item]
    var spacing: CGFloat = 8
    @ViewBuilder let label: (Item) -> Label
    var body: some View {
        FlexLayout(row: true, gap: spacing, align: .start, wrap: true, fillsWidth: true) {
            ForEach(items, id: \.self) { label($0) }
        }
    }
}

struct Chip: View {
    let text: String
    var icon: String? = nil
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { Image(systemName: icon).font(.system(size: 12)).foregroundStyle(DilTheme.ink3) }
                Text(text).lineLimit(2).multilineTextAlignment(.leading)
            }
            .font(.system(size: 13))
            .foregroundStyle(DilTheme.ink)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 999).fill(DilTheme.surface))
            .overlay(RoundedRectangle(cornerRadius: 999).strokeBorder(DilTheme.controlBorder))
        }
        .buttonStyle(PressFeedbackStyle())
    }
}

/// "Wonder needs its server" — shown when /api/status cannot be reached.
struct ServerBanner: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        if app.serverReachable == false {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(DilTheme.warning)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Can’t reach the Wonder server").font(.system(size: 14, weight: .semibold))
                    Text("Start it on your Mac with npm run dev in genui-lab/wonder, or set its address in You → Server.")
                        .font(.system(size: 13)).foregroundStyle(DilTheme.ink2)
                }
                Spacer(minLength: 0)
                Button("Retry") { Task { await app.loadStatus() } }.buttonStyle(.secondary)
            }
            .card(padding: 12)
        } else if app.status?.mode == "demo" {
            HStack(spacing: 8) {
                Image(systemName: "info.circle").foregroundStyle(DilTheme.accent)
                Text("Demo mode: the server has no Claude credentials, so lessons are pre-written.").font(.system(size: 13)).foregroundStyle(DilTheme.ink2)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(DilTheme.brandSubtle))
        }
    }
}

extension Date {
    static func iso(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}
