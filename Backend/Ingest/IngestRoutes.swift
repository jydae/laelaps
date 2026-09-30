import Foundation
import HTTPTypes
import Hummingbird
import Logging

enum IngestRoutes {
    static let batchSize = 5_000

    static let archiveExtensions: Set<String> = ["zip", "gz", "tgz", "tar", "7z", "rar"]

    private static let contentNames: [String: String] = [
        "zip": "Zip archive", "gz": "Gzip archive", "tgz": "Gzip archive",
        "tar": "Tar archive", "7z": "7-Zip archive", "rar": "RAR archive",
        "xml": "XML", "csv": "CSV", "sql": "SQL", "txt": "Plain text",
    ]

    static func detect(extension ext: String, json: JSONValue?) -> String {
        if ext == "json" {
            guard let json, let type = BloodHoundImport.recognize(json: json) else { return "JSON" }
            return "BloodHound dump (\(type))"
        }
        return contentNames[ext] ?? "Unknown"
    }

    static func fileExtension(_ fileName: String) -> String {

        fileName.contains(".")
            ? (fileName.split(separator: ".").last.map { String($0).lowercased() } ?? "") : ""
    }

    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient, logger: Logger, analysis: AnalysisQueue
    ) {
        router.post("api/ingest/database/:dbId/file/:fileName") { request, context -> IngestFileResponse in
            let dbId = try context.parameters.require("dbId", as: String.self)
            let project = try await Sessions.require(request).project

            try await DatabaseStore.claimable(elastic, dbId: dbId, project: project)
            let raw = try context.parameters.require("fileName", as: String.self)
            let fileName = raw.removingPercentEncoding ?? raw

            let name = request.uri.queryParameters["name"].map { String($0) }

            let buffer = try await request.body.collect(upTo: .max)
            let bytes = Array(buffer.readableBytesView)

            let outcome: IngestFileResponse
            do {
                outcome = try await Passes.gate.run(dbId) {
                    try await ingest(
                        elastic, logger: logger, dbId: dbId, project: project, fileName: fileName,
                        name: name, bytes: bytes)
                }
            } catch {

                if (error as? HTTPError)?.status != .badRequest { await analysis.arm(dbId) }
                throw error
            }

            if outcome.status != IngestReport.Status.ignored.rawValue {
                await analysis.arm(dbId)
            }
            return outcome
        }

        router.get("api/ingest/databases") { request, _ -> [DatabaseDTO] in
            try await DatabaseStore.list(elastic, project: try await Sessions.require(request).project)
        }

        router.get("api/ingest/database/:dbId") { request, context -> DatabaseDetailDTO in
            try await DatabaseStore.detail(elastic, dbId: try await DatabaseStore.owned(elastic, request, context))
        }

        router.post("api/ingest/database/:dbId/analyze") { request, context -> IngestAnalyzeResponse in
            let dbId = try await DatabaseStore.owned(elastic, request, context)
            let outcome = try await analysis.settle(dbId)
            return IngestAnalyzeResponse(
                tierZeroCount: outcome.tierZero, baseCount: outcome.baseStubs,
                derivedEdgeCount: outcome.derivedEdges, tierZeroSettled: outcome.tierZeroSettled)
        }

        router.get("api/ingest/merge-candidates") { request, _ -> [MergePairDTO] in
            try await Merge.candidates(elastic, project: try await Sessions.require(request).project)
        }

        router.post("api/ingest/merge") { request, _ -> DatabaseDTO in
            let project = try await Sessions.require(request).project
            let buffer = try await request.body.collect(upTo: 64 * 1024)
            let body = try JSONValue.parse(Array(buffer.readableBytesView))
            return try await Merge.create(
                elastic, project: project,
                sources: (body["sources"]?.array ?? []).compactMap(\.string),
                name: body["name"]?.string, logger: logger)
        }

        router.delete("api/ingest/database/:dbId") { request, context -> HTTPResponse.Status in
            let dbId = try await DatabaseStore.owned(elastic, request, context)

            await analysis.disarm(dbId)
            try await DatabaseStore.delete(elastic, dbId: dbId, logger: logger)

            return .noContent
        }
    }

    static func ingest(
        _ elastic: ElasticClient, logger: Logger, dbId: String, project: String,
        fileName: String, name: String?, bytes: [UInt8]
    ) async throws -> IngestFileResponse {

        try await DatabaseStore.claimable(elastic, dbId: dbId, project: project)
        let ext = fileExtension(fileName)
        let json = ext == "json" ? try? JSONValue.parse(bytes) : nil
        let contentType = detect(extension: ext, json: json)

        func refuse(_ status: IngestReport.Status, _ reason: String, declared: Int? = nil,
                    version: Int? = nil, methods: Int? = nil) async throws {
            try await DatabaseStore.record(
                elastic, dbId: dbId, project: project, fileName: fileName, name: name, indexed: false,
                row: .init(name: fileName, fileExtension: ext, contentType: contentType,
                           status: status, declared: declared, bytes: bytes.count, note: reason,
                           version: version, methods: methods))
        }

        if archiveExtensions.contains(ext) {
            let reason = ext == "zip"
                ? "A zip is expanded in the console before upload; this route takes the .json files inside it."
                : "Archives are not read. Unpack it and upload the .json files inside."
            try await refuse(.rejected, reason)
            throw HTTPError(.badRequest, message: reason)
        }

        guard let json, let envelope = BloodHoundImport.envelope(of: json) else {
            let reason = "Not SharpHound output: no BloodHound envelope, nothing was ingested."
            try await refuse(.ignored, reason)
            return IngestFileResponse(
                nodesIndexed: 0, status: IngestReport.Status.ignored.rawValue,
                present: 0, skipped: 0, note: reason)
        }

        guard let kind = ADNodeKind(bloodHoundType: envelope.type) else {
            let reason = "Unsupported dump type '\(envelope.type)'. No objects were ingested."
            try await refuse(.rejected, reason, declared: envelope.declared,
                             version: envelope.version, methods: envelope.methods)
            throw HTTPError(.badRequest, message: reason)
        }

        let parsed = BloodHoundImport.parse(
            kind: kind, json: json, database: dbId, declared: envelope.declared)
        do {
            try await elastic.bulk(parsed.nodes, batch: batchSize)
            try await elastic.bulk(parsed.edges, batch: batchSize)
            try await elastic.refresh(Indices.nodes, Indices.edges)
        } catch {
            logger.error("Ingest: write failed for '\(fileName)': \(error)")
            throw HTTPError(.internalServerError, message: "Elasticsearch write failed: \(error)")
        }

        let (status, note) = IngestReport.reconcile(parsed)
        try await DatabaseStore.record(
            elastic, dbId: dbId, project: project, fileName: fileName, name: name, domain: parsed.domain,
            row: .init(name: fileName, fileExtension: ext, contentType: contentType,
                       status: status, declared: parsed.declared, present: parsed.present,
                       nodes: parsed.nodes.count, edges: parsed.edges.count,
                       skipped: parsed.skipped, merged: parsed.merged,
                       edgesFolded: parsed.edgesFolded, bytes: bytes.count, note: note,
                       version: envelope.version, methods: envelope.methods))

        if let note { logger.warning("Ingest: [\(dbId)] '\(fileName)': \(note)") }
        return IngestFileResponse(

            nodesIndexed: parsed.nodes.count, status: status.rawValue,
            present: parsed.present, skipped: parsed.skipped, note: note)
    }
}
