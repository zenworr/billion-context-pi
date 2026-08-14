import type { SearchAlgorithm, SearchDoc, ScoredBlock } from "../types.js";
import { hybridAlgorithm } from "./hybrid.js";

const PATH_QUERY = /(?:\.?\.?\/)?(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|cs|cpp|c|h|json|ya?ml|toml|md)\b/gu;
const SYMBOL_QUERY = /\b(?:[A-Z][A-Za-z0-9_$]{2,}|[a-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+|[a-z_$][A-Za-z0-9_$]*\(\))/gu;
const ERROR_TEXT_QUERY = /\b(?:error|exception|failed|failure|panic|fatal)\b[^\n]*/giu;
const ERROR_CODE_QUERY = /\b(?:ERR_[A-Z0-9_]+|E[A-Z]{2,}|HTTP\s+[45]\d\d)\b/gu;

export const contextAwareAlgorithm: SearchAlgorithm = {
    name: "context-aware",
    description: "Hybrid lexical ranking with exact path, symbol, and error-string boosts.",
    score(docs: SearchDoc[], query: string): ScoredBlock[] {
        const base = new Map(hybridAlgorithm.score(docs, query).map((item) => [item.ref, item.score]));
        const paths = matches(query, PATH_QUERY);
        const symbols = matches(query, SYMBOL_QUERY);
        const errors = [...matches(query, ERROR_TEXT_QUERY), ...matches(query, ERROR_CODE_QUERY)];
        const exact = query.trim().toLowerCase();
        return docs.map((doc) => {
            const text = doc.text.toLowerCase();
            let score = base.get(doc.ref) ?? 0;
            score += coverage(text, paths) * 0.9;
            score += coverage(text, symbols) * 0.55;
            score += coverage(text, errors) * 1.2;
            if (exact.length >= 8 && text.includes(exact)) score += 1.5;
            return { ref: doc.ref, score };
        });
    },
};

function matches(query: string, expression: RegExp): string[] {
    expression.lastIndex = 0;
    return [...query.matchAll(expression)]
        .map((match) => match[0].trim().replace(/^["'`(]+|["'`)]+$/g, "").replace(/[()]/g, "").toLowerCase())
        .filter((value, index, values) => value.length > 1 && values.indexOf(value) === index);
}

function coverage(text: string, values: string[]): number {
    if (values.length === 0) return 0;
    return values.filter((value) => text.includes(value)).length / values.length;
}
