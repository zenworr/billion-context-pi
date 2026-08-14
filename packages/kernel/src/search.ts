/**
 * Search — re-exports from the modular src/search/ implementation.
 */
export { searchBlocks, searchBlocksAsync, blockDocs, messageDocs, artifactDocs } from "./search/index.js";
export type {
    SearchResult,
    SearchOptions,
    SearchAlgorithm,
    AsyncSearchAlgorithm,
    AnySearchAlgorithm,
    SearchDoc,
    SearchDocKind,
    ScoredBlock,
    MessageRole,
    RoleWeights,
    MessageInput,
    ArtifactInput,
} from "./search/types.js";
export { DEFAULT_ALGORITHM, DEFAULT_ROLE_WEIGHTS } from "./search/types.js";
export { createSemanticAlgorithm } from "./search/algorithms/semantic.js";
export type { EmbedFn, SemanticOptions } from "./search/algorithms/semantic.js";
export { registerSearchAlgorithm, getSearchAlgorithm, listSearchAlgorithms } from "./search/registry.js";
