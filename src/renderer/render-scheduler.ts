export const RENDER_INTERVALS_MS = [2_000, 5_000, 10_000] as const;

export type RenderIntervalMs = (typeof RENDER_INTERVALS_MS)[number];
export type RenderCategory = "normal" | "control" | "immediate";

/**
 * A complete, immutable rendering intent. `semanticKey` must include every
 * caller-visible field (name/session/price/rate/sign/connection/stale).
 */
export interface RenderRequest {
  readonly category: RenderCategory;
  readonly semanticKey: string;
  readonly render: () => string | Promise<string>;
  readonly commit: (image: string) => void | Promise<void>;
}

export interface RenderSchedulerDependencies {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface RenderSchedulerDiagnostics {
  readonly activeTargets: number;
  readonly queuedTargets: number;
  readonly submitted: number;
  readonly coalesced: number;
  readonly renders: number;
  readonly commits: number;
  readonly semanticSkips: number;
  readonly imageSkips: number;
  readonly staleDrops: number;
  readonly failures: number;
}

type ScheduledRequest = RenderRequest;

interface TimerToken {
  handle?: unknown;
}

interface TargetState {
  readonly id: string;
  readonly generation: number;
  normalIntervalMs: RenderIntervalMs;
  pending?: ScheduledRequest;
  timer?: TimerToken;
  inFlight: boolean;
  lastSemanticKey?: string;
  lastImage?: string;
  readonly lastFlushAt: Partial<Record<Exclude<RenderCategory, "immediate">, number>>;
  readonly windowStartedAt: Partial<Record<Exclude<RenderCategory, "immediate">, number>>;
}

const CONTROL_INTERVAL_MS = 1_000;

const defaultDependencies: RenderSchedulerDependencies = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Per-button LWW render coordinator.
 *
 * Normal quotes use the configured 2/5/10 second trailing window, control
 * states use a one second trailing window, and manual/fatal requests bypass
 * the wait. A target generation fences async work from disappeared or
 * reconfigured buttons.
 */
export class RenderScheduler {
  private readonly dependencies: RenderSchedulerDependencies;
  private readonly targets = new Map<string, TargetState>();
  private readonly generationCounters = new Map<string, number>();
  private destroyed = false;
  private monotonicNow = Number.NEGATIVE_INFINITY;
  private readonly counters = {
    submitted: 0,
    coalesced: 0,
    renders: 0,
    commits: 0,
    semanticSkips: 0,
    imageSkips: 0,
    staleDrops: 0,
    failures: 0,
  };

  constructor(dependencies: Partial<RenderSchedulerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  /** Activates a target and returns its new lifecycle generation. */
  activate(targetId: string, normalIntervalMs: RenderIntervalMs): number {
    if (this.destroyed) {
      throw new Error("RenderScheduler is destroyed");
    }
    this.assertInterval(normalIntervalMs);

    const previous = this.targets.get(targetId);
    if (previous) {
      this.cancelTimer(previous);
      this.targets.delete(targetId);
    }

    const generation = (this.generationCounters.get(targetId) ?? 0) + 1;
    this.generationCounters.set(targetId, generation);
    this.targets.set(targetId, {
      id: targetId,
      generation,
      normalIntervalMs,
      inFlight: false,
      lastFlushAt: {},
      windowStartedAt: {},
    });
    return generation;
  }

  /** Changes only this target's normal quote interval. */
  updateInterval(
    targetId: string,
    generation: number,
    normalIntervalMs: RenderIntervalMs,
  ): boolean {
    this.assertInterval(normalIntervalMs);
    const state = this.current(targetId, generation);
    if (!state) return false;

    state.normalIntervalMs = normalIntervalMs;
    if (state.pending?.category === "normal") {
      state.windowStartedAt.normal = this.now();
      this.cancelTimer(state);
      this.schedulePending(state);
    }
    return true;
  }

  /**
   * Submits a full rendering intent. The newest pending intent replaces any
   * older category, while in-flight render/IPC work remains serialized.
   */
  submit(targetId: string, generation: number, request: RenderRequest): boolean {
    const state = this.current(targetId, generation);
    if (!state) {
      this.counters.staleDrops += 1;
      return false;
    }

    this.counters.submitted += 1;
    const previousCategory = state.pending?.category;
    if (state.pending) this.counters.coalesced += 1;
    if (previousCategory && previousCategory !== request.category && previousCategory !== "immediate") {
      delete state.windowStartedAt[previousCategory];
    }

    const scheduled: ScheduledRequest = Object.freeze({
      category: request.category,
      semanticKey: request.semanticKey,
      render: request.render,
      commit: request.commit,
    });
    state.pending = scheduled;

    if (request.category === "immediate") {
      this.cancelTimer(state);
      delete state.windowStartedAt.normal;
      delete state.windowStartedAt.control;
      if (!state.inFlight) void this.drain(state);
      return true;
    }

    if (state.windowStartedAt[request.category] === undefined) {
      state.windowStartedAt[request.category] = this.now();
    }
    if (!state.inFlight) {
      this.cancelTimer(state);
      this.schedulePending(state);
    }
    return true;
  }

  /** Removes a target only when the caller still owns its generation. */
  remove(targetId: string, generation: number): boolean {
    const state = this.current(targetId, generation);
    if (!state) return false;
    this.cancelTimer(state);
    state.pending = undefined;
    this.targets.delete(targetId);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const state of this.targets.values()) {
      this.cancelTimer(state);
      state.pending = undefined;
    }
    this.targets.clear();
  }

  getDiagnostics(): RenderSchedulerDiagnostics {
    let queuedTargets = 0;
    for (const state of this.targets.values()) {
      if (state.pending || state.inFlight) queuedTargets += 1;
    }
    return Object.freeze({
      activeTargets: this.targets.size,
      queuedTargets,
      ...this.counters,
    });
  }

  private current(targetId: string, generation: number): TargetState | undefined {
    if (this.destroyed) return undefined;
    const state = this.targets.get(targetId);
    return state?.generation === generation ? state : undefined;
  }

  private isCurrent(state: TargetState): boolean {
    return !this.destroyed && this.targets.get(state.id) === state;
  }

  private now(): number {
    const candidate = this.dependencies.now();
    if (Number.isFinite(candidate)) {
      this.monotonicNow = Math.max(this.monotonicNow, candidate);
    } else if (this.monotonicNow === Number.NEGATIVE_INFINITY) {
      this.monotonicNow = 0;
    }
    return this.monotonicNow;
  }

  private schedulePending(state: TargetState): void {
    if (!this.isCurrent(state) || state.inFlight || state.timer || !state.pending) return;
    if (state.pending.category === "immediate") {
      void this.drain(state);
      return;
    }

    const category = state.pending.category;
    const interval = category === "normal" ? state.normalIntervalMs : CONTROL_INTERVAL_MS;
    const now = this.now();
    const windowStartedAt = state.windowStartedAt[category] ?? now;
    state.windowStartedAt[category] = windowStartedAt;
    const lastFlushAt = state.lastFlushAt[category];
    const dueAt = Math.max(
      windowStartedAt + interval,
      lastFlushAt === undefined ? Number.NEGATIVE_INFINITY : lastFlushAt + interval,
    );
    const delayMs = Math.max(0, dueAt - now);
    const token: TimerToken = {};
    state.timer = token;
    try {
      token.handle = this.dependencies.setTimeout(() => {
        if (!this.isCurrent(state) || state.timer !== token) return;
        state.timer = undefined;
        void this.drain(state);
      }, delayMs);
    } catch {
      if (state.timer === token) state.timer = undefined;
      this.counters.failures += 1;
      void this.drain(state);
    }
  }

  private cancelTimer(state: TargetState): void {
    const token = state.timer;
    if (!token) return;
    state.timer = undefined;
    if (token.handle === undefined) return;
    try {
      this.dependencies.clearTimeout(token.handle);
    } catch {
      this.counters.failures += 1;
    }
  }

  private async drain(state: TargetState): Promise<void> {
    if (!this.isCurrent(state) || state.inFlight) return;
    const request = state.pending;
    if (!request) return;

    state.pending = undefined;
    state.inFlight = true;
    if (request.category !== "immediate") {
      state.lastFlushAt[request.category] = this.now();
      delete state.windowStartedAt[request.category];
    }

    try {
      if (request.semanticKey === state.lastSemanticKey) {
        this.counters.semanticSkips += 1;
        return;
      }

      this.counters.renders += 1;
      const image = await request.render();
      if (!this.isCurrent(state)) {
        this.counters.staleDrops += 1;
        return;
      }

      if (image === state.lastImage) {
        state.lastSemanticKey = request.semanticKey;
        this.counters.imageSkips += 1;
        return;
      }

      await request.commit(image);
      if (!this.isCurrent(state)) {
        this.counters.staleDrops += 1;
        return;
      }
      state.lastSemanticKey = request.semanticKey;
      state.lastImage = image;
      this.counters.commits += 1;
    } catch {
      this.counters.failures += 1;
    } finally {
      state.inFlight = false;
      const nextRequest = this.peekPending(state);
      if (this.isCurrent(state) && nextRequest) {
        if (nextRequest.category === "immediate") {
          void this.drain(state);
        } else {
          this.schedulePending(state);
        }
      }
    }
  }

  // Kept behind a method boundary because callbacks can enqueue while drain()
  // awaits even though TypeScript's local control-flow analysis cannot see it.
  private peekPending(state: TargetState): ScheduledRequest | undefined {
    return state.pending;
  }

  private assertInterval(intervalMs: number): asserts intervalMs is RenderIntervalMs {
    if (!(RENDER_INTERVALS_MS as readonly number[]).includes(intervalMs)) {
      throw new RangeError(`Unsupported render interval: ${intervalMs}`);
    }
  }
}
