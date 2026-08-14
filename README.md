# Hybrid ACP workspace

This workspace contains the dependency-free `acp-kernel` and the Pi/OMP extension `billion-context-pi`.

The hybrid architecture keeps the host transcript immutable and builds a pure active projection from:

- deterministic T0 clearing with content-addressed gzip artifacts;
- atomic T1/T2/T3 summary blocks with manifests, hashes, provenance, validation, and revision checks;
- host checkpoints as overflow recovery, optional isolated configured-model checkpoints, and checkpoint epochs;
- authoritative project/world overlays, temporary pins, explicit project-memory promotion, and retrieval across messages, blocks, and artifacts;
- opt-in background distillation, shadow mode, telemetry, cost routing, and quality adaptation.

Configured cross-provider compression requires both consent settings. Configured inputs are split below 220,000 tokens. Updates are notification-only and are never installed automatically.

## Verification

```bash
npm run verify
npm run e2e
npm run eval
```

See `packages/pi-extension/CONFIGURATION.md` and `packages/kernel/DESIGN.md` for package details.
