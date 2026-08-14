import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { logWarn } from "./log.js";

const RETRIEVAL_RETENTION_MS = 30 * 60 * 1_000;

export async function recordRecentRetrievals(runtime: AcpRuntime, ctx: ExtensionContext, refs: readonly string[]): Promise<void> {
  if (refs.length === 0) return;
  const sid = ctx.sessionManager.getSessionId();
  const release = await runtime.acquireLock(sid);
  try {
    const { state } = await runtime.stateFor(ctx);
    const now = Date.now();
    const recent = Object.fromEntries(Object.entries(state.policyState.recentRetrievals)
      .filter(([, timestamp]) => now - timestamp <= RETRIEVAL_RETENTION_MS));
    const expanded = new Set(refs);
    for (const ref of refs) {
      const raw = state.messageRefs.byRef[ref] ?? ref;
      const checkpoint = state.checkpoints.find((candidate) => candidate.id === ref
        || candidate.sourceMessageIds.includes(raw)
        || candidate.directSourceMessageIds?.includes(raw));
      if (checkpoint) {
        expanded.add(checkpoint.id);
        let parent = checkpoint.parentCheckpointId;
        while (parent) {
          expanded.add(parent);
          parent = state.checkpoints.find((candidate) => candidate.id === parent)?.parentCheckpointId;
        }
      }
      const blockIds = new Set(state.blocks
        .filter((block) => block.blockId === ref || block.effectiveMessageIds.includes(raw) || block.directMessageIds.includes(raw))
        .map((block) => block.blockId));
      let changed = true;
      while (changed) {
        changed = false;
        for (const block of state.blocks) {
          if (blockIds.has(block.blockId)) continue;
          if (block.directBlockIds?.some((child) => blockIds.has(child)) || (block.active && block.effectiveMessageIds.includes(raw))) {
            blockIds.add(block.blockId);
            changed = true;
          }
        }
      }
      for (const blockId of blockIds) expanded.add(blockId);
    }
    for (const ref of expanded) recent[ref] = now;
    await runtime.save({
      ...state,
      metadataRevision: state.metadataRevision + 1,
      policyState: { ...state.policyState, recentRetrievals: recent },
    }, ctx);
  } catch (error) {
    logWarn("retrieval", { event: "tracking-failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    release();
  }
}

export function wasRecentlyRetrieved(timestamp: number | undefined, now = Date.now()): boolean {
  return timestamp !== undefined && now - timestamp <= RETRIEVAL_RETENTION_MS;
}
