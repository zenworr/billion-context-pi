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
    for (const ref of refs) recent[ref] = now;
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
