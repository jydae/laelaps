import Foundation
import Logging

actor AnalysisQueue {

    private static let debounce: Duration = .seconds(5)

    private static let retries = 4
    private static let retryDelay: Duration = .seconds(60)

    private static let retrySpread = 20_000

    private let elastic: ElasticClient
    private let logger: Logger

    private var armed: [String: Task<Void, Never>] = [:]

    private var attempts: [String: Int] = [:]

    init(elastic: ElasticClient, logger: Logger) {
        self.elastic = elastic
        self.logger = logger
    }

    func arm(_ dbId: String) {
        arm(dbId, after: Self.debounce)
    }

    func disarm(_ dbId: String) {
        armed.removeValue(forKey: dbId)?.cancel()
        attempts.removeValue(forKey: dbId)
    }

    func settle(_ dbId: String) async throws -> Passes.Outcome {
        disarm(dbId)
        let outcome = try await DatabaseStore.analyze(elastic, dbId: dbId, logger: logger)
        attempts.removeValue(forKey: dbId)
        return outcome
    }

    func recover() async {
        let owed: [String]
        do {
            owed = try await DatabaseStore.unsettled(elastic)
        } catch {
            logger.warning("Ingest: unanalysed databases could not be looked for: \(failureReason(error))")
            return
        }
        guard !owed.isEmpty else { return }
        logger.info("Ingest: \(owed.count) database(s) were left unanalysed; analysing them now")
        for dbId in owed where armed[dbId] == nil {
            await run(dbId)
        }
    }

    private func arm(_ dbId: String, after delay: Duration) {
        armed[dbId]?.cancel()
        armed[dbId] = Task {
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self.fire(dbId)
        }
    }

    private func fire(_ dbId: String) async {
        armed.removeValue(forKey: dbId)
        await run(dbId)
    }

    private func run(_ dbId: String) async {
        do {
            let outcome = try await DatabaseStore.analyze(elastic, dbId: dbId, logger: logger)
            attempts.removeValue(forKey: dbId)
            logger.info("Ingest: [\(dbId)] analysed: \(outcome.tierZero) Tier Zero objects")
        } catch {
            let tried = (attempts[dbId] ?? 0) + 1
            logger.error("Ingest: [\(dbId)] analysis failed (attempt \(tried)): \(failureReason(error))")
            if tried < Self.retries {
                attempts[dbId] = tried
                arm(dbId, after: Self.retryDelay * tried
                    + .milliseconds(Int.random(in: 0..<Self.retrySpread)))
            } else {
                attempts.removeValue(forKey: dbId)
            }
        }
    }
}
