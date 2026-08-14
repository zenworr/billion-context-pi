# Changelog

## Unreleased

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
