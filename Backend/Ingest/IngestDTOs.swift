import Hummingbird

struct IngestFileResponse: ResponseEncodable {
    let nodesIndexed: Int

    let status: String
    let present: Int
    let skipped: Int
    let note: String?
}

struct IngestAnalyzeResponse: ResponseEncodable {
    let tierZeroCount: Int
    let baseCount: Int
    let derivedEdgeCount: Int

    let tierZeroSettled: Bool
}

struct DomainRefDTO: ResponseEncodable {
    let id: String
    let label: String
}

struct DatabaseDTO: ResponseEncodable {
    static let sourceFields = [
        "id", "name", "created", "updated", "files", "fileCount",
        "nodeCount", "edgeCount", "byteCount", "tierZeroCount", "declaredCount",
        "skippedCount", "mergedCount", "baseCount", "derivedEdgeCount", "sources",
        "analyzed", "analysisError", "census",
    ]

    let id: String
    let name: String
    let created: String

    let updated: String
    let files: [String]
    let fileCount: Int
    let nodeCount: Int
    let edgeCount: Int
    let byteCount: Int
    let tierZeroCount: Int
    let declaredCount: Int
    let skippedCount: Int
    let mergedCount: Int
    let baseCount: Int
    let derivedEdgeCount: Int

    let analyzed: Bool

    var analysisError: String? = nil

    let sources: [String]

    let domains: [DomainRefDTO]
}

struct MergePairDTO: ResponseEncodable {
    let a: String
    let aName: String
    let b: String
    let bName: String

    let resolves: Int

    let overlapping: Bool
}
