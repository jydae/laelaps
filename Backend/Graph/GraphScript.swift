import Foundation
import Hummingbird

enum GraphScript {

    struct Failure: Error {
        let column: Int
        let message: String

        var wants: Want? = nil

        var line: String { "col \(column): \(message)" }
    }

    enum Want: String {
        case kind = "a kind, or the word objects"
        case field = "a field name"
        case edgeKind = "an edge kind"
        case name = "a name"
        case value = "a value"
        case hops = "a number of hops"
        case duration = "a duration such as 180d"
        case show = "paths, objects or count"
    }

    struct Token {
        let text: String

        let lower: String
        let quoted: Bool
        let column: Int
    }

    private static let bareExtra = Set("._-*:\\$@{}/")
    private static let punctuation = Set("(),")

    static func tokens(_ source: String) throws -> [Token] {
        var out: [Token] = []
        let chars = Array(source)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c.isWhitespace { i += 1; continue }
            let column = i + 1

            if c == "\"" || c == "'" {
                let quote = c
                var text = ""
                i += 1
                while i < chars.count, chars[i] != quote { text.append(chars[i]); i += 1 }
                guard i < chars.count else {
                    throw Failure(column: column, message: "unclosed quote")
                }
                i += 1
                out.append(Token(text: text, lower: text.lowercased(), quoted: true, column: column))
                continue
            }

            if punctuation.contains(c) {
                i += 1
                out.append(Token(text: String(c), lower: String(c), quoted: false, column: column))
                continue
            }

            if c == "=" || c == "!" || c == ">" || c == "<" {
                var text = String(c)
                if i + 1 < chars.count, chars[i + 1] == "=" { text.append("="); i += 1 }
                i += 1
                guard text != "!" else {
                    throw Failure(column: column, message: "expected != here")
                }
                out.append(Token(text: text, lower: text, quoted: false, column: column))
                continue
            }

            var text = ""
            while i < chars.count {
                let w = chars[i]
                guard w.isLetter || w.isNumber || bareExtra.contains(w) else { break }
                text.append(w)
                i += 1
            }
            guard !text.isEmpty else {
                throw Failure(column: column, message: "unexpected character \(c)")
            }
            out.append(Token(text: text, lower: text.lowercased(), quoted: false, column: column))
        }
        return out
    }

    enum Verb: String, CaseIterable { case find, path, reach }
    enum Show: String, CaseIterable { case paths, objects, count }

    struct Plan: Sendable {
        let verb: Verb
        let from: [JSONValue]
        let to: [JSONValue]

        let kinds: [String]?
        let hops: Int
        let show: Show
    }

    indirect enum Expression: Sendable {
        case one(Plan)
        case combine(Expression, Operation, Expression)

        enum Operation: String, Sendable, CaseIterable {

            case plus

            case minus

            case shared
        }
    }

    static let maxHops = 10

    static let toolFields: [String: String] = [
        "id": "id", "kind": "kind", "label": "label.keyword", "owned": "owned",
        "chokevalue": "chokeValue",
        "tierzero": "tierZero", "tierzeroseed": "tierZeroSeed",

        "zonetier": "zoneTier", "zonetierinferred": "zoneTierInferred",
    ]

    private static func field(_ name: String) -> (path: String, flattened: Bool) {
        if let mapped = toolFields[name.lowercased()] { return (mapped, false) }
        return ("props.\(name.lowercased())", true)
    }

    private static func all(_ clauses: [JSONValue]) -> JSONValue {
        clauses.count == 1 ? clauses[0] : ["bool": ["must": .array(clauses)]]
    }

    private static func any(_ clauses: [JSONValue]) -> JSONValue {
        clauses.count == 1
            ? clauses[0]
            : ["bool": ["should": .array(clauses), "minimum_should_match": 1]]
    }

    private static func none(_ clause: JSONValue) -> JSONValue {
        ["bool": ["must_not": clause]]
    }

    private static func exists(_ name: String) -> JSONValue {
        ["exists": ["field": .string(field(name).path)]]
    }

    private static func term(_ name: String, _ value: String) -> JSONValue {
        let (path, flattened) = field(name)
        guard !flattened else { return ["term": [path: .string(value)]] }
        if path == "kind" {
            return ["term": ["kind": .string(ADNodeKind.matching(value)?.rawValue ?? value)]]
        }
        let lowered = value.lowercased()
        if lowered == "true" || lowered == "false" {
            return ["term": [path: .bool(lowered == "true")]]
        }
        return ["term": [path: .string(value)]]
    }

    private static let rangeKeys = ["<": "lt", "<=": "lte", ">": "gt", ">=": "gte"]

    private static func bounded(_ name: String, _ key: String, _ value: String) -> JSONValue {
        let (path, flattened) = field(name)
        var bounds: [String: JSONValue] = [key: .string(value)]
        if flattened {
            let lower = key == "gt" || key == "gte"
            bounds[lower ? "lte" : "gte"] = .string(lower ? "\u{10FFFF}" : "")
        }
        return ["range": [path: .object(bounds)]]
    }

    private static func range(_ name: String, _ op: String, _ value: String) -> JSONValue {
        bounded(name, rangeKeys[op] ?? "gt", value)
    }

    private static func older(_ name: String, days: Int) -> JSONValue {
        let cutoff = Int(Date().timeIntervalSince1970) - days * 86_400
        return ["bool": [
            "should": .array([
                bounded(name, "lt", String(cutoff)),
                .object(["bool": .object(["must_not": .object(["exists": .object(["field": .string(field(name).path)])])])]),
            ]),
            "minimum_should_match": 1,
        ]]
    }

    private static let closers: Set<String> = ["to", "via", "within", "show", ")",
                                               "plus", "minus", "shared"]

    private static let composers: Set<String> = ["plus", "minus", "shared", ")"]

    private static let conditionHeads: Set<String> =
        ["with", "where", "named", "tier", "owned", "not", "("]

    private static let notAValue: Set<String> =
        closers.union(["(", ",", "=", "!=", ">", ">=", "<", "<="])

    private struct Parser {
        let tokens: [Token]

        let end: Int
        var at = 0

        var depth = 0

        init(_ tokens: [Token], source: String) {
            self.tokens = tokens
            self.end = max(1, source.count + 1)
        }

        var peek: Token? { at < tokens.count ? tokens[at] : nil }
        var column: Int { peek?.column ?? end }

        func word(_ text: String) -> Bool {
            guard let token = peek, !token.quoted else { return false }
            return token.lower == text
        }

        mutating func skip() { at += 1 }

        mutating func match(_ text: String) -> Bool {
            guard word(text) else { return false }
            at += 1
            return true
        }

        mutating func value(_ what: Want) throws -> Token {
            guard let token = peek, token.quoted || !GraphScript.notAValue.contains(token.lower) else {
                throw fail(what)
            }
            at += 1
            return token
        }

        func fail(_ message: String) -> Failure {
            Failure(column: column, message: message)
        }
        func fail(_ want: Want) -> Failure {
            Failure(column: column, message: "expected \(want.rawValue)", wants: want)
        }
    }

    static func parse(_ source: String) throws -> Expression {
        var parser = Parser(try tokens(source), source: source)
        let expression = try composition(&parser)
        guard let stray = parser.peek else { return expression }
        throw Failure(column: stray.column, message: "expected plus, minus, shared with, or the end")
    }

    private static func composition(_ parser: inout Parser) throws -> Expression {
        var left = try term(&parser)
        while let token = parser.peek, !token.quoted {
            let operation: Expression.Operation
            if parser.match("plus") {
                operation = .plus
            } else if parser.match("minus") {
                operation = .minus
            } else if parser.match("shared") {
                guard parser.match("with") else { throw parser.fail("expected with, after shared") }
                operation = .shared
            } else {
                break
            }
            left = .combine(left, operation, try term(&parser))
        }
        return left
    }

    private static func term(_ parser: inout Parser) throws -> Expression {
        guard parser.match("(") else { return .one(try sentence(&parser)) }
        parser.depth += 1
        defer { parser.depth -= 1 }
        guard parser.depth <= maxDepth else { throw parser.fail("nested too deeply") }
        let inner = try composition(&parser)
        guard parser.match(")") else { throw parser.fail("expected )") }
        return inner
    }

    private static func sentence(_ parser: inout Parser) throws -> Plan {
        guard let head = parser.peek, !head.quoted, let verb = Verb(rawValue: head.lower) else {
            throw parser.fail("expected find, path or reach")
        }
        parser.skip()

        let from = try selection(&parser)
        var to: [JSONValue] = []
        if verb == .path {
            guard parser.match("to") else { throw parser.fail("expected to") }
            to = try selection(&parser)
        }

        var kinds: [String]?
        var hops: Int?
        var show: Show?
        while let token = parser.peek {
            if parser.match("via") {
                guard kinds == nil else { throw Failure(column: token.column, message: "via given twice") }
                kinds = try edgeKinds(&parser)
            } else if parser.match("within") {
                guard hops == nil else { throw Failure(column: token.column, message: "within given twice") }
                let value = try parser.value(.hops)
                guard let n = Int(value.text), n >= 1, n <= maxHops else {
                    throw Failure(column: value.column, message: "within takes 1 to \(maxHops)")
                }
                hops = n
            } else if parser.match("show") {
                guard show == nil else { throw Failure(column: token.column, message: "show given twice") }
                let value = try parser.value(.show)
                guard let chosen = Show(rawValue: value.lower), !value.quoted else {
                    throw Failure(column: value.column, message: "show takes paths, objects or count")
                }
                show = chosen
            } else if composers.contains(token.lower), !token.quoted {

                break
            } else {
                throw Failure(column: token.column, message: "expected via, within or show")
            }
        }

        let walk = verb != .find
        return Plan(
            verb: verb, from: from, to: to,
            kinds: kinds ?? (walk ? GraphTraversal.escalationEdges : nil),
            hops: hops ?? (verb == .path ? 6 : 4),
            show: show ?? (verb == .find && kinds == nil ? .objects : .paths))
    }

    static func clauses(_ source: String) throws -> [JSONValue] {
        var parser = Parser(try tokens(source), source: source)
        guard parser.peek != nil else { return [] }
        let clause = try disjunction(&parser)
        guard let stray = parser.peek else { return [clause] }
        throw Failure(column: stray.column, message: "expected and, or, or the end")
    }

    private static func edgeKinds(_ parser: inout Parser) throws -> [String] {
        var out: [String] = []
        repeat {
            let token = try parser.value(.edgeKind)
            if !token.quoted, token.lower == "escalation" {
                out += GraphTraversal.escalationEdges
            } else if !token.quoted, token.lower == "any" {
                return []
            } else if let kind = ADEdgeKind.allCases.first(where: { $0.rawValue.lowercased() == token.lower }) {
                out.append(kind.rawValue)
            } else {
                throw Failure(column: token.column, message: "\(token.text) is not an edge kind")
            }
        } while parser.match(",")
        return out
    }

    private static func selection(_ parser: inout Parser) throws -> [JSONValue] {
        guard let head = parser.peek, !head.quoted else {
            throw parser.fail(.kind)
        }
        var must: [JSONValue] = []
        if head.lower == "objects" {
            parser.skip()
        } else if let kind = ADNodeKind.matching(head.lower) {
            parser.skip()
            must.append(["term": ["kind": .string(kind.rawValue)]])
        } else {
            throw Failure(column: head.column, message: "\(head.text) is not a kind")
        }

        guard let next = parser.peek, !closers.contains(next.lower) else { return must }
        must.append(try disjunction(&parser))
        return must
    }

    private static func disjunction(_ parser: inout Parser) throws -> JSONValue {
        var parts = [try conjunction(&parser)]
        while parser.match("or") { parts.append(try conjunction(&parser)) }
        return any(parts)
    }

    private static func conjunction(_ parser: inout Parser) throws -> JSONValue {
        var parts = [try unary(&parser)]
        while parser.match("and") { parts.append(try unary(&parser)) }
        return all(parts)
    }

    private static let maxDepth = 64

    private static func unary(_ parser: inout Parser) throws -> JSONValue {
        parser.depth += 1
        defer { parser.depth -= 1 }
        guard parser.depth <= maxDepth else { throw parser.fail("nested too deeply") }

        if parser.word("not") {
            let after = parser.at + 1
            let following = after < parser.tokens.count ? parser.tokens[after] : nil
            let negation = following.map { !$0.quoted && conditionHeads.contains($0.lower) } ?? false
            if negation {
                parser.skip()
                return none(try unary(&parser))
            }
        }
        if parser.match("(") {
            let inner = try disjunction(&parser)
            guard parser.match(")") else { throw parser.fail("expected )") }
            return inner
        }
        return try condition(&parser)
    }

    private static func condition(_ parser: inout Parser) throws -> JSONValue {
        guard let head = parser.peek, !head.quoted else {
            throw parser.fail("expected a condition")
        }
        switch head.lower {
        case "with":
            parser.skip()
            let name = try parser.value(.field)
            return exists(name.text)
        case "not":
            parser.skip()
            let name = try parser.value(.field)
            return none(exists(name.text))
        case "named":
            parser.skip()
            let name = try parser.value(.name)

            return GraphStore.nameMatch(name.text)
        case "owned":
            parser.skip()
            return ["term": ["owned": .bool(true)]]
        case "tier":
            parser.skip()
            guard parser.match("zero") else { throw parser.fail("expected zero") }

            return ["term": ["tierZeroSeed": .bool(true)]]
        case "where":
            parser.skip()
            return try predicate(&parser)
        default:
            throw Failure(column: head.column, message: "\(head.text) is not a condition")
        }
    }

    private static func predicate(_ parser: inout Parser) throws -> JSONValue {
        let name = try parser.value(.field)
        guard let op = parser.peek else { throw parser.fail("expected a comparison") }

        if !op.quoted, op.lower == "older" {
            parser.skip()
            guard parser.match("than") else { throw parser.fail("expected than") }
            let value = try parser.value(.duration)
            guard !value.quoted, let span = days(value.lower) else {
                throw Failure(column: value.column, message: "expected a duration such as 180d or 5y")
            }
            return older(name.text, days: span)
        }

        if !op.quoted, op.lower == "in" {
            parser.skip()
            guard parser.match("(") else { throw parser.fail("expected (") }
            var values: [Token] = []
            repeat { values.append(try parser.value(.value)) } while parser.match(",")
            guard parser.match(")") else { throw parser.fail("expected )") }

            let path = field(name.text).path
            return ["terms": [path: .strings(try values.map { try kindValue($0, path: path) })]]
        }

        guard !op.quoted, ["=", "!=", ">", ">=", "<", "<="].contains(op.lower) else {
            throw Failure(column: op.column, message: "expected =, !=, >, <, older than or in")
        }
        parser.skip()
        let value = try parser.value(.value)
        _ = try kindValue(value, path: field(name.text).path)
        switch op.lower {
        case "=": return term(name.text, value.text)

        case "!=": return none(term(name.text, value.text))
        default: return range(name.text, op.lower, value.text)
        }
    }

    private static func kindValue(_ value: Token, path: String) throws -> String {
        guard path == "kind" else { return value.text }
        guard let kind = ADNodeKind.matching(value.lower) else {
            throw Failure(column: value.column, message: "\(value.text) is not a kind")
        }
        return kind.rawValue
    }

    private static func days(_ text: String) -> Int? {
        guard let unit = text.last, let count = Int(text.dropLast()), (1...36_500).contains(count)
        else { return nil }
        switch unit {
        case "d": return count
        case "w": return count * 7
        case "m": return count * 30
        case "y": return count * 365
        default: return nil
        }
    }

    static func run(
        _ expression: Expression, _ client: ElasticClient, db: String?
    ) async throws -> GraphViewDTO {
        try await evaluate(expression, client, db: db).view
    }

    static func evaluate(
        _ expression: Expression, _ client: ElasticClient, db: String?
    ) async throws -> ObjectSet {
        switch expression {
        case .one(let plan):
            return ObjectSet(try await run(plan, client, db: db))
        case .combine(let left, let operation, let right):
            let a = try await evaluate(left, client, db: db)
            let b = try await evaluate(right, client, db: db)
            switch operation {
            case .plus: return a.union(b)
            case .minus: return a.subtracting(b)
            case .shared: return a.intersection(b)
            }
        }
    }

    static func run(
        _ plan: Plan, _ client: ElasticClient, db: String?
    ) async throws -> GraphViewDTO {
        switch plan.verb {
        case .find:

            if plan.show == .count, plan.kinds == nil {
                let total = try await client.count(
                    index: Indices.nodes, GraphStore.scoped(plan.from, db: db))
                return GraphViewDTO(nodes: [], links: [], total: total)
            }
            let matched = try await GraphTraversal.objects(client, db: db, clauses: plan.from)
            guard plan.kinds != nil || plan.show == .paths else {
                return project(GraphTraversal.listing(matched), plan.show)
            }
            return project(try await expand(client, db: db, matched: matched, plan: plan), plan.show)

        case .reach:
            let matched = try await GraphTraversal.objects(client, db: db, clauses: plan.from)
            let view = try await GraphTraversal.reachableInto(
                client, db: db, into: matched.rows.map(\.id),
                kinds: plan.kinds ?? [], maxHops: plan.hops)
            return project(view, plan.show)

        case .path:
            var view = project(try await walk(client, db: db, plan: plan), plan.show)
            view.flow = true
            return view
        }
    }

    private static func expand(
        _ client: ElasticClient, db: String?,
        matched: GraphTraversal.Matched, plan: Plan
    ) async throws -> GraphViewDTO {
        let ids = matched.rows.map(\.id)
        guard !ids.isEmpty else {
            return GraphViewDTO(nodes: [], links: [], total: matched.total)
        }
        var seen = Set(ids)
        var frontier = ids
        var edges: [GraphTraversal.Edge] = []
        let truncated = matched.rows.count < matched.total
        let among = plan.kinds == nil
        for _ in 0..<(among ? 1 : plan.hops) {
            let hopped = try await GraphTraversal.hop(
                client, db: db, frontier: frontier, outbound: true,
                kinds: plan.kinds ?? [], walking: !among)
            if among { edges = hopped.filter { seen.contains($0.target) }; break }
            edges += hopped
            let arrived = hopped.map(\.target).filter { seen.insert($0).inserted }
            guard !arrived.isEmpty else { break }
            frontier = arrived
        }

        return try await GraphTraversal.assemble(
            client, db: db, ids: Array(seen), edges: edges,
            total: matched.total, truncated: truncated)
    }

    private static func walk(
        _ client: ElasticClient, db: String?, plan: Plan
    ) async throws -> GraphViewDTO {
        let sources = try await GraphTraversal.objects(client, db: db, clauses: plan.from)
        let targets = try await GraphTraversal.objects(client, db: db, clauses: plan.to)
        let targetIds = Set(targets.rows.map(\.id))
        guard !sources.rows.isEmpty, !targetIds.isEmpty else {
            return GraphViewDTO(nodes: [], links: [])
        }

        var ids = Set<String>()
        var edges: [GraphTraversal.Edge] = []
        let truncated = sources.rows.count > ReachPaths.sourceLimit
        for source in sources.rows.prefix(ReachPaths.sourceLimit).map(\.id) {
            let found = try await GraphTraversal.reach(
                client, db: db, from: source, to: targetIds.subtracting([source]),
                kinds: plan.kinds ?? [], maxHops: plan.hops)
            for target in found.reached {

                let chain = found.chain(to: target, every: true)
                guard !chain.isEmpty else { continue }
                ids.insert(source)
                for edge in chain {
                    ids.insert(edge.source)
                    ids.insert(edge.target)
                    edges.append(edge)
                }
            }
        }

        return try await GraphTraversal.assemble(
            client, db: db, ids: Array(ids), edges: edges, truncated: truncated)
    }

    private static func project(_ view: GraphViewDTO, _ show: Show) -> GraphViewDTO {
        switch show {
        case .paths:
            return view
        case .objects:
            return GraphViewDTO(nodes: view.nodes, links: [], total: view.total,
                                counting: view.counting, truncated: view.truncated)
        case .count:
            return GraphViewDTO(nodes: [], links: [], total: view.total,
                                counting: view.counting)
        }
    }

    struct Completion: ResponseEncodable {

        let partial: String
        let options: [String]
    }

    private static let keywords: [String] =
        Verb.allCases.map(\.rawValue)
        + ["objects"] + ADNodeKind.allCases.map { $0.rawValue.lowercased() + "s" }
        + ["where", "with", "named", "tier", "zero", "owned", "not", "(", ")", "and", "or"]
        + ["=", "!=", ">", ">=", "<", "<=", "older", "than", "in"]
        + ["to", "via", "escalation", "within", "show"] + Show.allCases.map(\.rawValue)

        + ["plus", "minus", "shared", "with"]

    static func complete(
        _ source: String, _ client: ElasticClient, db: String?
    ) async throws -> Completion {
        var head = source, partial = ""
        if source.filter({ $0 == "\"" }).count % 2 == 1, let open = source.lastIndex(of: "\"") {

            partial = String(source[open...]).lowercased()
            head = String(source[..<open])
        } else if let last = try? tokens(source).last, !last.quoted,
                  last.column + last.text.count == source.count + 1 {
            partial = last.lower
            head = String(source.prefix(last.column - 1))
        }
        var wanted: Failure?
        do { _ = try parse(head) } catch let failure as Failure {
            guard failure.column > head.count else { return Completion(partial: partial, options: []) }
            wanted = failure
        }

        var options: [String]
        switch wanted?.wants {
        case .field:
            options = try await fields(client, db: db)
        case .edgeKind:

            options = ["any", "escalation"] + ADEdgeKind.allCases.map(\.rawValue)
        case .value:
            options = ["true", "false"]
        case .hops:
            options = (1...maxHops).map(String.init)
        case .duration:
            options = ["30d", "90d", "180d", "1y", "2y"]
        case .name:

            let typed = partial.hasPrefix("\"") ? String(partial.dropFirst()) : partial
            let hits = try await client.search(index: Indices.nodes, [
                "size": 8, "_source": ["id", "label", "labelAsserted", "kind"],
                "sort": GraphStore.typeAheadSort(relevant: true),
                "query": GraphStore.scoped([GraphStore.nameMatch(typed)], db: db),
            ])
            return Completion(partial: partial,
                              options: GraphStore.nodes(from: hits).map { "\"\($0.label)\"" })
        case .kind, .show, nil:

            let start = head.count + 2
            options = keywords.filter { word in
                do { _ = try parse(head + " " + word); return true }
                catch let failure as Failure { return failure.column > start }
                catch { return false }
            }
        }
        return Completion(partial: partial,
                          options: options.filter { $0.lowercased().hasPrefix(partial) })
    }

    private static func fields(_ client: ElasticClient, db: String?) async throws -> [String] {
        let hits = try await client.search(index: Indices.nodes, [
            "size": 0, "query": GraphStore.scoped([], db: db),
            "aggs": ["kinds": [
                "terms": ["field": "kind", "size": 32],
                "aggs": ["sample": ["top_hits": ["size": 5, "_source": ["props"]]]],
            ]],
        ])
        var keys = Set(toolFields.keys)
        for bucket in hits["aggregations"]?["kinds"]?["buckets"]?.array ?? [] {
            for hit in bucket["sample"]?["hits"]?["hits"]?.array ?? [] {
                keys.formUnion((hit["_source"]?["props"]?.object ?? [:]).keys.map { $0.lowercased() })
            }
        }
        return keys.sorted()
    }

    private static func scriptBody(_ request: Request, _ elastic: ElasticClient) async throws -> (script: String, db: String) {
        let buffer = try await request.body.collect(upTo: 64 * 1024)
        let body = try JSONValue.parse(Array(buffer.readableBytesView))
        let db = try await GraphRoutes.db(request, elastic, body["db"]?.string.flatMap { $0.isEmpty ? nil : $0 })
        return (body["script"]?.string ?? "", db)
    }

    static func addRoutes<Context: RequestContext>(
        to router: Router<Context>, elastic: ElasticClient
    ) {

        router.post("api/graph/script") { request, _ -> GraphViewDTO in
            let (source, db) = try await scriptBody(request, elastic)
            guard !source.trimmingCharacters(in: .whitespaces).isEmpty else {
                throw HTTPError(.badRequest, message: "col 1: expected find, path or reach")
            }
            do {
                return try await run(try parse(source), elastic, db: db)
            } catch let failure as Failure {
                throw HTTPError(.badRequest, message: failure.line)
            } catch ElasticError.request(let status, _) where status < 500 {

                throw HTTPError(.badRequest, message: "the index refused this query (\(status))")
            }
        }

        router.post("api/graph/complete") { request, _ -> Completion in
            let (source, db) = try await scriptBody(request, elastic)
            return try await complete(source, elastic, db: db)
        }
    }
}

struct ObjectSet: Sendable {

    struct Pair: Sendable {
        let source: String
        let target: String
        var kinds: [String]
    }

    private(set) var nodes: [GraphNodeDTO]
    private(set) var links: [Pair]

    let total: Int
    let truncated: Bool
    let counting: String

    let flow: Bool

    init(nodes: [GraphNodeDTO], links: [Pair], total: Int? = nil,
         truncated: Bool = false, counting: String = "objects", flow: Bool = false) {
        var seen = Set<String>()
        let unique = nodes.filter { seen.insert($0.id).inserted }
        self.nodes = unique
        self.links = ObjectSet.merged(links)
        self.total = total ?? unique.count
        self.truncated = truncated
        self.counting = counting
        self.flow = flow
    }

    init(_ view: GraphViewDTO) {
        let ids = view.nodes.map(\.id)
        let pairs: [Pair] = view.links.compactMap { link in
            guard link.source >= 0, link.source < ids.count,
                  link.target >= 0, link.target < ids.count else { return nil }
            return Pair(source: ids[link.source], target: ids[link.target], kinds: link.kinds)
        }
        self.init(nodes: view.nodes, links: pairs, total: view.total,
                  truncated: view.truncated, counting: view.counting, flow: view.flow)
    }

    var view: GraphViewDTO {
        let position = Dictionary(nodes.enumerated().map { ($1.id, $0) },
                                  uniquingKeysWith: { first, _ in first })
        let drawn: [GraphLinkDTO] = links.compactMap { pair in
            guard let i = position[pair.source], let j = position[pair.target], i != j else { return nil }
            return GraphLinkDTO(source: i, target: j, kinds: pair.kinds)
        }
        var out = GraphViewDTO(nodes: nodes, links: drawn, total: total,
                               counting: counting, truncated: truncated)
        out.flow = flow
        return out
    }

    func union(_ other: ObjectSet) -> ObjectSet {
        ObjectSet(nodes: nodes + other.nodes, links: links + other.links,
                  truncated: truncated || other.truncated,
                  counting: counting == other.counting ? counting : "objects",
                  flow: flow && other.flow)
    }

    func subtracting(_ other: ObjectSet) -> ObjectSet {
        let remove = Set(other.nodes.map(\.id))
        return ObjectSet(nodes: nodes.filter { !remove.contains($0.id) }, links: links,
                         truncated: truncated || other.truncated,
                         counting: counting, flow: flow)
    }

    func intersection(_ other: ObjectSet) -> ObjectSet {
        let keep = Set(other.nodes.map(\.id))
        return ObjectSet(nodes: nodes.filter { keep.contains($0.id) }, links: links + other.links,
                         truncated: truncated || other.truncated,
                         counting: counting == other.counting ? counting : "objects",
                         flow: flow && other.flow)
    }

    private static func merged(_ pairs: [Pair]) -> [Pair] {
        var order: [String] = []
        var byKey: [String: Pair] = [:]
        for pair in pairs {
            let key = "\(pair.source)\u{1}\(pair.target)"
            if var held = byKey[key] {
                for kind in pair.kinds where !held.kinds.contains(kind) { held.kinds.append(kind) }
                byKey[key] = held
            } else {
                order.append(key)
                byKey[key] = pair
            }
        }
        return order.compactMap { byKey[$0] }
    }
}
