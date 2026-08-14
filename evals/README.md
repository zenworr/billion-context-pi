# Hybrid ACP evaluation harness

Run the deterministic replay suite:

```sh
npm run eval
```

Run selected fixtures by file-name substring:

```sh
npm run eval -- issue-122 shadow
```

The runner uses Node's permission system without `--allow-net`. `tsx` needs local worker and child-process permissions for TypeScript transformation; the harness also replaces `fetch` with a failing function and reports attempted calls. It reads JSON files in `evals/fixtures/` and uses deterministic local fake model responses for production-path checks. It does not call a provider, browser, or network API. Each fixture is an event trace. The replay engine applies the trace, checks transactional and protocol invariants, and prints one JSON report. The process exits with status 1 when a fixture is invalid, a network operation is attempted, a production check fails, or an invariant fails.

The report has the four metric groups from the architecture plan:

- `context`: active-input percentiles, cached and uncached input, reclaimed tokens per mutation, mutation rate, cache-hit change, and checkpoint frequency.
- `cost`: main compaction output, configured-model input/output, and compaction latency totals and percentiles.
- `quality`: constraint, exact-fact, and unresolved-work retention; contradictions; retrieval; continuation; tests; repeated retrieval; and false confidence.
- `reliability`: rejected invalid transactions, stale work, chunk limits, protocol units, recovery paths, checkpoints, delegate completions, extension mutations, host fallback, shadow commits, and network requests.

Separate `00-baseline-*.json` files contain samples for main inline compression, configured T1/T2/T3 compression, configured compression with T0, Pi native compaction, and hybrid checkpoint fallback. The report keeps each baseline's metrics separate. `13-shadow-mode.json` keeps the main block authoritative while it scores a configured candidate.

The `production` report section directly checks exported kernel and Pi-adapter paths for conservative issue #122 accounting, host fallback, protocol-boundary expansion, configured-model chunking and rejection, abort handling, corrupt sidecar recovery, stale revisions, failed writes, repeated checkpoint epochs, and delegate completion parsing.

Fixtures use fixed values and contain no dates, random IDs, timers, or external files. Add a new fixture for each regression. Do not change an old fixture to hide a failure.
