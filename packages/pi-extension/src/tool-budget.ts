const MIN_RESERVATION_BYTES = 8 * 1024;
const RESERVATION_LEASE_MS = 2 * 60_000;
const COMPLETED_LEASE_MS = 15_000;
const RECOVERY_REQUEST_BUDGET_BYTES = 64 * 1024;

interface Reservation {
  callId: string;
  toolName: string;
  bytes: number;
  expiresAt: number;
  completed: boolean;
  recovery: boolean;
}

interface SessionBudget {
  requestKey: string;
  remainingBytes: number;
  recoveryRemainingBytes: number;
  reservations: Map<string, Reservation>;
}

export interface ReservationResult {
  allowed: boolean;
  capBytes: number;
  reason?: string;
}

/** Per-provider-request fan-out budget for concurrent tool results. */
export class ToolOutputBudget {
  private sessions = new Map<string, SessionBudget>();

  startRequest(sessionId: string, requestKey: string, estimatedTokens: number, hardLimit: number): void {
    const current = this.sessions.get(sessionId);
    if (current?.requestKey === requestKey) return;
    this.sessions.set(sessionId, {
      requestKey,
      remainingBytes: Math.max(0, hardLimit - estimatedTokens) * 4,
      recoveryRemainingBytes: RECOVERY_REQUEST_BUDGET_BYTES,
      reservations: new Map(),
    });
  }

  reserve(sessionId: string, callId: string, toolName: string, configuredCap: number, recovery: boolean): ReservationResult {
    const budget = this.sessions.get(sessionId);
    if (!budget) return { allowed: true, capBytes: configuredCap };
    this.prune(budget);
    const existing = budget.reservations.get(callId);
    if (existing) return { allowed: true, capBytes: existing.bytes };
    const active = [...budget.reservations.values()].filter((item) => !item.completed);
    if (!recovery && active.length > 0 && budget.remainingBytes < MIN_RESERVATION_BYTES * 2) {
      return {
        allowed: false,
        capBytes: 0,
        reason: "ACP cumulative output budget is near its limit. Run this tool after the pending tool finishes so execution is sequential.",
      };
    }
    const available = recovery ? budget.recoveryRemainingBytes : budget.remainingBytes;
    const fanoutShare = Math.floor(available / Math.max(2, active.length + 2));
    const bytes = Math.max(0, Math.min(configuredCap, fanoutShare));
    if (bytes < MIN_RESERVATION_BYTES && configuredCap > 0) {
      return { allowed: false, capBytes: 0, reason: "ACP has no safe cumulative output budget for this parallel tool call. Complete recovery or host checkpointing first." };
    }
    const reservation: Reservation = {
      callId,
      toolName,
      bytes,
      expiresAt: Date.now() + RESERVATION_LEASE_MS,
      completed: false,
      recovery,
    };
    budget.reservations.set(callId, reservation);
    if (recovery) budget.recoveryRemainingBytes = Math.max(0, budget.recoveryRemainingBytes - bytes);
    else budget.remainingBytes = Math.max(0, budget.remainingBytes - bytes);
    return { allowed: true, capBytes: bytes };
  }

  capFor(sessionId: string, callId: string, fallback: number): number {
    const budget = this.sessions.get(sessionId);
    if (!budget) return fallback;
    this.prune(budget);
    return budget.reservations.get(callId)?.bytes ?? fallback;
  }

  markCompleted(sessionId: string, callId: string): void {
    const reservation = this.sessions.get(sessionId)?.reservations.get(callId);
    if (!reservation) return;
    reservation.completed = true;
    reservation.expiresAt = Date.now() + COMPLETED_LEASE_MS;
  }

  release(sessionId: string, callId: string, actualBytes?: number): void {
    const budget = this.sessions.get(sessionId);
    const reservation = budget?.reservations.get(callId);
    if (!budget || !reservation) return;
    budget.reservations.delete(callId);
    const unused = Math.max(0, reservation.bytes - Math.max(0, actualBytes ?? reservation.bytes));
    if (reservation.recovery) budget.recoveryRemainingBytes += unused;
    else budget.remainingBytes += unused;
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.sessions.clear();
    else this.sessions.delete(sessionId);
  }

  snapshot(sessionId: string): { pending: number; remainingBytes: number; recoveryRemainingBytes: number } | undefined {
    const budget = this.sessions.get(sessionId);
    if (!budget) return undefined;
    this.prune(budget);
    return { pending: budget.reservations.size, remainingBytes: budget.remainingBytes, recoveryRemainingBytes: budget.recoveryRemainingBytes };
  }

  private prune(budget: SessionBudget): void {
    const now = Date.now();
    for (const [callId, reservation] of budget.reservations) {
      if (reservation.expiresAt > now) continue;
      budget.reservations.delete(callId);
      if (reservation.recovery) budget.recoveryRemainingBytes += reservation.bytes;
      else budget.remainingBytes += reservation.bytes;
    }
  }
}
