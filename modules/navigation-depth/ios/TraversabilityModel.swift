import CoreML
import Foundation

final class TraversabilityModel {
  private var model: MLModel?
  private var version: String?

  func predict(_ cells: [Int]) throws -> [String: Any]? {
    guard cells.count == 800, cells.allSatisfy({ (0...2).contains($0) }) else { return nil }
    if model == nil {
      let bundle = Bundle(for: NavigationDepthModule.self)
      guard let resources = (bundle.url(forResource: "NavigationModels", withExtension: "bundle")
        ?? Bundle.main.url(forResource: "NavigationModels", withExtension: "bundle")).flatMap(Bundle.init(url:))
      else { return nil }
      let artifact = resources.url(forResource: "Traversability", withExtension: "mlmodelc")
      let package = resources.url(forResource: "Traversability", withExtension: "mlpackage")
      guard let artifact = try artifact ?? package.map({ try MLModel.compileModel(at: $0) }) else { return nil }
      let loaded = try MLModel(contentsOf: artifact)
      guard let revision = loaded.modelDescription.metadata[.versionString] as? String, !revision.isEmpty else { return nil }
      model = loaded
      version = revision
    }
    guard let model, let version else { return nil }
    let start = ProcessInfo.processInfo.systemUptime
    let input = try MLMultiArray(shape: [1, 1, 20, 40], dataType: .float32)
    for (index, value) in cells.enumerated() { input[index] = NSNumber(value: Float(value) / 2) }
    let features = try MLDictionaryFeatureProvider(dictionary: ["bev": MLFeatureValue(multiArray: input)])
    guard let output = try model.prediction(from: features).featureValue(for: "scores")?.multiArrayValue,
          output.count == 9 else { return nil }
    let scores = (0..<output.count).map { output[$0].doubleValue }
    guard scores.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { return nil }
    return ["version": version, "scores": scores,
            "latencyMs": (ProcessInfo.processInfo.systemUptime - start) * 1_000]
  }
}
