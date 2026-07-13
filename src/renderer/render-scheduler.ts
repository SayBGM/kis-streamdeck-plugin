import {
  isEffectiveRenderIntervalMs,
  type EffectiveRenderIntervalMs,
} from "../core/ui-update-policy.js";

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
  readonly supersededSkips: number;
  readonly staleDrops: number;
  readonly failures: number;
}

interface ScheduledRequest extends RenderRequest {
  readonly sequence: number;
}

interface TimerToken {
  handle?: unknown;
}

interface TargetState {
  readonly id: string;
  readonly generation: number;
  readonly lane: TargetLane;
  normalIntervalMs: EffectiveRenderIntervalMs;
  pendingImmediate?: ScheduledRequest;
  pendingRegular?: ScheduledRequest;
  timer?: TimerToken;
  inFlight: boolean;
  lastSemanticKey?: string;
  lastImage?: string;
  readonly lastFlushAt: Partial<Record<Exclude<RenderCategory, "immediate">, number>>;
  readonly windowStartedAt: Partial<Record<Exclude<RenderCategory, "immediate">, number>>;
}

interface TargetLane {
  readonly id: string;
  tail: Promise<void>;
  activeOperations: number;
  queuedCommits: number;
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
 * Normal quotes use the configured realtime/throttled trailing window, control
 * states use a one second trailing window, and manual/fatal requests bypass
 * the wait. A target generation fences async work from disappeared or
 * reconfigured buttons.
 */
export class RenderScheduler {
  private readonly dependencies: RenderSchedulerDependencies;
  private readonly targets = new Map<string, TargetState>();
  private readonly lanes = new Map<string, TargetLane>();
  private destroyed = false;
  private nextGeneration = 0;
  private nextSequence = 0;
  private monotonicNow = Number.NEGATIVE_INFINITY;
  private readonly counters = {
    submitted: 0,
    coalesced: 0,
    renders: 0,
    commits: 0,
    semanticSkips: 0,
    imageSkips: 0,
    supersededSkips: 0,
    staleDrops: 0,
    failures: 0,
  };

  constructor(dependencies: Partial<RenderSchedulerDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  /** Activates a target and returns its new lifecycle generation. */
  activate(targetId: string, normalIntervalMs: EffectiveRenderIntervalMs): number {
    if (this.destroyed) {
      throw new Error("RenderScheduler is destroyed");
    }
    this.assertInterval(normalIntervalMs);

    const previous = this.targets.get(targetId);
    if (previous) {
      this.cancelTimer(previous);
      previous.pendingImmediate = undefined;
      previous.pendingRegular = undefined;
      this.targets.delete(targetId);
    }

    const lane = previous?.lane ?? this.getOrCreateLane(targetId);
    const generation = ++this.nextGeneration;
    this.targets.set(targetId, {
      id: targetId,
      generation,
      lane,
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
    normalIntervalMs: EffectiveRenderIntervalMs,
  ): boolean {
    this.assertInterval(normalIntervalMs);
    const state = this.current(targetId, generation);
    if (!state) return false;
    if (state.normalIntervalMs === normalIntervalMs) return true;

    state.normalIntervalMs = normalIntervalMs;
    if (state.pendingRegular?.category === "normal") {
      state.windowStartedAt.normal = this.now();
      this.cancelTimer(state);
      this.schedulePending(state);
    }
    return true;
  }

  /**
   * Submits a full rendering intent. Immediate work has strict priority and
   * LWW-coalesces independently; normal/control work shares a lower-priority
   * LWW slot. Commits stay serialized across lifecycle generations.
   */
  submit(targetId: string, generation: number, request: RenderRequest): boolean {
    const state = this.current(targetId, generation);
    if (!state) {
      this.counters.staleDrops += 1;
      return false;
    }

    const scheduled = this.snapshotRequest(request);
    if (!scheduled) {
      this.counters.failures += 1;
      return false;
    }

    this.counters.submitted += 1;
    if (scheduled.category === "immediate") {
      if (state.pendingImmediate) this.counters.coalesced += 1;
      state.pendingImmediate = scheduled;
      if (state.pendingRegular) {
        this.counters.coalesced += 1;
        const category = state.pendingRegular.category as Exclude<RenderCategory, "immediate">;
        delete state.windowStartedAt[category];
        state.pendingRegular = undefined;
      }
      this.cancelTimer(state);
      if (!state.inFlight) void this.drain(state);
      return true;
    }

    const regularCategory = scheduled.category as Exclude<RenderCategory, "immediate">;
    const previousCategory = state.pendingRegular?.category as
      | Exclude<RenderCategory, "immediate">
      | undefined;
    if (state.pendingRegular) this.counters.coalesced += 1;
    if (previousCategory && previousCategory !== scheduled.category) {
      delete state.windowStartedAt[previousCategory];
    }
    state.pendingRegular = scheduled;
    if (state.windowStartedAt[regularCategory] === undefined) {
      state.windowStartedAt[regularCategory] = this.now();
    }
    if (!state.inFlight) {
      this.cancelTimer(state);
      if (state.pendingImmediate) void this.drain(state);
      else this.schedulePending(state);
    }
    return true;
  }

  /** Removes a target only when the caller still owns its generation. */
  remove(targetId: string, generation: number): boolean {
    const state = this.current(targetId, generation);
    if (!state) return false;
    this.cancelTimer(state);
    state.pendingImmediate = undefined;
    state.pendingRegular = undefined;
    this.targets.delete(targetId);
    this.cleanupLane(state.lane);
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const state of this.targets.values()) {
      this.cancelTimer(state);
      state.pendingImmediate = undefined;
      state.pendingRegular = undefined;
    }
    this.targets.clear();
    for (const lane of this.lanes.values()) this.cleanupLane(lane);
  }

  getDiagnostics(): RenderSchedulerDiagnostics {
    let queuedTargets = 0;
    for (const state of this.targets.values()) {
      if (state.pendingImmediate || state.pendingRegular || state.inFlight) queuedTargets += 1;
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
    let candidate: number;
    try {
      candidate = this.dependencies.now();
    } catch {
      this.counters.failures += 1;
      candidate = Number.NaN;
    }
    if (Number.isFinite(candidate)) {
      this.monotonicNow = Math.max(this.monotonicNow, candidate);
    } else if (this.monotonicNow === Number.NEGATIVE_INFINITY) {
      this.monotonicNow = 0;
    }
    return this.monotonicNow;
  }

  private schedulePending(state: TargetState): void {
    if (!this.isCurrent(state) || state.inFlight || state.timer) return;
    if (state.pendingImmediate) {
      void this.drain(state);
      return;
    }
    const request = state.pendingRegular;
    if (!request) return;

    const category = request.category as Exclude<RenderCategory, "immediate">;
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
    const request = state.pendingImmediate ?? state.pendingRegular;
    if (!request) return;

    if (request.category === "immediate") state.pendingImmediate = undefined;
    else state.pendingRegular = undefined;
    state.inFlight = true;
    state.lane.activeOperations += 1;

    try {
      if (request.category !== "immediate") {
        state.lastFlushAt[request.category] = this.now();
        delete state.windowStartedAt[request.category];
      }
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
      if (this.isSuperseded(state, request)) {
        this.counters.supersededSkips += 1;
        return;
      }

      if (image === state.lastImage) {
        state.lastSemanticKey = request.semanticKey;
        this.counters.imageSkips += 1;
        return;
      }

      await this.commitSerialized(state, request, image);
    } catch {
      this.counters.failures += 1;
    } finally {
      state.inFlight = false;
      state.lane.activeOperations -= 1;
      if (this.isCurrent(state)) {
        if (state.pendingImmediate) void this.drain(state);
        else if (state.pendingRegular) this.schedulePending(state);
      }
      this.cleanupLane(state.lane);
    }
  }

  private async commitSerialized(
    state: TargetState,
    request: ScheduledRequest,
    image: string,
  ): Promise<void> {
    const lane = state.lane;
    lane.queuedCommits += 1;
    const run = lane.tail.then(async () => {
      if (!this.isCurrent(state)) {
        this.counters.staleDrops += 1;
        return;
      }
      if (this.isSuperseded(state, request)) {
        this.counters.supersededSkips += 1;
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
    });
    lane.tail = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      await run;
    } finally {
      lane.queuedCommits -= 1;
      this.cleanupLane(lane);
    }
  }

  private isSuperseded(state: TargetState, request: ScheduledRequest): boolean {
    if (request.category === "immediate") {
      return (state.pendingImmediate?.sequence ?? Number.NEGATIVE_INFINITY) > request.sequence;
    }
    return Math.max(
      state.pendingImmediate?.sequence ?? Number.NEGATIVE_INFINITY,
      state.pendingRegular?.sequence ?? Number.NEGATIVE_INFINITY,
    ) > request.sequence;
  }

  private snapshotRequest(request: RenderRequest): ScheduledRequest | undefined {
    if ((typeof request !== "object" && typeof request !== "function") || request === null) {
      return undefined;
    }
    try {
      const descriptors = Object.getOwnPropertyDescriptors(request);
      const categoryDescriptor = descriptors.category;
      const keyDescriptor = descriptors.semanticKey;
      const renderDescriptor = descriptors.render;
      const commitDescriptor = descriptors.commit;
      if (
        !categoryDescriptor || !("value" in categoryDescriptor) ||
        !keyDescriptor || !("value" in keyDescriptor) ||
        !renderDescriptor || !("value" in renderDescriptor) ||
        !commitDescriptor || !("value" in commitDescriptor)
      ) {
        return undefined;
      }
      const category = categoryDescriptor.value as unknown;
      const semanticKey = keyDescriptor.value as unknown;
      const render = renderDescriptor.value as unknown;
      const commit = commitDescriptor.value as unknown;
      if (
        (category !== "normal" && category !== "control" && category !== "immediate") ||
        typeof semanticKey !== "string" ||
        typeof render !== "function" ||
        typeof commit !== "function"
      ) {
        return undefined;
      }
      return Object.freeze({
        category,
        semanticKey,
        render: render as RenderRequest["render"],
        commit: commit as RenderRequest["commit"],
        sequence: ++this.nextSequence,
      });
    } catch {
      return undefined;
    }
  }

  private getOrCreateLane(targetId: string): TargetLane {
    const existing = this.lanes.get(targetId);
    if (existing) return existing;
    const lane: TargetLane = {
      id: targetId,
      tail: Promise.resolve(),
      activeOperations: 0,
      queuedCommits: 0,
    };
    this.lanes.set(targetId, lane);
    return lane;
  }

  private cleanupLane(lane: TargetLane): void {
    if (lane.activeOperations !== 0 || lane.queuedCommits !== 0) return;
    if (this.targets.get(lane.id)?.lane === lane) return;
    if (this.lanes.get(lane.id) === lane) this.lanes.delete(lane.id);
  }

  private assertInterval(intervalMs: number): asserts intervalMs is EffectiveRenderIntervalMs {
    if (!isEffectiveRenderIntervalMs(intervalMs)) {
      throw new RangeError(`Unsupported render interval: ${intervalMs}`);
    }
  }
}
