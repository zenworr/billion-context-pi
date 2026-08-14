# Hybrid ACP workspace

This workspace contains the dependency-free `acp-kernel` and the Pi/OMP extension `billion-context-pi`.

The hybrid architecture keeps the host transcript immutable and builds a pure active projection from:

- deterministic T0 clearing with content-addressed gzip artifacts;
- atomic T1/T2/T3 summary blocks with manifests, hashes, provenance, validation, and revision checks;
- host checkpoints as overflow recovery, optional isolated configured-model checkpoints, and checkpoint epochs;
- authoritative project/world overlays, temporary pins, explicit project-memory promotion, and retrieval across messages, blocks, and artifacts;
- opt-in background distillation, shadow mode, telemetry, cost routing, and quality adaptation.

Configured cross-provider compression requires both consent settings. Configured inputs are split below 220,000 tokens. Updates are notification-only and are never installed automatically.

Safety properties:

- ACP protects the first user request, the complete current turn, non-text media, pins, and provider protocol groups as indivisible working-set data.
- Final-request accounting includes the projected history, authoritative project/world overlays, pins, nudge text, media estimates, and calibrated host overhead. The same projection controls status, the hard tool gate, and threshold-compaction cancellation.
- Plaintext reasoning is preserved by default. Optional `safe-only` clearing requires an unsigned provider-agnostic reasoning block with a complete companion response.
- Tool output is capped only after exact durable spooling succeeds. If storage or quota checks fail, ACP does not apply an additional irreversible cap.
- Checkpoints record direct transactional ownership and parent links. They do not copy all ancestral message IDs into each epoch.
- Provider work uses a fresh source/model/auth/consent preflight. Invalid configured summaries get one configured repair attempt, then an authenticated main-model or host fallback.

## Verification

```bash
npm run verify
npm run e2e
npm run eval
```

See `packages/pi-extension/CONFIGURATION.md` and `packages/kernel/DESIGN.md` for package details.
