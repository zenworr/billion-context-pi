import { createHash } from "node:crypto";
import type {
  CompressionManifest,
  CoreMessage,
  ManifestCommand,
  ManifestContradiction,
  ManifestDecision,
  ManifestError,
  ManifestFact,
  ManifestFile,
  ManifestSemanticFacts,
  StructuredSummary,
} from "acp-kernel";

const PATH_PATTERN = /(?:^|[\s`"'(])((?:\.{0,2}\/|\/|~\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\/?)(?=$|[\s`"'),:;])/gm;
const SYMBOL_PATTERN = /\b(?:class|interface|type|function|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
const ERROR_PATTERN = /(?:^|\n)([^\n]*(?:Error|error|failed|failure|exception|exceeded|ENOENT|EACCES|HTTP\s+\d{3})[^\n]*)/g;
const NUMBER_ID_PATTERN = /(?:#[0-9]+|\b(?:[a-f0-9]{7,40}|[A-Z][A-Z0-9_]*-\d+|\d+(?:\.\d+){1,3}|\d[\d_,]*(?:ms|s|MB|GB|KB|tokens?|%)?)\b)/g;
const COMMAND_PATTERN = /(?:^|\n)(?:\$\s*)?((?:npm|pnpm|yarn|node|git|cargo|go|pytest|python|docker|kubectl|make|cmake|tsc|rg|fd)\s+[^\n]+)/g;
const REQUIREMENT_LABEL = /^(?:user\s+)?(?:requirement|constraint|acceptance criterion|must preserve)\s*:\s*/i;
const OBJECTIVE_LABEL = /^(?:goal|objective|purpose|task)\s*:\s*/i;
const DECISION_LABEL = /^(?:decision|decided|we decided|choice|chose|selected)\s*:?\s*/i;
const OPEN_LABEL = /^(?:open question|question|unknown|unclear|tbd)\s*:\s*/i;
const NEXT_LABEL = /^(?:todo|fixme|next step|next|remaining|unresolved|pending)\s*:\s*/i;
const STATUS_LABEL = /^(?:status|work state)\s*:\s*/i;
const FACT_LABEL = /^(?:fact|finding|outcome|result)\s*:\s*/i;
const USER_IMPERATIVE = /^(?:please\s+)?(?:add|build|change|check|create|delete|do not|don't|ensure|fix|implement|keep|never|only|preserve|read|remove|return|run|update|use|validate|verify)\b/i;
const REQUIREMENT_MODAL = /\b(?:must|must not|should|should not|required|requires|do not|don't|never|only)\b/i;
const DECISION_RATIONALE = /\s+(?:because|since|so that|due to)\s+(.+)$/i;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "by", "do", "does", "for", "from", "has", "have",
  "in", "is", "it", "must", "of", "on", "or", "remain", "should", "that", "the", "this", "to", "use", "uses", "using", "was", "were", "will", "with",
]);
const OPPOSITES: Array<[string, string]> = [
  ["enabled", "disabled"],
  ["allowed", "forbidden"],
  ["allowed", "prohibited"],
  ["complete", "incomplete"],
  ["completed", "pending"],
  ["done", "todo"],
  ["present", "absent"],
  ["exists", "missing"],
  ["passed", "failed"],
  ["success", "failure"],
  ["resolved", "unresolved"],
  ["true", "false"],
];

interface SourceSegment {
  text: string;
  sourceRefs: string[];
  role: CoreMessage["role"];
}

interface PolarityAssertion {
  text: string;
  sourceRefs: string[];
  tokens: Set<string>;
  polarity: boolean;
}

interface RequiredSemanticFact {
  rendered: string;
  parts: string[];
}

export interface ManifestValidation {
  renderedSummary: string;
  missingRequiredFacts: string[];
  status: "passed" | "repaired";
  compressionRatio: number;
}

export function extractCompressionManifest(
  messages: CoreMessage[],
  refsByRaw: Record<string, string>,
): CompressionManifest {
  const sourceRefs = messages
    .map((message) => refsByRaw[message.id])
    .filter((ref): ref is string => typeof ref === "string");
  const userMessageRefs = messages
    .filter((message) => message.role === "user" && !message.synthetic)
    .map((message) => refsByRaw[message.id])
    .filter((ref): ref is string => typeof ref === "string");
  const source = messages.map((message) => message.text ?? "").join("\n");
  const paths = matches(source, PATH_PATTERN, 1);
  const symbols = matches(source, SYMBOL_PATTERN, 1);
  const commands = matches(source, COMMAND_PATTERN, 1);
  const errorStrings = matches(source, ERROR_PATTERN, 1)
    .map((value) => value.trim())
    .filter((value) => value.length <= 500);
  const numbersAndIds = matches(source, NUMBER_ID_PATTERN, 0);
  const segments = sourceSegments(messages, refsByRaw);
  const semanticFacts = extractSemanticFacts(segments, paths, commands, errorStrings);
  const toolCalls = messages
    .filter((message) => message.contentType === "tool-call" && message.toolName)
    .map((message) => ({
      name: message.toolName!,
      callId: message.toolCallId,
      inputDigest: sha256(message.text ?? ""),
    }));
  return {
    sourceRefs,
    userMessageRefs,
    paths,
    symbols,
    commands,
    errorStrings,
    numbersAndIds,
    toolCalls,
    semanticFacts,
    sourceHash: sha256(JSON.stringify(messages.map((message) => ({
      id: message.id,
      role: message.role,
      contentType: message.contentType,
      toolName: message.toolName,
      toolCallId: message.toolCallId,
      text: message.text ?? "",
    })))),
  };
}

export function validateAndRepairSummary(input: {
  summary: string;
  manifest: CompressionManifest;
  preserve?: string[];
  sourceTokens: number;
  tier: 1 | 2 | 3;
  summaryMaxChars?: number;
}): ManifestValidation {
  const summary = input.summary.trim();
  const unsupported = unsupportedExactClaims(summary, input.manifest);
  if (unsupported.length > 0) {
    throw new Error(`Summary contains source-unsupported exact claims: ${unsupported.slice(0, 8).map((claim) => JSON.stringify(claim)).join(", ")}. Prefix genuine commentary with "Inferred:" to keep it non-authoritative.`);
  }
  const contradiction = findSummaryContradiction(authoritativeSummaryText(summary), input.manifest.semanticFacts);
  if (contradiction) {
    throw new Error(`Summary contradicts source fact: "${contradiction.left}" with "${contradiction.right}".`);
  }

  const exactRequired = requiredFacts(input.manifest, input.preserve ?? [], input.tier);
  const missingExact = exactRequired.filter((fact) => !summary.includes(fact));
  const semanticRequired = requiredSemanticFacts(input.manifest.semanticFacts, input.tier);
  const missingSemantic = semanticRequired.filter((fact) => !fact.parts.every((part) => includesFact(summary, part)));
  let renderedSummary = summary;
  if (missingSemantic.length > 0) {
    renderedSummary += `\n\nRetained semantic facts:\n${missingSemantic.map((fact) => `- ${fact.rendered}`).join("\n")}`;
  }
  if (missingExact.length > 0) {
    renderedSummary += `\n\nRetained exact facts:\n${missingExact.map((fact) => `- ${fact}`).join("\n")}`;
  }
  const missingRequiredFacts = unique([
    ...missingSemantic.map((fact) => fact.rendered),
    ...missingExact,
  ]);
  if (input.summaryMaxChars !== undefined && renderedSummary.length > input.summaryMaxChars) {
    throw new Error(`Validated summary is ${renderedSummary.length} characters after required-fact repair; limit is ${input.summaryMaxChars}. Split the source range or increase summaryMaxChars.`);
  }
  const summaryTokens = Math.max(1, Math.ceil(renderedSummary.length / 4));
  const compressionRatio = input.sourceTokens > 0 ? summaryTokens / input.sourceTokens : 1;
  if (input.sourceTokens >= 500 && compressionRatio >= 0.9) {
    throw new Error(
      `Summary is not materially smaller than its source (${summaryTokens}/${input.sourceTokens} tokens).`,
    );
  }
  return {
    renderedSummary,
    missingRequiredFacts,
    status: missingRequiredFacts.length > 0 ? "repaired" : "passed",
    compressionRatio,
  };
}

export function renderAuthoritativeSummary(summary: StructuredSummary): string {
  const sections: string[] = ["<acp-authoritative-summary>"];
  const add = (title: string, values: string[]): void => {
    if (values.length > 0) sections.push(`## ${title}\n${values.map((value) => `- ${value}`).join("\n")}`);
  };
  add("Objectives", summary.objective);
  add("Requirements", summary.userRequirements.map((item) => item.text));
  add("Decisions", summary.decisions.map((item) => item.rationale ? `${item.decision} — ${item.rationale}` : item.decision));
  add("Completed", summary.workState.completed);
  add("Active", summary.workState.active);
  add("Blocked or open", summary.workState.blocked);
  add("Next", summary.workState.next);
  add("Files", summary.files.map((item) => `${item.path} (${item.status})`));
  add("Commands", summary.commands.map((item) => `${item.command} — ${item.result}`));
  add("Errors", summary.errors.map((item) => item.exactText));
  add("Facts", summary.facts);
  add("Retrieval cues", summary.retrievalCues);
  sections.push("</acp-authoritative-summary>");
  return sections.join("\n\n");
}

export function structuredSummaryFromRendered(
  renderedSummary: string,
  manifest: CompressionManifest,
  preserve: string[] = [],
  tier: 1 | 2 | 3 = 1,
): StructuredSummary {
  const source = semanticFactsForTier(manifest.semanticFacts ?? emptySemanticFacts(), tier);
  // Structured state is authoritative and therefore comes only from the
  // deterministic source manifest. Model prose, including explicitly marked
  // inferred commentary, remains searchable in renderedSummary but cannot
  // create requirements, decisions, work claims, paths, commands, or errors.
  const rendered = emptySemanticFacts();
  const requirements = mergeFacts(source.requirements, rendered.requirements);
  for (const text of preserve) mergeFactInto(requirements, { text, sourceRefs: manifest.userMessageRefs });
  const files = mergeFiles(source.files, rendered.files);
  const commands = mergeCommands(source.commands, rendered.commands);
  const errors = mergeErrors(source.errors, rendered.errors);
  const facts = mergeFacts(source.facts, rendered.facts).map((fact) => fact.text);
  if (tier === 1) {
    for (const path of manifest.paths) {
      if (!files.some((file) => file.path === path)) files.push({ path, status: "read", sourceRefs: manifest.sourceRefs });
    }
    for (const command of manifest.commands) {
      if (!commands.some((detail) => detail.command === command)) commands.push({ command, result: "Recorded in source", sourceRefs: manifest.sourceRefs });
    }
    for (const exactText of manifest.errorStrings) {
      if (!errors.some((detail) => detail.exactText === exactText)) errors.push({ exactText, sourceRefs: manifest.sourceRefs });
    }
    for (const exact of unique([...manifest.symbols, ...manifest.numbersAndIds])) {
      if (!facts.includes(exact)) facts.push(exact);
    }
  }
  return {
    objective: mergeFacts(source.objectives, rendered.objectives).map((fact) => fact.text),
    userRequirements: requirements.map((fact) => ({
      text: fact.text,
      sourceRefs: fact.sourceRefs,
      verbatim: source.requirements.some((sourceFact) => sameText(sourceFact.text, fact.text)) || preserve.includes(fact.text),
    })),
    decisions: mergeDecisions(source.decisions, rendered.decisions).map((decision) => ({
      decision: decision.decision,
      rationale: decision.rationale,
      sourceRefs: decision.sourceRefs,
    })),
    workState: {
      completed: mergeFacts(source.completed, rendered.completed).map((fact) => fact.text),
      active: mergeFacts(source.active, rendered.active).map((fact) => fact.text),
      blocked: mergeFacts(
        mergeFacts(source.blocked, source.openQuestions),
        mergeFacts(rendered.blocked, rendered.openQuestions),
      ).map((fact) => fact.text),
      next: mergeFacts(source.nextSteps, rendered.nextSteps).map((fact) => fact.text),
    },
    files: files.map((file) => ({ path: file.path, status: file.status })),
    commands: commands.map((command) => ({
      command: command.command,
      exitCode: command.exitCode,
      result: command.result,
    })),
    errors: errors.map((error) => ({
      exactText: error.exactText,
      cause: error.cause,
      status: error.status,
    })),
    facts,
    retrievalCues: unique([
      ...manifest.sourceRefs,
      ...manifest.paths,
      ...manifest.symbols,
      ...manifest.errorStrings,
      ...source.openQuestions.map((fact) => fact.text),
      ...source.nextSteps.map((fact) => fact.text),
    ]),
  };
}

export function mergeCompressionManifests(
  manifests: CompressionManifest[],
  sourceHash: string,
  tier: 1 | 2 | 3 = 1,
): CompressionManifest {
  const values = (select: (manifest: CompressionManifest) => string[]): string[] => unique(manifests.flatMap(select));
  const semanticFacts = semanticFactsForTier(mergeManifestSemanticFacts(manifests), tier);
  const semanticRefs = unique(Object.values(semanticFacts).flatMap((items) => Array.isArray(items)
    ? items.flatMap((item) => item && typeof item === "object" && "sourceRefs" in item ? (item as { sourceRefs?: string[] }).sourceRefs ?? [] : [])
    : []));
  return {
    sourceRefs: tier === 1 ? values((manifest) => manifest.sourceRefs) : semanticRefs,
    userMessageRefs: tier === 1 ? values((manifest) => manifest.userMessageRefs) : unique(semanticFacts.requirements.flatMap((fact) => fact.sourceRefs)),
    paths: tier === 1 ? values((manifest) => manifest.paths) : unique(semanticFacts.files.map((file) => file.path)),
    symbols: tier === 1 ? values((manifest) => manifest.symbols) : [],
    commands: tier === 1 ? values((manifest) => manifest.commands) : unique(semanticFacts.commands.map((command) => command.command)),
    errorStrings: tier === 1 ? values((manifest) => manifest.errorStrings) : unique(semanticFacts.errors.map((error) => error.exactText)),
    numbersAndIds: tier === 1 ? values((manifest) => manifest.numbersAndIds) : [],
    toolCalls: tier === 1 ? manifests.flatMap((manifest) => manifest.toolCalls) : [],
    semanticFacts,
    sourceHash,
  };
}

export function mergeManifestSemanticFacts(manifests: CompressionManifest[]): ManifestSemanticFacts {
  const semantic = manifests.flatMap((manifest) => manifest.semanticFacts ? [manifest.semanticFacts] : []);
  const contradictions: ManifestContradiction[] = [];
  for (const contradiction of semantic.flatMap((facts) => facts.contradictions)) {
    const existing = contradictions.find((item) => sameText(item.left, contradiction.left) && sameText(item.right, contradiction.right));
    if (existing) existing.sourceRefs = unique([...existing.sourceRefs, ...contradiction.sourceRefs]);
    else contradictions.push({ ...contradiction, sourceRefs: unique(contradiction.sourceRefs) });
  }
  const merged: ManifestSemanticFacts = {
    objectives: semantic.reduce((facts, item) => mergeFacts(facts, item.objectives), [] as ManifestFact[]),
    requirements: semantic.reduce((facts, item) => mergeFacts(facts, item.requirements), [] as ManifestFact[]),
    decisions: semantic.reduce((facts, item) => mergeDecisions(facts, item.decisions), [] as ManifestDecision[]),
    completed: semantic.reduce((facts, item) => mergeFacts(facts, item.completed), [] as ManifestFact[]),
    active: semantic.reduce((facts, item) => mergeFacts(facts, item.active), [] as ManifestFact[]),
    blocked: semantic.reduce((facts, item) => mergeFacts(facts, item.blocked), [] as ManifestFact[]),
    openQuestions: semantic.reduce((facts, item) => mergeFacts(facts, item.openQuestions), [] as ManifestFact[]),
    nextSteps: semantic.reduce((facts, item) => mergeFacts(facts, item.nextSteps), [] as ManifestFact[]),
    files: semantic.reduce((facts, item) => mergeFiles(facts, item.files), [] as ManifestFile[]),
    commands: semantic.reduce((facts, item) => mergeCommands(facts, item.commands), [] as ManifestCommand[]),
    errors: semantic.reduce((facts, item) => mergeErrors(facts, item.errors), [] as ManifestError[]),
    facts: semantic.reduce((facts, item) => mergeFacts(facts, item.facts), [] as ManifestFact[]),
    contradictions,
  };
  const crossManifest = detectContradictions([
    ...merged.requirements.flatMap(requirementAssertions),
    ...[
      ...merged.decisions.map((decision) => ({ text: decisionText(decision), sourceRefs: decision.sourceRefs })),
      ...merged.completed,
      ...merged.active,
      ...merged.blocked,
      ...merged.openQuestions,
      ...merged.nextSteps,
      ...merged.facts,
    ].map((fact) => ({ ...fact, role: "system" as const })).flatMap(assertionsForSegment),
  ]);
  for (const contradiction of crossManifest) {
    const existing = merged.contradictions.find((item) => sameText(item.left, contradiction.left) && sameText(item.right, contradiction.right));
    if (existing) existing.sourceRefs = unique([...existing.sourceRefs, ...contradiction.sourceRefs]);
    else merged.contradictions.push(contradiction);
  }
  return merged;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceSegments(messages: CoreMessage[], refsByRaw: Record<string, string>): SourceSegment[] {
  return messages.flatMap((message) => {
    const sourceRefs = refsByRaw[message.id] ? [refsByRaw[message.id]!] : [];
    return splitText(message.text ?? "").map((text) => ({ text, sourceRefs, role: message.synthetic ? "system" : message.role }));
  });
}

function splitText(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/g))
    .map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, "").trim())
    .filter((line) => line.length > 1 && line.length <= 700 && !/^```/.test(line) && !/^#{1,6}\s/.test(line));
}

function extractSemanticFacts(
  segments: SourceSegment[],
  paths: string[],
  commands: string[],
  errors: string[],
): ManifestSemanticFacts {
  const semantic = emptySemanticFacts();
  let firstUserObjective = false;
  for (const segment of segments) {
    const text = segment.text;
    const objective = stripLabel(text, OBJECTIVE_LABEL);
    if (objective !== undefined) addFact(semantic.objectives, objective, segment.sourceRefs);

    const requirement = stripLabel(text, REQUIREMENT_LABEL);
    const imperative = segment.role === "user" && (USER_IMPERATIVE.test(text) || REQUIREMENT_MODAL.test(text));
    if (requirement !== undefined || imperative) {
      const value = requirement ?? text;
      addFact(semantic.requirements, value, segment.sourceRefs);
      if (!firstUserObjective) {
        addFact(semantic.objectives, value, segment.sourceRefs);
        firstUserObjective = true;
      }
    }

    const decision = parseDecision(text, segment.sourceRefs);
    if (decision) mergeDecisionInto(semantic.decisions, decision);

    const openQuestion = stripLabel(text, OPEN_LABEL);
    if (openQuestion !== undefined || (/\?$/.test(text) && /\b(?:open|should|whether|which|what|how|why)\b/i.test(text))) {
      addFact(semantic.openQuestions, openQuestion ?? text, segment.sourceRefs);
    }

    const nextStep = stripLabel(text, NEXT_LABEL);
    if (nextStep !== undefined || /\b(?:still need(?:s)? to|remains? to be|not yet|follow[- ]?up)\b/i.test(text)) {
      addFact(semantic.nextSteps, nextStep ?? text, segment.sourceRefs);
    }

    const status = stripLabel(text, STATUS_LABEL) ?? text;
    if (/\b(?:blocked|blocker|cannot proceed|waiting for|depends on)\b/i.test(status)) addFact(semantic.blocked, status, segment.sourceRefs);
    if (/\b(?:in progress|currently working|active work|underway)\b/i.test(status)) addFact(semantic.active, status, segment.sourceRefs);
    if (/^(?:completed|done|fixed|implemented|finished|resolved)\s*[:—-]/i.test(status) || /\b(?:tests? passed|successfully completed)\b/i.test(status)) {
      addFact(semantic.completed, status.replace(/^(?:completed|done|fixed|implemented|finished|resolved)\s*[:—-]\s*/i, ""), segment.sourceRefs);
    }

    const fact = stripLabel(text, FACT_LABEL);
    if (fact !== undefined) addFact(semantic.facts, fact, segment.sourceRefs);
  }

  semantic.files = paths.map((path) => fileDetail(path, segments));
  semantic.commands = commands.map((command) => commandDetail(command, segments));
  semantic.errors = errors.map((error) => errorDetail(error, segments));
  semantic.contradictions = detectInternalContradictions(segments);
  return semantic;
}

function parseDecision(text: string, sourceRefs: string[]): ManifestDecision | undefined {
  const labelled = DECISION_LABEL.test(text);
  const inferred = /^(?:we\s+)?(?:will use|will keep|use|keep|chose|selected)\b/i.test(text) && /\b(?:because|since|so that|due to)\b/i.test(text);
  if (!labelled && !inferred) return undefined;
  const body = labelled ? text.replace(DECISION_LABEL, "").trim() : text;
  const rationaleMatch = body.match(DECISION_RATIONALE);
  const rationale = rationaleMatch?.[1]?.trim().replace(/[.]+$/, "");
  const decision = rationaleMatch ? body.slice(0, rationaleMatch.index).trim().replace(/[.]+$/, "") : body.replace(/[.]+$/, "");
  if (!decision) return undefined;
  return { decision, rationale, sourceRefs };
}

function fileDetail(path: string, segments: SourceSegment[]): ManifestFile {
  const related = segments.filter((segment) => segment.text.includes(path));
  const sourceRefs = unique(related.flatMap((segment) => segment.sourceRefs));
  const asserted = related.filter((segment) => !/\b(?:do not|don't|never|must not|should not)\b/i.test(segment.text));
  const text = asserted.map((segment) => segment.text).join(" ");
  const status: ManifestFile["status"] = /\b(?:delete|deleted|remove|removed)\b/i.test(text)
    ? "deleted"
    : /\b(?:create|created|add|added|new file|wrote)\b/i.test(text)
      ? "created"
      : /\b(?:modify|modified|edit|edited|change|changed|update|updated|patch|patched|fix|fixed)\b/i.test(text)
        ? "modified"
        : "read";
  return { path, status, sourceRefs };
}

function commandDetail(command: string, segments: SourceSegment[]): ManifestCommand {
  const related = segments.filter((segment) => segment.text.includes(command));
  const text = related.map((segment) => segment.text).join(" ");
  const exitCodeText = text.match(/\bexit(?:\s+code)?\s*[:=]?\s*(-?\d+)\b/i)?.[1];
  const exitCode = exitCodeText === undefined ? undefined : Number.parseInt(exitCodeText, 10);
  const result = /\b(?:passed|succeeded|success)\b/i.test(text)
    ? "passed"
    : /\b(?:failed|failure|error)\b/i.test(text)
      ? "failed"
      : exitCode === 0
        ? "passed"
        : exitCode !== undefined
          ? `exit ${exitCode}`
          : "Recorded in source";
  return { command, exitCode, result, sourceRefs: unique(related.flatMap((segment) => segment.sourceRefs)) };
}

function errorDetail(exactText: string, segments: SourceSegment[]): ManifestError {
  const related = segments.filter((segment) => segment.text.includes(exactText) || exactText.includes(segment.text));
  const text = related.map((segment) => segment.text).join(" ");
  const cause = text.match(/\b(?:cause|caused by|because|due to)\s*[:=]?\s*([^.;]+)/i)?.[1]?.trim();
  const status = /\bresolved|fixed\b/i.test(text) ? "resolved" : /\bunresolved|open|pending\b/i.test(text) ? "unresolved" : undefined;
  return { exactText, cause, status, sourceRefs: unique(related.flatMap((segment) => segment.sourceRefs)) };
}

function detectInternalContradictions(segments: SourceSegment[]): ManifestContradiction[] {
  return detectContradictions(segments.flatMap(assertionsForSegment));
}

function detectContradictions(assertions: PolarityAssertion[]): ManifestContradiction[] {
  const contradictions: ManifestContradiction[] = [];
  for (let leftIndex = 0; leftIndex < assertions.length; leftIndex++) {
    const left = assertions[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < assertions.length; rightIndex++) {
      const right = assertions[rightIndex]!;
      if (left.polarity === right.polarity || !relatedAssertions(left, right)) continue;
      const sourceRefs = unique([...left.sourceRefs, ...right.sourceRefs]);
      if (!contradictions.some((item) => sameText(item.left, left.text) && sameText(item.right, right.text))) {
        contradictions.push({ left: left.text, right: right.text, sourceRefs });
      }
    }
  }
  return contradictions;
}

function findSummaryContradiction(summary: string, semantic: ManifestSemanticFacts | undefined): { left: string; right: string } | undefined {
  if (!semantic) return undefined;
  const sourceSegmentsForAssertions = [
    ...semantic.decisions.map((decision) => ({ text: decisionText(decision), sourceRefs: decision.sourceRefs })),
    ...semantic.blocked,
    ...semantic.openQuestions,
    ...semantic.nextSteps,
    ...semantic.facts,
  ].map((fact) => ({ ...fact, role: "system" as const }));
  const ambiguous = semantic.contradictions;
  const sourceAssertions = [
    ...semantic.requirements.flatMap(requirementAssertions),
    ...sourceSegmentsForAssertions.flatMap(assertionsForSegment),
  ];
  const summaryAssertions = splitText(summary)
    .map((text) => ({ text, sourceRefs: [], role: "assistant" as const }))
    .flatMap(assertionsForSegment);
  for (const source of sourceAssertions) {
    const isAmbiguous = ambiguous.some((item) => sameText(item.left, source.text) || sameText(item.right, source.text));
    if (isAmbiguous) continue;
    const opposite = summaryAssertions.find((candidate) => candidate.polarity !== source.polarity && relatedAssertions(source, candidate));
    if (opposite) return { left: source.text, right: opposite.text };
  }
  return undefined;
}

function requirementAssertions(fact: ManifestFact): PolarityAssertion[] {
  const segment: SourceSegment = { ...fact, role: "user" };
  const extracted = assertionsForSegment(segment);
  if (extracted.length > 0) return extracted;
  const negated = /\b(?:not|never|no|without|don't|forbidden|prohibited)\b/i.test(fact.text);
  return [assertion(
    segment,
    /\b(?:not|never|no|without|don't|forbidden|prohibited)\b/i,
    !negated,
  )];
}

function assertionsForSegment(segment: SourceSegment): PolarityAssertion[] {
  const lower = normalizeText(segment.text);
  const assertions: PolarityAssertion[] = [];
  let hasExplicitNegative = false;
  for (const [positive, negative] of OPPOSITES) {
    if (containsWord(lower, positive)) assertions.push(assertion(segment, positive, true));
    if (containsWord(lower, negative)) {
      assertions.push(assertion(segment, negative, false));
      hasExplicitNegative = true;
    }
  }
  const hasNegation = /\b(?:not|never|no|without|don't|forbidden|prohibited)\b/i.test(segment.text);
  if (hasNegation) assertions.push(assertion(segment, /\b(?:not|never|no|without|don't|forbidden|prohibited)\b/i, false));
  if (!hasNegation && !hasExplicitNegative && /\b(?:must|should|will|use|uses|using|allow|allowed|required|requires|enable|enabled|complete|completed|resolve|resolved)\b/i.test(segment.text)) {
    assertions.push(assertion(segment, /\b(?:must|should|will|use|uses|using|allow|allowed|required|requires)\b/i, true));
  }
  return assertions;
}

function assertion(segment: SourceSegment, marker: string | RegExp, polarity: boolean): PolarityAssertion {
  const withoutMarker = typeof marker === "string"
    ? normalizeText(segment.text).replace(new RegExp(`\\b${escapeRegex(marker)}\\b`, "gi"), " ")
    : normalizeText(segment.text).replace(marker, " ");
  const tokens = new Set(withoutMarker.split(/[^a-z0-9_/-]+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
  return { text: segment.text, sourceRefs: segment.sourceRefs, tokens, polarity };
}

function relatedAssertions(left: PolarityAssertion, right: PolarityAssertion): boolean {
  const leftTokens = [...left.tokens];
  const rightTokens = [...right.tokens];
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  const overlap = leftTokens.filter((token) => right.tokens.has(token)).length;
  return overlap >= Math.max(1, Math.ceil(Math.min(leftTokens.length, rightTokens.length) * 0.5));
}

function semanticFactsForTier(semantic: ManifestSemanticFacts, tier: 1 | 2 | 3): ManifestSemanticFacts {
  if (tier === 1) return semantic;
  const durableDecision = (decision: ManifestDecision): boolean =>
    DURABLE_SEMANTIC_RE.test(`${decision.decision} ${decision.rationale ?? ""}`);
  const durableFact = (fact: ManifestFact): boolean => DURABLE_SEMANTIC_RE.test(fact.text);
  if (tier === 2) {
    return {
      ...emptySemanticFacts(),
      objectives: semantic.objectives,
      requirements: semantic.requirements,
      decisions: semantic.decisions,
      facts: semantic.facts.filter(durableFact),
      completed: semantic.completed,
      active: semantic.active,
      blocked: semantic.blocked,
      openQuestions: semantic.openQuestions,
      nextSteps: semantic.nextSteps,
      files: semantic.files.filter((file) => file.status !== "read"),
      errors: semantic.errors,
      contradictions: semantic.contradictions,
    };
  }
  return {
    ...emptySemanticFacts(),
    objectives: semantic.objectives.filter(durableFact),
    requirements: semantic.requirements,
    decisions: semantic.decisions.filter(durableDecision),
    facts: semantic.facts.filter(durableFact),
    completed: semantic.completed.filter(durableFact),
    blocked: semantic.blocked,
    openQuestions: semantic.openQuestions,
    nextSteps: semantic.nextSteps,
    contradictions: semantic.contradictions,
  };
}

const DURABLE_SEMANTIC_RE = /\b(must|never|required|requirement|constraint|decision|because|rationale|block(?:ed|er)?|unresolved|security|compatib|invariant|do not|cannot|shall|shipped|released|merged|milestone|version|open|next)\b/i;

function requiredSemanticFacts(semantic: ManifestSemanticFacts | undefined, tier: 1 | 2 | 3): RequiredSemanticFact[] {
  if (!semantic) return [];
  const selected = semanticFactsForTier(semantic, tier);
  const facts: RequiredSemanticFact[] = [];
  const add = (label: string, fact: ManifestFact): void => {
    facts.push({ rendered: `${label}: ${fact.text}`, parts: [fact.text] });
  };
  selected.objectives
    .filter((objective) => !selected.requirements.some((requirement) => sameText(requirement.text, objective.text)))
    .forEach((fact) => add("Objective", fact));
  selected.requirements.forEach((fact) => add("Requirement", fact));
  selected.files.filter((file) => file.status !== "read").forEach((file) => {
    facts.push({ rendered: `Modified file (${file.status}): ${file.path}`, parts: [file.path] });
  });
  selected.facts.forEach((fact) => add("Durable fact", fact));
  selected.completed.forEach((fact) => add("Completed work", fact));
  selected.active.forEach((fact) => add("Active work", fact));
  selected.blocked.forEach((fact) => add("Blocked", fact));
  selected.openQuestions.forEach((fact) => add("Open question", fact));
  selected.nextSteps.forEach((fact) => add("Next step", fact));
  selected.decisions.forEach((decision) => facts.push({
    rendered: decision.rationale
      ? `Decision: ${decision.decision} — rationale: ${decision.rationale}`
      : `Decision: ${decision.decision}`,
    parts: decision.rationale ? [decision.decision, decision.rationale] : [decision.decision],
  }));
  selected.contradictions.forEach((contradiction) => facts.push({
    rendered: `Contradiction: ${contradiction.left} <> ${contradiction.right}`,
    parts: [contradiction.left, contradiction.right],
  }));
  return dedupeRequired(facts);
}

function requiredFacts(
  manifest: CompressionManifest,
  preserve: string[],
  tier: 1 | 2 | 3,
): string[] {
  const exact = tier === 1
    ? [
        ...preserve,
        ...manifest.paths,
        ...manifest.symbols,
        ...manifest.commands,
        ...manifest.errorStrings,
        ...manifest.numbersAndIds,
      ]
    : preserve;
  return unique(exact).filter((value) => value.length > 1);
}

function emptySemanticFacts(): ManifestSemanticFacts {
  return {
    objectives: [],
    requirements: [],
    decisions: [],
    completed: [],
    active: [],
    blocked: [],
    openQuestions: [],
    nextSteps: [],
    files: [],
    commands: [],
    errors: [],
    facts: [],
    contradictions: [],
  };
}

function addFact(target: ManifestFact[], text: string, sourceRefs: string[]): void {
  const value = cleanFact(text);
  if (!value) return;
  mergeFactInto(target, { text: value, sourceRefs });
}

function mergeFactInto(target: ManifestFact[], fact: ManifestFact): void {
  const existing = target.find((item) => sameText(item.text, fact.text));
  if (existing) existing.sourceRefs = unique([...existing.sourceRefs, ...fact.sourceRefs]);
  else target.push({ text: fact.text, sourceRefs: unique(fact.sourceRefs) });
}

function mergeFacts(left: ManifestFact[], right: ManifestFact[]): ManifestFact[] {
  const merged: ManifestFact[] = [];
  for (const fact of [...left, ...right]) mergeFactInto(merged, fact);
  return merged;
}

function mergeDecisionInto(target: ManifestDecision[], decision: ManifestDecision): void {
  const existing = target.find((item) =>
    sameText(item.decision, decision.decision)
    && (!item.rationale || !decision.rationale || sameText(item.rationale, decision.rationale))
  );
  if (!existing) {
    target.push({ ...decision, sourceRefs: unique(decision.sourceRefs) });
    return;
  }
  existing.sourceRefs = unique([...existing.sourceRefs, ...decision.sourceRefs]);
  if (!existing.rationale && decision.rationale) existing.rationale = decision.rationale;
}

function mergeDecisions(left: ManifestDecision[], right: ManifestDecision[]): ManifestDecision[] {
  const merged: ManifestDecision[] = [];
  for (const decision of [...left, ...right]) mergeDecisionInto(merged, decision);
  return merged;
}

function mergeFiles(left: ManifestFile[], right: ManifestFile[]): ManifestFile[] {
  const rank: Record<ManifestFile["status"], number> = { read: 0, created: 1, modified: 2, deleted: 3 };
  const merged: ManifestFile[] = [];
  for (const file of [...left, ...right]) {
    const existing = merged.find((item) => item.path === file.path);
    if (!existing) merged.push({ ...file, sourceRefs: unique(file.sourceRefs) });
    else {
      if (rank[file.status] > rank[existing.status]) existing.status = file.status;
      existing.sourceRefs = unique([...existing.sourceRefs, ...file.sourceRefs]);
    }
  }
  return merged;
}

function mergeCommands(left: ManifestCommand[], right: ManifestCommand[]): ManifestCommand[] {
  const merged: ManifestCommand[] = [];
  for (const command of [...left, ...right]) {
    const existing = merged.find((item) => item.command === command.command);
    if (!existing) merged.push({ ...command, sourceRefs: unique(command.sourceRefs) });
    else {
      if (existing.exitCode === undefined) existing.exitCode = command.exitCode;
      if (existing.result === "Recorded in source" && command.result !== "Recorded in source") existing.result = command.result;
      existing.sourceRefs = unique([...existing.sourceRefs, ...command.sourceRefs]);
    }
  }
  return merged;
}

function mergeErrors(left: ManifestError[], right: ManifestError[]): ManifestError[] {
  const merged: ManifestError[] = [];
  for (const error of [...left, ...right]) {
    const existing = merged.find((item) => item.exactText === error.exactText);
    if (!existing) merged.push({ ...error, sourceRefs: unique(error.sourceRefs) });
    else {
      if (!existing.cause) existing.cause = error.cause;
      if (!existing.status) existing.status = error.status;
      existing.sourceRefs = unique([...existing.sourceRefs, ...error.sourceRefs]);
    }
  }
  return merged;
}

function stripLabel(text: string, label: RegExp): string | undefined {
  if (!label.test(text)) return undefined;
  return cleanFact(text.replace(label, ""));
}

function cleanFact(text: string): string {
  return text.trim().replace(/^\s*[-*+]\s+/, "").replace(/\s+/g, " ").replace(/[;]+$/, "");
}

function decisionText(decision: ManifestDecision): string {
  return decision.rationale ? `${decision.decision} because ${decision.rationale}` : decision.decision;
}

function includesFact(summary: string, fact: string): boolean {
  const normalizedSummary = normalizeText(summary);
  const normalizedFact = normalizeText(fact);
  return normalizedFact.length > 0 && normalizedSummary.includes(normalizedFact);
}

function sameText(left: string, right: string): boolean {
  return normalizeText(left) === normalizeText(right);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[“”‘’`*_#]/g, "").replace(/[^a-z0-9_./#@~:+-]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsWord(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(text);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeRequired(facts: RequiredSemanticFact[]): RequiredSemanticFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = normalizeText(fact.rendered);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function authoritativeSummaryText(summary: string): string {
  return summary.split("\n")
    .filter((line) => !/^\s*(?:[-*]\s*)?(?:inferred|non-authoritative commentary)\s*:/i.test(line))
    .join("\n");
}

function unsupportedExactClaims(summary: string, manifest: CompressionManifest): string[] {
  const authoritative = authoritativeSummaryText(summary);
  const exactClaims = unique([
    ...matches(authoritative, PATH_PATTERN, 1).filter(isLikelyPathClaim),
    ...matches(authoritative, COMMAND_PATTERN, 1),
    ...matches(authoritative, ERROR_PATTERN, 1).map((value) => value.trim()),
    ...matches(authoritative, NUMBER_ID_PATTERN, 0),
    ...matches(authoritative, /\b(?:m|b|c|a)\d{3,}\b/g, 0),
  ]);
  const supportedExact = unique([
    ...manifest.sourceRefs,
    ...manifest.paths,
    ...manifest.commands,
    ...manifest.errorStrings,
    ...manifest.numbersAndIds,
    ...manifest.symbols,
  ]);
  const unsupported = exactClaims.filter((claim) => {
    if (/^\d+(?:,\d+)+$/.test(claim) && claim.split(",").every((part) => manifest.numbersAndIds.some((source) => normalizeText(source) === part))) return false;
    return !supportedExact.some((source) => {
      const normalizedClaim = normalizeText(claim.replace(/[/.]+$/, ""));
      const normalizedSource = normalizeText(source.replace(/[/.]+$/, ""));
      return normalizedClaim === normalizedSource
        || (normalizedClaim.length >= 3 && normalizedSource.startsWith(normalizedClaim) && /^[a-z%]+$/i.test(normalizedSource.slice(normalizedClaim.length)))
        || (normalizedClaim.length >= 8 && normalizedSource.includes(normalizedClaim))
        || (normalizedSource.length >= 8 && normalizedClaim.includes(normalizedSource));
    });
  });

  const semantic = manifest.semanticFacts;
  if (semantic) {
    const sourceClaims = [
      ...semantic.objectives.map((fact) => fact.text),
      ...semantic.requirements.map((fact) => fact.text),
      ...semantic.decisions.map((fact) => decisionText(fact)),
      ...semantic.completed.map((fact) => fact.text),
      ...semantic.active.map((fact) => fact.text),
      ...semantic.blocked.map((fact) => fact.text),
      ...semantic.openQuestions.map((fact) => fact.text),
      ...semantic.nextSteps.map((fact) => fact.text),
      ...semantic.facts.map((fact) => fact.text),
    ];
    for (const line of authoritative.split("\n")) {
      const match = line.match(/^\s*(?:[-*]\s*)?(?:objective|requirement|decision|completed|active|blocked|open question|next step|fact|outcome|result)\s*:\s*(.+)$/i);
      if (!match?.[1]) continue;
      const claim = match[1].trim();
      if (!sourceClaims.some((source) => includesFact(source, claim) || includesFact(claim, source))) unsupported.push(claim);
    }
  }
  return unique(unsupported);
}

function isLikelyPathClaim(value: string): boolean {
  if (/^(?:\/|\.\.\/|\.\/|~\/)/.test(value)) return true;
  if (/^(?:src|docs|tests?|packages?|config|deploy|scripts?|migrations?|evals?)\//.test(value)) return true;
  return false;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function matches(source: string, pattern: RegExp, group: number): string[] {
  pattern.lastIndex = 0;
  const values: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[group];
    if (value) values.push(value);
  }
  return unique(values);
}
