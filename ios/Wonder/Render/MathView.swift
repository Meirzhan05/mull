import SwiftUI
import WebKit

/// Display math, typeset by the same KaTeX build the web uses (bundled in Resources/KaTeX),
/// in a small non-scrolling web view sized to the formula. Inline math stays native text
/// (TeX.unicode) so paragraphs keep wrapping as one run.
struct MathView: View {
    let latex: String
    var display = true
    var fontSize: CGFloat = 18
    @State private var height: CGFloat = 36
    @State private var failed = false

    var body: some View {
        if failed {
            Text(TeX.unicode(latex)).font(.system(size: fontSize, design: .serif)).italic()
        } else {
            KaTeXView(latex: latex, display: display, fontSize: fontSize, height: $height, failed: $failed)
                .frame(height: height)
                .accessibilityLabel(Text(TeX.unicode(latex)))
        }
    }
}

private struct KaTeXView: UIViewRepresentable {
    let latex: String
    let display: Bool
    let fontSize: CGFloat
    @Binding var height: CGFloat
    @Binding var failed: Bool

    static let page: String? = {
        guard let js = Bundle.main.url(forResource: "katex.min", withExtension: "js").flatMap({ try? String(contentsOf: $0, encoding: .utf8) }),
              var css = Bundle.main.url(forResource: "katex.min", withExtension: "css").flatMap({ try? String(contentsOf: $0, encoding: .utf8) }) else { return nil }
        // the bundle keeps the fonts next to the stylesheet
        css = css.replacingOccurrences(of: "url(fonts/", with: "url(")
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>\(css)
        :root { color-scheme: light dark; }
        html, body { margin: 0; padding: 0; background: transparent; color: #171717; -webkit-text-size-adjust: none; }
        @media (prefers-color-scheme: dark) { html, body { color: #EDEDED; } }
        #m { overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
        .katex-display { margin: 0; }
        </style><script>\(js)</script></head>
        <body><div id="m"></div><script>
        function show(tex, display, size) {
          const m = document.getElementById('m');
          m.style.fontSize = size + 'px';
          try { katex.render(tex, m, { displayMode: display, throwOnError: true, output: 'html' }); }
          catch (e) { window.webkit.messageHandlers.math.postMessage({ failed: true }); return; }
          requestAnimationFrame(() => {
            // a formula wider than the column shrinks to fit (down to 60%); past that it scrolls
            const k = m.querySelector('.katex-display > .katex, .katex');
            const w = k ? k.scrollWidth : m.scrollWidth;
            if (w > m.clientWidth + 1) m.style.fontSize = Math.max(size * 0.6, size * m.clientWidth / w) + 'px';
            requestAnimationFrame(() => window.webkit.messageHandlers.math.postMessage({ height: Math.ceil(m.getBoundingClientRect().height) }));
          });
        }
        </script></body></html>
        """
    }()

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(context.coordinator, name: "math")
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false // #m scrolls sideways itself when a formula is still too wide
        web.scrollView.backgroundColor = .clear
        web.navigationDelegate = context.coordinator
        if let page = Self.page {
            web.loadHTMLString(page, baseURL: Bundle.main.resourceURL)
        } else {
            DispatchQueue.main.async { failed = true }
        }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loaded { context.coordinator.render(web) }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "math")
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: KaTeXView
        var loaded = false
        var lastKey = ""
        init(_ p: KaTeXView) { parent = p }

        func render(_ web: WKWebView) {
            let key = "\(parent.latex)|\(parent.display)|\(parent.fontSize)"
            guard key != lastKey else { return }
            lastKey = key
            let arg = JSON.string(parent.latex).jsonString
            web.evaluateJavaScript("show(\(arg), \(parent.display), \(Int(parent.fontSize)))")
        }

        func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
            loaded = true
            render(web)
        }

        // Only the bundled page itself loads; nothing navigates.
        func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.navigationType == .other ? .allow : .cancel)
        }

        func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any] else { return }
            if body["failed"] as? Bool == true { DispatchQueue.main.async { self.parent.failed = true }; return }
            if let h = body["height"] as? Double, h > 0 { DispatchQueue.main.async { self.parent.height = CGFloat(h) + 4 } }
        }
    }
}
