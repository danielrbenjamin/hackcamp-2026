import AppIntents
import Foundation

struct NavigateWithLantern: AppIntent {
  static let title: LocalizedStringResource = "Navigate with Lantern"
  static let openAppWhenRun = true

  @Parameter(title: "Destination", requestValueDialog: "Where do you want to go?")
  var destination: String

  static var parameterSummary: some ParameterSummary {
    Summary("Navigate to \(\.$destination) with Lantern")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    let query = destination.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { throw $destination.needsValueError("Where do you want to go?") }
    UserDefaults.standard.set(
      ["query": query, "time": Date().timeIntervalSince1970],
      forKey: "lantern.siri.destination"
    )
    NotificationCenter.default.post(name: Notification.Name("lantern.siri.destination"), object: nil)
    return .result()
  }
}

struct LanternShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: NavigateWithLantern(),
      phrases: ["Navigate with \(.applicationName)", "Start a walking route with \(.applicationName)"],
      shortTitle: "Navigate",
      systemImageName: "figure.walk"
    )
  }
}
