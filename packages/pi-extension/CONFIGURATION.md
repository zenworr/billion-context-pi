# Configuration

[English](./CONFIGURATION.md) | [中文](./CONFIGURATION.zh-CN.md)

**billion-context-pi** works out of the box with no configuration — it reads your model's context window automatically and applies sensible defaults. This document is the complete reference for the optional JSON configuration file (`acp.json`) and the environment variables that let you tune behavior.

Configuration is layered: environment variables take the highest precedence, followed by the project config file, then the global config file, and finally the built-in defaults.

---

## Config file locations

Settings are read from JSON files named `acp.json`. The global file applies to every project; a project file overrides the global one on a **per-field** basis (individual keys you do not set in the project file still fall back to the global value).

| Scope | Path | Applies to |
|-------|------|------------|
| **Global** | `~/.pi/acp.json` | All projects on this machine |
| **Project** | `<project>/.pi/acp.json` | The current project only (overrides global per-field) |

> **Precedence:** Environment variable &gt; Project file &gt; Global file &gt; Built-in default.

Files are loaded at session start. Missing files do not produce an error. Malformed JSON, unknown keys, invalid values, and unsafe cross-field relationships are ignored and logged with their configuration path; they never stop extension startup. Only documented, validated keys are applied.

---

## Quick start

Create `~/.pi/acp.json` (or `<project>/.pi/acp.json`) and drop in whichever keys you want to change. Every field below is optional — omit a key to keep its default.

```json
{
  "debug": false,
  "autoUpdate": false,
  "modelContextLimit": 200000,
  "toolBashDefaultTimeout": 60,
  "toolOutputMaxBytes": 200000,

  "delegate": {
    "enabled": true,
    "displayUsage": "separate"
  },

  "compress": {
    "maxContextLimit": "75%",
    "emergencyThresholdPercent": "95%",
    "nudgeGrowthTokens": 50000,
    "model": "openai/gpt-5.6-luna",
    "thinkingLevel": "medium",
    "tier1Compressor": "main",
    "tier2Compressor": "main",
    "tier3Compressor": "main"
  }
}
```

A minimal config enabling only debug logging:

```json
{
  "debug": true
}
```

An advanced config overriding the kernel's compression prompt rules (requires the risk acknowledgement). Set only the fields you want to change; the rest inherit the kernel defaults:

```json
{
  "prompts": {
    "compressPhilosophy": "My compression philosophy...",
    "howToCompressRules": "My tier-1 rules...",
    "tier2DistillRules": "My tier-2 distillation rules...",
    "tier3CondenseRules": "My tier-3 condensation rules..."
  },
  "acknowledgePromptsRisk": true
}
```

---

## Parameter Reference

### Status legend

| Status | Meaning |
|--------|---------|
| 🟢 **ACTIVE** | Fully supported, documented, and recommended for use. |

All keys below are currently **ACTIVE**.

### Summary

**Top-level keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `debug` | boolean | `false` | 🟢 ACTIVE | Enable verbose debug-level events in the log. |
| `autoUpdate` | boolean | `false` | 🟢 ACTIVE | Check npm for a newer version and show a notification. Never installs updates. |
| `modelContextLimit` | number | *(auto)* | 🟢 ACTIVE | Override the context limit (in tokens). |
| `toolBashDefaultTimeout` | number | `60` | 🟢 ACTIVE | Default `bash` tool timeout in seconds when the model omits it. |
| `toolOutputMaxBytes` | number | `200000` | 🟢 ACTIVE | Byte cap after exact durable externalization; skipped if storage fails. |

**Delegate keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `delegate.enabled` | boolean | `true` | 🟢 ACTIVE | Enable the `acp_delegate` tools and their system-prompt section. |
| `delegate.displayUsage` | string | `"separate"` | 🟢 ACTIVE | Controls how delegate sub-agent token usage is reported. |

**Compression keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `compress.maxContextLimit` | number \| string | `"75%"` | 🟢 ACTIVE | Context threshold that triggers forced compression nudges. |
| `compress.emergencyThresholdPercent` | number \| string | `"95%"` | 🟢 ACTIVE | Context threshold that triggers emergency truncation. |
| `compress.nudgeGrowthTokens` | number | `50000` | 🟢 ACTIVE | Token growth step for soft compression nudges. |
| `compress.model` | string | *(none)* | 🟢 ACTIVE | Model selected by `/acp-model`, written as `provider/model-id`. |
| `compress.thinkingLevel` | string | `"medium"` | 🟢 ACTIVE | Default thinking level for the configured model. |
| `compress.tier2ThinkingLevel` | string | `"low"` | 🟢 ACTIVE | Tier-2 thinking override. |
| `compress.tier3ThinkingLevel` | string | `"minimal"` | 🟢 ACTIVE | Tier-3 thinking override. |
| `compress.checkpointThinkingLevel` | string | *(general level)* | 🟢 ACTIVE | Full-checkpoint thinking override. |
| `compress.branchThinkingLevel` | string | `"low"` | 🟢 ACTIVE | Branch-summary thinking override. |
| `compress.tier1Compressor` | `"main"` \| `"configured"` | `"main"` | 🟢 ACTIVE | Summary writer for Tier 1. |
| `compress.tier2Compressor` | `"main"` \| `"configured"` | `"main"` | 🟢 ACTIVE | Summary writer for Tier 2. |
| `compress.tier3Compressor` | `"main"` \| `"configured"` | `"main"` | 🟢 ACTIVE | Summary writer for Tier 3. |
| `compress.checkpointCompressor` | `"main"` \| `"configured"` | `"main"` | 🟢 ACTIVE | Full checkpoint writer after selective rescue is insufficient. |
| `compress.branchSummaryCompressor` | `"main"` \| `"configured"` | `"main"` | 🟢 ACTIVE | Tree/branch summary writer. |
| `compress.allowCrossProvider` | boolean | `false` | 🟢 ACTIVE | First consent for transfer to another provider. |
| `compress.acknowledgeCrossProviderDataTransfer` | boolean | `false` | 🟢 ACTIVE | Second explicit consent; both settings must be valid in project config. |
| `compress.maxRangesPerCall` | integer | `4` | 🟢 ACTIVE | Maximum atomic ranges in one plan/commit. |
| `compress.maxModelCalls` | integer | `6` | 🟢 ACTIVE | Maximum paid model calls per compression transaction. |
| `compress.maxInputTokens` | integer | `400000` | 🟢 ACTIVE | Maximum aggregate model input tokens. |
| `compress.maxOutputTokens` | integer | `40000` | 🟢 ACTIVE | Maximum aggregate model output tokens. |
| `compress.maxDurationMs` | integer | `60000` | 🟢 ACTIVE | Total model-generation deadline. |
| `compress.maxCostUsd` | number | `5` | 🟢 ACTIVE | Maximum observed model cost before commit. |
| `compress.minimumNetSavingsTokens` | integer | `256` | 🟢 ACTIVE | Minimum exact compiled token reduction. |
| `compress.minimumNetSavingsPercent` | number | `0.05` | 🟢 ACTIVE | Minimum exact compiled percentage reduction. |

**Prompts keys**

| Key | Type | Default | Status | Description |
|-----|------|---------|--------|-------------|
| `prompts` | object | *(kernel defaults)* | 🟢 ACTIVE | Override acp-kernel's 4 load-bearing compression prompt rules. Each set field replaces the default verbatim. |
| `acknowledgePromptsRisk` | boolean | `false` | 🟢 ACTIVE | Must be `true` for `prompts` overrides to take effect; otherwise overrides are dropped and defaults are used. |

**Environment variables**

| Variable | Effect |
|----------|--------|
| `ACP_AUTO_UPDATE` | Set to `0` / `false` to disable auto-update (overrides `autoUpdate`). |
| `ACP_MODEL_CONTEXT_LIMIT` | Override the context limit (takes highest precedence). |
| `ACP_DEBUG` | Set to `1` / `true` to enable debug logging. |
| `ACP_LOG_FILE` | Override the log file path (default `~/.pi/acp.log`). |

> **Only the documented keys are read from `acp.json`.** Other tuning knobs (`preserveRecentMessages`, `protectedTools`) are code-level and not user-overridable. The three compression thresholds form a three-tier escalation: growth-driven soft nudges → forced nudges at `compress.maxContextLimit` → emergency truncation at `compress.emergencyThresholdPercent`.

---

## Hybrid ACP settings

Configured compression runs in an isolated, no-tools request. Every request is conservatively estimated and split so its input remains below 220,000 tokens and below the selected model's safe input budget. Cross-provider transfer is blocked unless both consent keys are `true`; common secrets and configured secret patterns are redacted before transfer.

Top-level `budget` controls `targetActiveTokens`, context percentages, `outputReserveTokens`, and `safetyMarginTokens`. The hard tool gate is derived from the actual provider-serialized payload audit plus these reserves; it is not a fixed threshold. Parallel calls reserve one aggregate output budget. A failed compression permits at most one bounded recovery action in that provider cycle; repeated or range-invalid failures open a circuit to host checkpoint recovery.

Top-level `clearing` controls deterministic T0 clearing. Important fields are `enabled`, `keepRecentToolUses` (default 5), `clearAtLeastTokens` (default 16000), `excludeTools`, and `reasoning` (`"safe-only"` or `"preserve"`, default `"preserve"`). `safe-only` clears only explicitly unsigned, provider-agnostic plaintext reasoning after ACP confirms a complete companion response and durable reasoning artifact; opaque, encrypted, signed, current-turn, incomplete, or provider-specific reasoning is preserved. Cleared tool output is retrievable with `acp_artifact`; inline retrieval is byte-bounded and supports `offset`/`limit`. Artifacts are limited by default to 50 MiB each, 500 MiB per session, and 2 GiB globally. Quota updates use an inter-process lock and a bounded persistent index. If durable storage fails, ACP does not apply an additional irreversible cap. Fork shutdown keeps inherited artifact paths valid. Orphaned session files are removed at startup or explicitly with `/acp artifacts-cleanup`. `pin_context` is capped at eight pins and a token-estimated 48K-character total payload.

Top-level `memory.mode` is `"off"`, `"session"`, or `"project"`. Project files are written only after an explicit `/acp promote bN`; `automaticPromotion` must remain `false`.

Top-level `optimization` is opt-in. `automaticDistillation` schedules T2/T3 provider work only at the idle `agent_end` boundary. `shadowCompaction` validates without committing. `telemetry`, `costAwareRouting`, and `qualityAdaptation` are independent opt-ins; no cost route is required for correctness.

## General

### `debug`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** 🟢 ACTIVE
- **Description:** Enable verbose **debug-level** events in the log file (default `~/.pi/acp.log`). The always-on log (session/turn/compress/delegate lifecycle events, all errors and warnings) is written regardless of this setting; `debug` only adds extra diagnostics such as full field dumps and per-turn internals. Also enabled by the environment variable `ACP_DEBUG=1` (or `ACP_DEBUG=true`).

### `autoUpdate`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** 🟢 ACTIVE
- **Description:** When enabled, check the npm registry for a newer version and show a notification. ACP never installs an update. Set to `false` to avoid startup network calls. `ACP_AUTO_UPDATE=0` or `ACP_AUTO_UPDATE=false` disables the check.

### `modelContextLimit`

- **Type:** `number`
- **Default:** *(auto)* — the model's `contextWindow` read live each turn
- **Status:** 🟢 ACTIVE
- **Description:** Override the context limit, in tokens. By default the limit is read from the active model's `ctx.model.contextWindow` on every turn, so it stays correct when you switch models. Set an explicit value for deterministic test runs or headless/non-interactive sessions where the model metadata may be unavailable. The `ACP_MODEL_CONTEXT_LIMIT` environment variable takes precedence over this value.

### `toolBashDefaultTimeout`

- **Type:** `number`
- **Default:** `60`
- **Status:** 🟢 ACTIVE
- **Description:** The number of seconds injected into the `bash` tool when the model omits the `timeout` parameter. Pi has **no** built-in default timeout of its own, so without this guard a command the model forgets to time out can hang for thousands of seconds. On timeout the model is guided to re-run the command with a larger `timeout`. Set to `0` to disable this guard and restore Pi's unbounded behavior.

### `toolOutputMaxBytes`

- **Type:** `number`
- **Default:** `200000`
- **Status:** 🟢 ACTIVE
- **Description:** A byte cap applied to tool result text via the `tool_result` hook. Before ACP caps text, it stores the complete text in private content-addressed gzip storage and includes an `acp_artifact` retrieval ID. Non-text result blocks remain intact. If spooling or quota validation fails, ACP does not apply an additional cap and reports the recoverable inline or host-file source. Set lower (for example, `8192`) for a tighter context budget, or set to `0` to disable the cap.

---

## Delegate

The `delegate` sub-object controls the `acp_delegate` sub-agent tool family (`acp_delegate`, `acp_delegate_wait`, `acp_delegate_cancel`) and how their token usage is reported.

> **Backward compatibility:** For convenience, `delegate` accepts both an object and a boolean shorthand:
> - `delegate: true` is treated as `delegate: { enabled: true }`.
> - The legacy flat top-level `displayUsage` key is still accepted as an alias for `delegate.displayUsage`. Prefer the nested `delegate.displayUsage` form.

### `delegate.enabled`

- **Type:** `boolean`
- **Default:** `true`
- **Status:** 🟢 ACTIVE
- **Description:** Enable the `acp_delegate` tools (`acp_delegate`, `acp_delegate_wait`, `acp_delegate_cancel`) and the system-prompt section that describes them. Set to `false` to skip registering them entirely — for example, if you use a different sub-agent extension, or when running headless where async result injection adds no value.

### `delegate.displayUsage`

- **Type:** string enum `"merged" | "separate"`
- **Default:** `"separate"`
- **Status:** 🟢 ACTIVE
- **Description:** Controls how delegate sub-agent token usage is reported back to the main session. `"separate"` (default) tracks delegate tokens in a separate accumulator — the main session totals stay clean and delegate usage shows as its own block in `acp_status` (excluded from main totals). `"merged"` folds delegate token usage into the tool-result `usage` field so it is counted as part of the main session totals. Only meaningful when `delegate.enabled` is `true`.

---

## Compression Tuning

The `compress` sub-object groups the three thresholds that form a **three-tier escalation** for context management. They control *when* the model is nudged to compress and *when* large outputs are forcibly truncated to keep the session alive. Lower thresholds mean the extension compresses earlier and more aggressively.

The flow is:

1. **Growth-driven soft nudges** (0–75%) — governed by `compress.nudgeGrowthTokens`.
2. **Forced nudges** (75–95%) — once usage crosses `compress.maxContextLimit`, nudges fire regardless of the growth gate. These are lossless.
3. **Emergency truncation** (95%+) — once usage crosses `compress.emergencyThresholdPercent`, large inline tool output is externalized and truncated to prevent context overflow. The complete output remains retrievable when durable spooling succeeds; ACP skips its additional cap if spooling fails.

### `compress.maxContextLimit`

- **Type:** `number | string`
- **Default:** `0.75` (or `"75%"`)
- **Status:** 🟢 ACTIVE
- **Description:** The context-usage threshold that triggers **forced compression** nudges. Once usage reaches this level, nudges fire on every turn, bypassing the growth-gate and cadence checks that normally throttle them. Accepts a ratio (`0.75`) or a percent string (`"75%"`). A lower value makes the extension compress earlier and more aggressively. Maps to the kernel setting `nudge.maxContextLimitPct`.

### `compress.emergencyThresholdPercent`

- **Type:** `number | string`
- **Default:** `0.95` (or `"95%"`)
- **Status:** 🟢 ACTIVE
- **Description:** The context-usage threshold that triggers **emergency truncation** of large tool outputs to keep the session alive when context is nearly full. Accepts a ratio (`0.95`) or a percent string (`"95%"`). This value **must be greater than or equal to** `compress.maxContextLimit`, otherwise the escalation order breaks. Maps to the kernel settings `nudge.emergencyThresholdPct` and `truncate.threshold`.

### `compress.nudgeGrowthTokens`

- **Type:** `number`
- **Default:** `50000`
- **Status:** 🟢 ACTIVE
- **Description:** The token-growth threshold that controls the cadence of **soft** compression nudges. A soft nudge fires roughly every time this many tokens of new compressible content accumulate. A lower value means the model is nudged to compress more often; a higher value means less frequent nudges. This only governs *growth-driven* nudges — once usage crosses `compress.maxContextLimit`, forced nudges take over regardless of this setting. Maps to the kernel settings `nudge.growthFloor` and `nudge.growthCap`.

### Compression model routing

Use `/acp-model` to select an authenticated compression model, then `/acp-settings` to choose its thinking level and the writer independently for Tier 1, Tier 2, and Tier 3. Both commands persist their choices in the current project's `.pi/acp.json`. Edit `~/.pi/acp.json` explicitly only when you want a global default.

- **`compress.model`** — `provider/model-id` selected by `/acp-model`. No default.
- **`compress.thinkingLevel`** — configured-model thinking level; default `"medium"`. `/acp-settings` offers only levels supported by the selected model.
- **`compress.tier1Compressor`** — `"main"` or `"configured"`; default `"main"`.
- **`compress.tier2Compressor`** — `"main"` or `"configured"`; default `"main"`.
- **`compress.tier3Compressor`** — `"main"` or `"configured"`; default `"main"`.

When a tier uses `"configured"`, the main agent still decides when and what to compress. The selected model receives only the resolved source range, framed as untrusted JSON data under a separate system policy, and writes the summary. Unselected recent context and protected tool results are not forwarded. Its usage is attached to the `compress` tool result. If it fails, ACP visibly falls back to the authenticated main model. Configured compressors require Pi 0.84.1 or newer.

---

## Prompts Customization

The `prompts` object overrides acp-kernel's **load-bearing** compression prompt rules — the verbatim instructions the model receives about *how* to write summaries (keep full file paths, function signatures, decisions and rationale; drop verbose logs, etc.). These four fields are embedded into the system prompt and the compression nudge text:

| Field | What it governs |
|-------|-----------------|
| `compressPhilosophy` | The two failure modes to avoid (over-/under-compression) and the single test for when to compress. |
| `howToCompressRules` | Tier-1 rules: what to KEEP verbatim vs DROP, and the summary priority order. |
| `tier2DistillRules` | Tier-2 distillation rules (decisions/outcomes only). |
| `tier3CondenseRules` | Tier-3 ultra-condensation rules (bare facts). |

> ⚠️ **Quality risk.** These rules are tuned for retrieval quality. Replacing them with looser text can silently degrade summaries — lost paths, signatures, and decisions lead to worse reconstruction later. The `acknowledgePromptsRisk` gate exists to make this an explicit, deliberate choice.

### `prompts`

- **Type:** `object` (partial — omit fields to keep their defaults)
- **Default:** *(kernel defaults)* — the verbatim rules shipped with acp-kernel
- **Status:** 🟢 ACTIVE
- **Description:** Override one or more of the four compression prompt fields. Each field you set replaces the kernel default **verbatim**; fields you omit are inherited unchanged. Non-string values are silently dropped (only deliberate string overrides apply). Requires `acknowledgePromptsRisk: true` — without it, every override is dropped and the defaults are used, with a warning logged. Example:

  ```json
  {
    "prompts": {
      "compressPhilosophy": "Compress aggressively; prefer signal over completeness.",
      "howToCompressRules": "Keep file paths + signatures verbatim. Drop verbose logs.",
      "tier2DistillRules": "Decisions and outcomes only; drop process and paths.",
      "tier3CondenseRules": "One line per block: bare facts only."
    },
    "acknowledgePromptsRisk": true
  }
  ```

### `acknowledgePromptsRisk`

- **Type:** `boolean`
- **Default:** `false`
- **Status:** 🟢 ACTIVE
- **Description:** The safety gate for `prompts` overrides. Set to `true` to acknowledge that replacing the kernel's tuned compression rules may reduce summary quality, and to make your `prompts` overrides take effect. When `false` (or omitted), all `prompts` overrides are ignored and the kernel defaults are used. If `resolvePrompts` rejects your override (for example a malformed value that still passes the type check), the extension falls back to the defaults and logs a `prompts-resolve-failed` warning rather than failing to start.

---

## Environment Variables

Environment variables take precedence over the JSON config files. They are useful for one-off overrides, CI runs, and headless sessions where you want to avoid editing config files.

### `ACP_AUTO_UPDATE`

- **Type:** string flag
- **Default:** *(unset — auto-update follows the `autoUpdate` config)*
- **Status:** 🟢 ACTIVE
- **Description:** Set to `0` or `false` to **disable** auto-update (same effect as `"autoUpdate": false`). Leave unset to honor the config. This is the recommended way to disable startup network calls in locked-down environments without modifying `acp.json`.

### `ACP_MODEL_CONTEXT_LIMIT`

- **Type:** integer (tokens)
- **Default:** *(unset — limit follows `modelContextLimit`, then the live model context window)*
- **Status:** 🟢 ACTIVE
- **Description:** Override the context limit, in tokens. **Takes the highest precedence** — overrides the `modelContextLimit` config value. Useful for forcing a specific limit in test harnesses and headless runs where model metadata is unavailable or unreliable.

### `ACP_DEBUG`

- **Type:** string flag
- **Default:** *(unset — debug logging follows the `debug` config)*
- **Status:** 🟢 ACTIVE
- **Description:** Set to `1` or `true` to enable debug-level logging. Equivalent to setting `"debug": true` in the config, but applied without editing a file. The always-on lifecycle/error/warning events are written regardless.

### `ACP_LOG_FILE`

- **Type:** string (file path)
- **Default:** `~/.pi/acp.log`
- **Status:** 🟢 ACTIVE
- **Description:** Override the path to the log file. By default, structured logs are written to `~/.pi/acp.log` (the file rotates to `~/.pi/acp.log.old` at 10 MB). Point this at a different location to keep per-project or per-run logs separate.
