import Foundation

@objc public final class SampleSwiftGreeter: NSObject {
    @objc public func greet(_ name: String) -> String {
        SampleGreeter().greet(name) + " from Swift"
    }

    /// Expands #file, which is an absolute path unless ConciseMagicFile is enabled.
    @objc public func sourceFile() -> String {
        "\(#file)"
    }
}
