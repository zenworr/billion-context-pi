export type BackgroundTrigger = "turn_end" | "agent_end";
export type BackgroundCancelReason = "tree" | "model" | "session" | "shutdown";

export interface JobSnapshot {
  sessionId: string;
  revision: number;
  sourceHashes: Readonly<Record<string, string>>;
  treeKey: string;
  modelKey: string;
}

export type BackgroundJobOutcome = "committed" | "shadowed" | "stale" | "aborted" | "failed" | "skipped";

export interface BackgroundJobCallbacks<Snapshot extends JobSnapshot, Proposal> {
  capture(signal: AbortSignal): Promise<Snapshot | undefined>;
  generate(snapshot: Snapshot, signal: AbortSignal): Promise<Proposal>;
  current(snapshot: Snapshot, signal: AbortSignal): Promise<Snapshot | undefined>;
  commit(snapshot: Snapshot, proposal: Proposal, signal: AbortSignal): Promise<boolean>;
  shadow?: boolean;
  maxReplans?: number;
  onOutcome?: (outcome: BackgroundJobOutcome, durationMs: number) => void;
}

export class TransactionalBackgroundJobs {
  private readonly controllers = new Set<AbortController>();
  private readonly activeKeys = new Set<string>();
  private readonly pending = new Set<Promise<BackgroundJobOutcome>>();

  schedule<Snapshot extends JobSnapshot, Proposal>(trigger: BackgroundTrigger, callbacks: BackgroundJobCallbacks<Snapshot, Proposal>): Promise<BackgroundJobOutcome> {
    if (trigger !== "turn_end" && trigger !== "agent_end") return Promise.resolve("skipped");
    const controller = new AbortController();
    this.controllers.add(controller);
    const started = Date.now();
    const job = this.run(callbacks, controller, Math.max(0, callbacks.maxReplans ?? 1))
      .catch((): BackgroundJobOutcome => controller.signal.aborted ? "aborted" : "failed")
      .then((outcome) => {
        callbacks.onOutcome?.(outcome, Date.now() - started);
        return outcome;
      })
      .finally(() => {
        this.controllers.delete(controller);
        this.pending.delete(job);
      });
    this.pending.add(job);
    return job;
  }

  cancelAll(_reason: BackgroundCancelReason): void {
    for (const controller of this.controllers) controller.abort();
    this.activeKeys.clear();
  }

  async waitForIdle(): Promise<BackgroundJobOutcome[]> {
    return Promise.all([...this.pending]);
  }

  private async run<Snapshot extends JobSnapshot, Proposal>(
    callbacks: BackgroundJobCallbacks<Snapshot, Proposal>,
    controller: AbortController,
    replansRemaining: number,
  ): Promise<BackgroundJobOutcome> {
    if (controller.signal.aborted) return "aborted";
    const snapshot = await callbacks.capture(controller.signal);
    if (!snapshot) return "skipped";
    const key = snapshotKey(snapshot);
    if (this.activeKeys.has(key)) return "skipped";
    this.activeKeys.add(key);
    try {
      // Run the same staleness check immediately before any paid provider call.
      const preflight = await callbacks.current(snapshot, controller.signal);
      if (!preflight || !sameSnapshot(snapshot, preflight)) {
        if (replansRemaining > 0 && !controller.signal.aborted) {
          this.activeKeys.delete(key);
          return this.run(callbacks, controller, replansRemaining - 1);
        }
        return controller.signal.aborted ? "aborted" : "stale";
      }
      const proposal = await callbacks.generate(snapshot, controller.signal);
      if (controller.signal.aborted) return "aborted";
      const current = await callbacks.current(snapshot, controller.signal);
      if (!current || !sameSnapshot(snapshot, current)) {
        if (replansRemaining > 0 && !controller.signal.aborted) {
          this.activeKeys.delete(key);
          return this.run(callbacks, controller, replansRemaining - 1);
        }
        return "stale";
      }
      if (callbacks.shadow) return "shadowed";
      if (controller.signal.aborted) return "aborted";
      return await callbacks.commit(snapshot, proposal, controller.signal) ? "committed" : (controller.signal.aborted ? "aborted" : "stale");
    } finally {
      this.activeKeys.delete(key);
    }
  }
}

export function sameSnapshot(left: JobSnapshot, right: JobSnapshot): boolean {
  if (left.sessionId !== right.sessionId || left.revision !== right.revision) return false;
  if (left.treeKey !== right.treeKey || left.modelKey !== right.modelKey) return false;
  const leftEntries = Object.entries(left.sourceHashes).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right.sourceHashes).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([key, hash], index) => rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === hash);
}

function snapshotKey(snapshot: JobSnapshot): string {
  return `${snapshot.sessionId}\0${snapshot.revision}\0${snapshot.treeKey}\0${snapshot.modelKey}\0${JSON.stringify(snapshot.sourceHashes)}`;
}
