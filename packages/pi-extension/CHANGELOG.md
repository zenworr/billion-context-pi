# Changelog

## Unreleased

- Harden the second-round architecture: owned-tail runtime and quota locks, fileless transactional state, monotonic wide refs, direct checkpoint ancestry, transactional manual/native checkpoint ownership, turn-based survival, and branch-aware epochs.
- Protect the first request, current turn, media, pins, reasoning, and complete provider protocol groups; use one final-request projection for status, hard gating, and host-compaction decisions.
- Reinject changed project instructions byte-for-byte, keep failed compression diagnostics visible, validate nested configuration, and use purpose-specific thinking levels.
- Add fresh paid-call preflight, configured repair plus authenticated main/host fallback, a total Tier-1 rescue deadline, non-cumulative T2/T3 manifests, one-pass Bash spooling, bounded quota indexing, and no additional output cap after storage failure.

- Correct package identity and compatibility by bundling the private kernel, requiring Pi `^0.84.1` and Node `>=22.19.0`, and adding a clean packed-consumer smoke test.
- Replace unsafe absolute-ratio calibration and the fixed 204K gate with verified anchored deltas, per-model compiled-projection budgets, bounded recovery tools, and failed-compression relaxation.
- Make provider-visible compression single-anchor, require contiguous higher-tier sources, retain semantic requirements at every tier, and record complete checkpoint provenance and retrievable checkpoint sources.
- Add inter-process sidecar locking, graph/metadata revision separation, survival-based background distillation, a two-attempt rescue ladder, bounded pins/search/decompression, artifact quotas, and streamed artifact storage.
- Keep project/world freshness out of the stable system prefix, preserve Pi reasoning, and make `/acp-model` and `/acp-settings` project-local.

- Add `/acp-model` and `/acp-settings` for selecting a configured compression model, thinking level, and independent Tier-1/Tier-2/Tier-3 routing.
- Preserve main-model range selection while configured compressors write validated summaries with visible main-model fallback and nested usage accounting.
- Convert the project to the `acp-kernel` + `billion-context-pi` workspace while retaining both package names.
- Add schema-v2 atomic state, checkpoint epochs, manifests, provenance, quality gates, content hashes, future-schema refusal, backups, and corruption quarantine.
- Add lossless T0 artifact clearing, `acp_artifact`, temporary `pin_context`, authoritative project/world overlays, and explicit project-memory promotion.
- Add Luna-safe 220K map-reduce budgeting, dual cross-provider consent, secret redaction, notification-only updates, and verified host-compaction fallback.
- Add opt-in background T2/T3, shadow mode, search weighting, telemetry, cost routing, and per-model quality adaptation.
- Add deterministic replay evaluation for issue #122, stale/abort/write failures, protocol boundaries, corrupt state/artifacts, repeated checkpoints, and shadow non-commit.

## v0.1.36

- Bump acp-kernel to 0.0.21 (two-tier gating: maxContextLimitPct 75% force-nudge + emergencyThresholdPct 95% truncate, spam fix when no compressible content, over-limit emergency voice)
- New compress config sub-object: `maxContextLimit`, `emergencyThresholdPercent`, `nudgeGrowthTokens` (maps to kernel `nudge.maxContextLimitPct`, `nudge.emergencyThresholdPct` + `truncate.threshold`, `nudge.growthFloor` + `nudge.growthCap`)
- New delegate config sub-object: `delegate: { enabled, displayUsage }` (boolean shorthand + legacy flat `displayUsage` backward compat)
- Standalone CONFIGURATION.md + CONFIGURATION.zh-CN.md reference docs
