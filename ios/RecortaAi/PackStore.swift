import Foundation

/// Guarda cada pacote como um arquivo JSON dentro do app
/// (Application Support/packs/<id>.json).
final class PackStore {
    private let dir: URL

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("packs", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    /// Só letras, números, "_" e "-" no nome do arquivo.
    private func file(for id: String) -> URL? {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        guard !id.isEmpty, id.count <= 64, id.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        return dir.appendingPathComponent(id).appendingPathExtension("json")
    }

    func list() -> [String] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? String(contentsOf: $0, encoding: .utf8) }
    }

    func save(id: String, json: String) -> Bool {
        guard let url = file(for: id) else { return false }
        do {
            try json.write(to: url, atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    func delete(id: String) -> Bool {
        guard let url = file(for: id) else { return false }
        try? FileManager.default.removeItem(at: url)
        return true
    }
}
