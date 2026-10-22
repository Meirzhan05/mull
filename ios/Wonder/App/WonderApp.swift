import SwiftUI

@main
struct WonderApp: App {
    @State private var app = AppModel.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .task { await app.loadStatus() }
                .onChange(of: phase) { _, p in if p != .active { app.core.flush() } }
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var app = app
        TabView(selection: $app.tab) {
            stack(.today) { TodayView() }
                .tabItem { Label("Today", systemImage: "sun.max") }.tag(Tab.today)
            stack(.library) { LibraryView() }
                .tabItem { Label("Library", systemImage: "books.vertical") }.tag(Tab.library)
            stack(.review) { ReviewView(lessonId: nil) }
                .tabItem { Label("Review", systemImage: "rectangle.stack") }.tag(Tab.review)
                .badge(dueBadge)
            stack(.teacher) { TeacherView() }
                .tabItem { Label("Teacher", systemImage: "graduationcap") }.tag(Tab.teacher)
            stack(.you) { YouView() }
                .tabItem { Label("You", systemImage: "person.crop.circle") }.tag(Tab.you)
        }
        .tint(DilTheme.accent)
        .overlay(alignment: .top) {
            if let t = app.toast { ToastView(text: t).padding(.top, 6).allowsHitTesting(false) }
        }
    }

    private var dueBadge: Int {
        _ = app.core.revision
        return app.core.get("deckStats")["due"].int ?? 0
    }

    private func stack<V: View>(_ tab: Tab, @ViewBuilder _ content: () -> V) -> some View {
        NavigationStack(path: app.path(tab)) {
            content()
                .navigationDestination(for: Route.self) { r in
                    switch r {
                    case .lesson(let id): LessonView(lessonId: id)
                    case .course(let id): CourseView(courseId: id)
                    case .reviewLesson(let id): ReviewView(lessonId: id)
                    }
                }
        }
    }
}
