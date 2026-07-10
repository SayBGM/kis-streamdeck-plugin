import type { DiagnosticsStore } from "../core/diagnostics-store.js";
import { diagnosticsStore } from "../core/diagnostics-store.js";
import { KisError } from "../core/errors.js";
import { TR_ID_OVERSEAS } from "../types/index.js";
import type { ConnectionState, KisControlCommand, SupervisorListener } from "./connection-supervisor.js";

export const PHYSICAL_SUBSCRIPTION_STATES = [
  "desired",
  "pending",
  "live",
  "stale",
  "parked",
  "rejected",
] as const;

export type PhysicalSubscriptionState = (typeof PHYSICAL_SUBSCRIPTION_STATES)[number];
export type TimerHandle = unknown;

/** 승인 키와 raw socket을 노출하지 않는 ConnectionSupervisor의 최소 capability입니다. */
export interface ConnectionSupervisorPort {
  readonly state: ConnectionState;
  retain(): Promise<void>;
  release(): void;
  onMessage(listener: SupervisorListener<string>): () => void;
  onState(listener: SupervisorListener<ConnectionState>): () => void;
  sendKisControl(command: KisControlCommand): boolean;
  forceReconnect(reason?: string): void;
}

export interface SubscriptionDescriptor {
  readonly trId: string;
  readonly trKey: string;
}

export interface SubscriptionSnapshot {
  readonly descriptor: SubscriptionDescriptor;
  readonly state: PhysicalSubscriptionState;
  readonly generation: number;
  readonly refCount: number;
  readonly subscribed: boolean;
  readonly liveAt?: number;
  readonly lastDataAt?: number;
}

export interface SubscriptionDataEvent {
  readonly descriptor: SubscriptionDescriptor;
  readonly fields: readonly string[];
  readonly receivedAt: number;
  readonly generation: number;
}

export interface SubscriptionObserver {
  readonly onData?: (event: SubscriptionDataEvent) => void | Promise<void>;
  readonly onState?: (snapshot: SubscriptionSnapshot) => void | Promise<void>;
}

export interface SubscriptionHandle {
  readonly descriptor: SubscriptionDescriptor | undefined;
  readonly snapshot: SubscriptionSnapshot | undefined;
  release(): void;
}

export interface SubscriptionSupervisorOptions {
  readonly connection: ConnectionSupervisorPort;
  readonly now?: () => number;
  /** 제어 frame spacing 전용 단조 시계입니다. wall clock 변경과 무관해야 합니다. */
  readonly monotonicNow?: () => number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
  readonly setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
  readonly diagnostics?: Pick<DiagnosticsStore, "record" | "increment">;
}

interface Ref {
  readonly observer: SubscriptionObserver;
  entry: Entry | undefined;
  released: boolean;
}

interface Entry {
  readonly key: string;
  readonly descriptor: SubscriptionDescriptor;
  readonly createdAt: number;
  readonly order: number;
  generation: number;
  state: PhysicalSubscriptionState;
  subscribed: boolean;
  liveAt: number | undefined;
  lastDataAt: number | undefined;
  readonly refs: Set<Ref>;
  demand: ConnectionDemand | undefined;
  queuedAction: ControlAction | undefined;
  removing: boolean;
  retarget: Retarget | undefined;
  rotationOutgoing: Entry | undefined;
  rotationIncoming: boolean;
}

interface ConnectionDemand {
  released: boolean;
}

interface Retarget {
  readonly next: SubscriptionDescriptor;
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: KisError): void;
  settled: boolean;
}

type ControlAction = "subscribe" | "unsubscribe";

interface ControlJob {
  readonly entry: Entry;
  readonly generation: number;
  readonly action: ControlAction;
}

interface QueuedJob extends ControlJob {}

const CONTROL_SPACING_MS = 100;
const CONTROL_TIMEOUT_MS = 5_000;
const STALE_AFTER_MS = 20_000;
const STALE_CHECK_INTERVAL_MS = 1_000;
const MAX_RETIRED_DATA_KEYS = 256;
const MAX_LIVE_SUBSCRIPTIONS = 41;
const ROTATION_LEASE_MS = 60_000;
const MAX_RAW_FRAME_CHARS = 64 * 1024;
const MAX_RAW_FIELDS = 128;

function defaultSetTimeout(callback: () => void, milliseconds: number): TimerHandle {
  return setTimeout(callback, milliseconds);
}

function defaultClearTimeout(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function defaultSetInterval(callback: () => void, milliseconds: number): TimerHandle {
  return setInterval(callback, milliseconds);
}

function defaultClearInterval(handle: TimerHandle): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

function defaultMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function subscriptionError(safeMessage: string): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "websocket",
    retryable: false,
    safeMessage,
  }));
}

function descriptorKey(descriptor: SubscriptionDescriptor): string {
  return JSON.stringify([descriptor.trId, descriptor.trKey]);
}

function cloneDescriptor(descriptor: SubscriptionDescriptor): SubscriptionDescriptor {
  return Object.freeze({ trId: descriptor.trId, trKey: descriptor.trKey });
}

/**
 * WebSocket 전송 순서와 물리 구독 수명만 관리합니다. API credential, approval key,
 * 액션 UI는 이 계층 밖에 두어 늦은 socket frame이 사라진 버튼을 되살리지 못하게 합니다.
 */
export class SubscriptionSupervisor {
  private readonly connection: ConnectionSupervisorPort;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly setTimeoutFn: NonNullable<SubscriptionSupervisorOptions["setTimeout"]>;
  private readonly clearTimeoutFn: NonNullable<SubscriptionSupervisorOptions["clearTimeout"]>;
  private readonly setIntervalFn: NonNullable<SubscriptionSupervisorOptions["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<SubscriptionSupervisorOptions["clearInterval"]>;
  private readonly diagnostics: Pick<DiagnosticsStore, "record" | "increment">;
  private readonly entries = new Map<string, Entry>();
  private readonly retiredDataKeys = new Set<string>();
  private readonly stateListeners = new Set<(snapshot: SubscriptionSnapshot) => void | Promise<void>>();
  private readonly dataListeners = new Set<(event: SubscriptionDataEvent) => void | Promise<void>>();
  private readonly controlQueue: QueuedJob[] = [];
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeState: () => void;
  private currentJob: ControlJob | undefined;
  private controlTimeout: TimerHandle | undefined;
  private controlSendTimer: TimerHandle | undefined;
  private controlRetryTimer: TimerHandle | undefined;
  private staleTimer: TimerHandle | undefined;
  private rotationTimer: TimerHandle | undefined;
  private rotationCurrent: { outgoing: Entry; incoming: Entry } | undefined;
  private readonly rotationQueue: Array<{ outgoing: Entry; incoming: Entry }> = [];
  private lastSentAtMonotonic = Number.NEGATIVE_INFINITY;
  private lastMonotonic = 0;
  private controlTimeoutGeneration = 0;
  private controlSendGeneration = 0;
  private controlRetryGeneration = 0;
  private staleGeneration = 0;
  private rotationGeneration = 0;
  private entrySequence = 0;
  private requiresFreshOpen = false;
  private destroyed = false;

  constructor(options: SubscriptionSupervisorOptions) {
    this.connection = options.connection;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
    this.setTimeoutFn = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? defaultClearTimeout;
    this.setIntervalFn = options.setInterval ?? defaultSetInterval;
    this.clearIntervalFn = options.clearInterval ?? defaultClearInterval;
    this.diagnostics = options.diagnostics ?? diagnosticsStore;
    this.unsubscribeMessage = this.connection.onMessage((raw) => this.handleRawMessage(raw));
    this.unsubscribeState = this.connection.onState((state) => this.handleConnectionState(state));
    this.armIntervals();
  }

  subscribe(descriptorInput: SubscriptionDescriptor, observer: SubscriptionObserver = {}): SubscriptionHandle {
    this.assertUsable();
    const descriptor = this.normalizeDescriptor(descriptorInput);
    const key = descriptorKey(descriptor);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        descriptor,
        createdAt: this.safeNow(),
        order: ++this.entrySequence,
        generation: 1,
        state: "desired",
        subscribed: false,
        liveAt: undefined,
        lastDataAt: undefined,
        refs: new Set(),
        demand: { released: false },
        queuedAction: undefined,
        removing: false,
        retarget: undefined,
        rotationOutgoing: undefined,
        rotationIncoming: false,
      };
      this.entries.set(key, entry);
      void Promise.resolve(this.connection.retain()).then(
        () => this.pump(),
        () => this.recordSettingsFailure(),
      );
    }
    this.retiredDataKeys.delete(key);
    if (entry.removing && entry.refs.size === 0) entry.removing = false;

    const ref: Ref = { observer: this.normalizeObserver(observer), entry, released: false };
    entry.refs.add(ref);
    this.enforceSubscriptionCap();
    this.publishState(entry, ref);
    this.enqueueSubscribe(entry);
    this.pump();

    return Object.freeze({
      get descriptor() {
        return ref.entry?.descriptor;
      },
      get snapshot() {
        return ref.entry ? SubscriptionSupervisor.toSnapshot(ref.entry) : undefined;
      },
      release: () => this.releaseRef(ref),
    });
  }

  /**
   * 해외 주간/야간 키처럼 하나의 physical 구독 키가 바뀔 때 사용합니다.
   * 기존 서버 구독 해제 확인 전에는 새 키의 subscribe frame을 넣지 않습니다.
   */
  retargetAll(oldInput: SubscriptionDescriptor, nextInput: SubscriptionDescriptor): Promise<void> {
    this.assertUsable();
    const oldDescriptor = this.normalizeDescriptor(oldInput);
    const nextDescriptor = this.normalizeDescriptor(nextInput);
    if (descriptorKey(oldDescriptor) === descriptorKey(nextDescriptor)) return Promise.resolve();
    const entry = this.entries.get(descriptorKey(oldDescriptor));
    if (!entry) return Promise.resolve();
    if (entry.retarget) {
      return descriptorKey(entry.retarget.next) === descriptorKey(nextDescriptor)
        ? entry.retarget.promise
        : Promise.reject(subscriptionError("진행 중인 구독 키 전환이 있습니다."));
    }

    this.cancelRotationFor(entry);
    const retarget = this.createRetarget(nextDescriptor);
    entry.retarget = retarget;
    if (entry.refs.size === 0) {
      this.completeRetarget(entry);
    } else if (entry.state === "pending") {
      // 현재 subscribe의 결과를 먼저 해석한 뒤 success면 unsubscribe, reject면 즉시 이동합니다.
    } else if (entry.subscribed || entry.state === "live" || entry.state === "stale") {
      this.enqueueUnsubscribe(entry);
    } else {
      this.completeRetarget(entry);
    }
    this.pump();
    return retarget.promise;
  }

  onState(listener: (snapshot: SubscriptionSnapshot) => void | Promise<void>): () => void {
    if (typeof listener !== "function") throw subscriptionError("구독 상태 리스너가 올바르지 않습니다.");
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onData(listener: (event: SubscriptionDataEvent) => void | Promise<void>): () => void {
    if (typeof listener !== "function") throw subscriptionError("구독 데이터 리스너가 올바르지 않습니다.");
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  getSnapshot(descriptorInput: SubscriptionDescriptor): SubscriptionSnapshot | undefined {
    const descriptor = this.normalizeDescriptor(descriptorInput);
    const entry = this.entries.get(descriptorKey(descriptor));
    return entry ? SubscriptionSupervisor.toSnapshot(entry) : undefined;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearControlTimers();
    this.staleGeneration += 1;
    this.rotationGeneration += 1;
    if (this.staleTimer !== undefined) this.clearIntervalFn(this.staleTimer);
    if (this.rotationTimer !== undefined) this.clearIntervalFn(this.rotationTimer);
    this.staleTimer = undefined;
    this.rotationTimer = undefined;
    this.unsubscribeMessage();
    this.unsubscribeState();
    for (const entry of [...this.entries.values()]) {
      this.rejectRetarget(entry, subscriptionError("구독 관리자가 종료되었습니다."));
      this.deleteEntry(entry);
    }
    this.controlQueue.length = 0;
    this.retiredDataKeys.clear();
    this.resetRotation();
    this.currentJob = undefined;
    this.stateListeners.clear();
    this.dataListeners.clear();
  }

  private releaseRef(ref: Ref): void {
    if (ref.released) return;
    ref.released = true;
    const entry = ref.entry;
    ref.entry = undefined;
    if (!entry) return;
    entry.refs.delete(ref);
    if (entry.refs.size > 0) {
      this.publishState(entry);
      return;
    }
    this.cancelRotationFor(entry);
    entry.removing = true;
    if (entry.state === "live" || entry.state === "stale" || entry.state === "pending") {
      if (entry.state !== "pending") this.enqueueUnsubscribe(entry);
    } else {
      this.deleteEntry(entry);
    }
    this.pump();
  }

  private enqueueSubscribe(entry: Entry): void {
    if (
      entry.removing ||
      entry.refs.size === 0 ||
      entry.state !== "desired" ||
      entry.queuedAction ||
      this.currentJob?.entry === entry
    ) return;
    entry.queuedAction = "subscribe";
    this.controlQueue.push({ entry, generation: entry.generation, action: "subscribe" });
  }

  private enqueueUnsubscribe(entry: Entry): void {
    if (
      !entry.subscribed ||
      entry.queuedAction ||
      this.currentJob?.entry === entry
    ) return;
    entry.queuedAction = "unsubscribe";
    this.controlQueue.push({ entry, generation: entry.generation, action: "unsubscribe" });
  }

  private pump(): void {
    if (
      this.destroyed ||
      this.requiresFreshOpen ||
      this.connection.state !== "open" ||
      this.currentJob ||
      this.controlSendTimer !== undefined ||
      this.controlRetryTimer !== undefined
    ) return;

    const job = this.nextValidJob();
    if (!job) return;
    const wait = Math.max(0, CONTROL_SPACING_MS - (this.safeMonotonicNow() - this.lastSentAtMonotonic));
    if (wait > 0) {
      this.armControlSend(job, wait);
      return;
    }
    this.sendJob(job);
  }

  private nextValidJob(): QueuedJob | undefined {
    while (this.controlQueue.length > 0) {
      const job = this.controlQueue.shift()!;
      const entry = this.entries.get(job.entry.key);
      if (entry !== job.entry || entry.generation !== job.generation) continue;
      if (entry.queuedAction === job.action) entry.queuedAction = undefined;
      if (job.action === "subscribe") {
        if (entry.refs.size === 0 || entry.removing || entry.state !== "desired") continue;
      } else if (!entry.subscribed) {
        continue;
      }
      return job;
    }
    return undefined;
  }

  private sendJob(job: QueuedJob): void {
    if (this.destroyed || this.requiresFreshOpen || this.connection.state !== "open" || this.currentJob) {
      this.requeue(job);
      return;
    }
    const entry = this.entries.get(job.entry.key);
    if (entry !== job.entry || entry.generation !== job.generation) {
      this.pump();
      return;
    }
    if (job.action === "subscribe") this.retiredDataKeys.delete(entry.key);
    const sent = this.connection.sendKisControl({
      trType: job.action === "subscribe" ? "1" : "2",
      trId: entry.descriptor.trId,
      trKey: entry.descriptor.trKey,
    });
    if (!sent) {
      this.requeue(job, true);
      return;
    }
    this.lastSentAtMonotonic = this.safeMonotonicNow();
    const publishPending = job.action === "subscribe";
    if (publishPending) entry.state = "pending";
    this.currentJob = job;
    this.armControlTimeout(job);
    // Listener가 destroy/release를 호출해도 current job과 timeout이 이미 일관된 상태입니다.
    if (publishPending) this.publishState(entry);
  }

  private requeue(job: QueuedJob, retry = false): void {
    const entry = this.entries.get(job.entry.key);
    if (entry !== job.entry || entry.generation !== job.generation) return;
    if (!entry.queuedAction) entry.queuedAction = job.action;
    this.controlQueue.unshift(job);
    if (retry && this.controlRetryTimer === undefined) this.armControlRetry();
  }

  private handleControlTimeout(job: ControlJob): void {
    if (this.currentJob !== job) return;
    this.currentJob = undefined;
    this.controlTimeout = undefined;
    const entry = this.entries.get(job.entry.key);
    if (entry === job.entry && entry.generation === job.generation) {
      entry.subscribed = false;
      if (entry.refs.size === 0) this.deleteEntry(entry);
      else this.setEntryState(entry, "desired");
    }
    this.requiresFreshOpen = true;
    this.connection.forceReconnect("subscription control timeout");
  }

  private handleConnectionState(state: ConnectionState): void {
    if (this.destroyed) return;
    if (state === "open") {
      this.requiresFreshOpen = false;
      for (const entry of this.entries.values()) this.enqueueSubscribe(entry);
      this.pump();
      return;
    }
    this.clearControlTimers();
    this.currentJob = undefined;
    this.controlQueue.length = 0;
    this.retiredDataKeys.clear();
    this.resetRotation();
    for (const entry of [...this.entries.values()]) {
      entry.queuedAction = undefined;
      if (entry.state === "live" || entry.state === "pending" || entry.state === "stale") {
        entry.subscribed = false;
        if (entry.refs.size === 0) this.deleteEntry(entry);
        else this.setEntryState(entry, "desired");
      } else if (entry.refs.size === 0) {
        this.deleteEntry(entry);
      }
    }
    // Socket이 끊기면 서버 쪽 기존 subscription도 함께 사라지므로 ack 없이 키를 옮겨도 됩니다.
    for (const entry of [...this.entries.values()]) {
      if (entry.retarget && entry.refs.size > 0) this.completeRetarget(entry);
    }
  }

  private handleRawMessage(raw: string): void {
    if (this.destroyed || typeof raw !== "string") return;
    if (raw.length > MAX_RAW_FRAME_CHARS) return;
    if (raw.startsWith("PINGPONG")) return;
    if (raw.startsWith("{")) {
      this.handleControlMessage(raw);
      return;
    }
    const first = raw.indexOf("|");
    const second = first < 0 ? -1 : raw.indexOf("|", first + 1);
    const third = second < 0 ? -1 : raw.indexOf("|", second + 1);
    if (third < 0) return;
    const trId = raw.slice(first + 1, second);
    let fieldCount = 1;
    for (let index = third + 1; index < raw.length; index += 1) {
      if (raw.charCodeAt(index) === 94 && ++fieldCount > MAX_RAW_FIELDS) return;
    }
    const fields = raw.slice(third + 1).split("^");
    const exactKey = fields[0]?.trim();
    if (!trId || !exactKey) return;
    if (this.retiredDataKeys.has(descriptorKey({ trId, trKey: exactKey }))) return;
    for (const entry of this.findDataTargets(trId, exactKey, fields[1]?.trim())) {
      entry.lastDataAt = this.safeNow();
      if (entry.state === "pending" || entry.state === "stale") this.setEntryState(entry, "live");
      const event: SubscriptionDataEvent = Object.freeze({
        descriptor: entry.descriptor,
        fields: Object.freeze([...fields]),
        receivedAt: entry.lastDataAt,
        generation: entry.generation,
      });
      this.publishData(entry, event);
    }
  }

  private handleControlMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const header = (parsed as { header?: unknown }).header;
    const body = (parsed as { body?: unknown }).body;
    if (!header || typeof header !== "object" || !body || typeof body !== "object") return;
    const trId = (header as { tr_id?: unknown }).tr_id;
    const msgCd = (body as { msg_cd?: unknown }).msg_cd;
    const input = (body as { input?: unknown }).input;
    const output = (body as { output?: unknown }).output;
    const trKey = this.readControlKey(output) ?? this.readControlKey(input);
    const job = this.currentJob;
    if (!job || typeof trId !== "string" || trId !== job.entry.descriptor.trId) return;
    // KIS control frame에는 socket-wide correlation id가 없습니다. key 없는 응답은
    // 이전 요청의 늦은 응답인지 판별할 수 없으므로 절대 현재 job으로 귀속하지 않습니다.
    if (trKey !== job.entry.descriptor.trKey) return;
    if (typeof msgCd !== "string") return;

    this.clearControlTimeout();
    this.currentJob = undefined;
    const entry = this.entries.get(job.entry.key);
    if (entry !== job.entry || entry.generation !== job.generation) {
      this.pump();
      return;
    }
    const success = msgCd === "OPSP0000" || msgCd === "OPSP0002";
    if (job.action === "subscribe") {
      entry.subscribed = success;
      if (success) {
        entry.liveAt = this.safeNow();
        this.setEntryState(entry, "live");
        if (!this.isCurrentEntry(entry)) return;
        if (entry.refs.size === 0 || entry.removing || entry.retarget) this.enqueueUnsubscribe(entry);
        this.finishRotationIncoming(entry);
      } else {
        this.setEntryState(entry, "rejected");
        if (!this.isCurrentEntry(entry)) return;
        const error = Object.freeze(new KisError({
          code: "SUBSCRIPTION_REJECTED",
          scope: "websocket",
          retryable: false,
          safeMessage: "실시간 시세 구독이 거부되었습니다.",
        }));
        try {
          this.diagnostics.record(error);
          this.diagnostics.increment("subscriptionRejects");
        } catch {
          // Diagnostics must not affect the control queue.
        }
        if (entry.retarget) this.completeRetarget(entry);
        else if (entry.refs.size === 0) this.deleteEntry(entry);
        this.finishRotationIncoming(entry);
        this.promoteParked();
      }
    } else if (success) {
      entry.subscribed = false;
      this.retireDataKey(entry.descriptor);
      if (entry.retarget) this.completeRetarget(entry);
      else if (entry.rotationOutgoing) this.completeRotationOutgoing(entry);
      else if (entry.refs.size === 0 || entry.removing) this.deleteEntry(entry);
      else {
        this.setEntryState(entry, "desired");
        this.enqueueSubscribe(entry);
      }
    } else {
      entry.subscribed = false;
      if (entry.refs.size === 0) this.deleteEntry(entry);
      else this.setEntryState(entry, "desired");
      this.requiresFreshOpen = true;
      this.connection.forceReconnect("subscription unsubscribe rejected");
    }
    this.pump();
  }

  private readControlKey(value: unknown): string | undefined {
    if (!value || typeof value !== "object") return undefined;
    const trKey = (value as { tr_key?: unknown }).tr_key;
    return typeof trKey === "string" ? trKey : undefined;
  }

  private findDataTargets(trId: string, exactKey: string, ticker: string | undefined): Entry[] {
    const active = [...this.entries.values()].filter((entry) => this.isDataRoutable(entry, trId));
    const exact = active.filter((entry) => entry.descriptor.trKey === exactKey);
    if (exact.length > 0) return exact;
    if (trId !== TR_ID_OVERSEAS || typeof ticker !== "string" || ticker.trim().length === 0) return [];

    const symbol = ticker.trim().toUpperCase();
    const fallback = active.filter((entry) => this.overseasSymbol(entry.descriptor.trKey) === symbol);
    // ticker-only frame은 동일 티커의 주·야간/거래소 key가 공존할 수 있습니다.
    // 정확히 하나일 때만 보조 라우팅하며, 둘 이상이면 잘못된 화면 갱신보다 무시합니다.
    return fallback.length === 1 ? fallback : [];
  }

  private isDataRoutable(entry: Entry, trId: string): boolean {
    return entry.descriptor.trId === trId &&
      entry.refs.size > 0 &&
      (entry.state === "pending" || entry.state === "live" || entry.state === "stale");
  }

  private overseasSymbol(trKey: string): string | undefined {
    if (trKey.length <= 4 || !/^[A-Z]{4}$/i.test(trKey.slice(0, 4))) return undefined;
    const symbol = trKey.slice(4).trim();
    return symbol.length > 0 ? symbol.toUpperCase() : undefined;
  }

  private markStaleEntries(): void {
    if (this.destroyed) return;
    const now = this.safeNow();
    for (const entry of this.entries.values()) {
      if (entry.state !== "live" || entry.refs.size === 0) continue;
      const receivedAt = entry.lastDataAt ?? entry.liveAt;
      if (receivedAt !== undefined && now - receivedAt >= STALE_AFTER_MS) {
        this.setEntryState(entry, "stale");
      }
    }
  }

  private enforceSubscriptionCap(): void {
    let active = this.countActiveSubscriptions();
    while (active > MAX_LIVE_SUBSCRIPTIONS) {
      const newestDesired = [...this.entries.values()]
        .filter((entry) => entry.refs.size > 0 && entry.state === "desired" && !entry.rotationIncoming)
        .sort((a, b) => b.createdAt - a.createdAt || b.order - a.order)[0];
      if (!newestDesired) return;
      this.parkEntry(newestDesired);
      active -= 1;
    }
  }

  private rebalanceSubscriptions(): void {
    if (this.destroyed) return;
    this.enforceSubscriptionCap();
    this.promoteParked();
  }

  private parkEntry(entry: Entry): void {
    if (entry.queuedAction === "subscribe" && this.currentJob?.entry !== entry) {
      entry.queuedAction = undefined;
      for (let index = this.controlQueue.length - 1; index >= 0; index -= 1) {
        const job = this.controlQueue[index];
        if (job.entry === entry && job.action === "subscribe") this.controlQueue.splice(index, 1);
      }
    }
    this.setEntryState(entry, "parked");
  }

  private countActiveSubscriptions(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.refs.size === 0 || entry.state === "parked" || entry.state === "rejected") continue;
      count += 1;
    }
    return count;
  }

  private promoteParked(): void {
    if (this.destroyed || this.countActiveSubscriptions() >= MAX_LIVE_SUBSCRIPTIONS) return;
    const entry = [...this.entries.values()]
      .filter((candidate) => candidate.refs.size > 0 && candidate.state === "parked" && !candidate.rotationIncoming)
      .sort((a, b) => a.createdAt - b.createdAt || a.order - b.order)[0];
    if (!entry) return;
    this.setEntryState(entry, "desired");
    if (!this.isCurrentEntry(entry)) return;
    this.enqueueSubscribe(entry);
    this.pump();
  }

  private startRotationLease(): void {
    if (this.destroyed || this.rotationCurrent || this.rotationQueue.length > 0) return;
    const excess = this.countActiveSubscriptions() + this.countParkedSubscriptions() - MAX_LIVE_SUBSCRIPTIONS;
    if (excess <= 0) return;
    const outgoing = [...this.entries.values()]
      .filter((entry) => entry.refs.size > 0 && entry.state === "live" && !entry.rotationOutgoing)
      .sort((a, b) =>
        (a.liveAt ?? a.createdAt) - (b.liveAt ?? b.createdAt) || a.order - b.order,
      );
    const incoming = [...this.entries.values()]
      .filter((entry) => entry.refs.size > 0 && entry.state === "parked" && !entry.rotationIncoming)
      .sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
    const count = Math.min(excess, MAX_LIVE_SUBSCRIPTIONS, outgoing.length, incoming.length);
    for (let index = 0; index < count; index += 1) {
      const pair = { outgoing: outgoing[index], incoming: incoming[index] };
      pair.outgoing.rotationOutgoing = pair.incoming;
      pair.incoming.rotationIncoming = true;
      this.rotationQueue.push(pair);
    }
    this.advanceRotation();
  }

  private countParkedSubscriptions(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.refs.size > 0 && entry.state === "parked") count += 1;
    }
    return count;
  }

  private advanceRotation(): void {
    if (this.rotationCurrent) return;
    const pair = this.rotationQueue.shift();
    if (!pair) return;
    if (
      pair.outgoing.refs.size === 0 ||
      pair.outgoing.state !== "live" ||
      !pair.outgoing.subscribed ||
      pair.incoming.refs.size === 0 ||
      pair.incoming.state !== "parked"
    ) {
      pair.outgoing.rotationOutgoing = undefined;
      pair.incoming.rotationIncoming = false;
      this.advanceRotation();
      return;
    }
    this.rotationCurrent = pair;
    this.enqueueUnsubscribe(pair.outgoing);
    this.pump();
  }

  private completeRotationOutgoing(outgoing: Entry): void {
    const incoming = outgoing.rotationOutgoing;
    outgoing.rotationOutgoing = undefined;
    if (!incoming || this.rotationCurrent?.outgoing !== outgoing) return;
    outgoing.subscribed = false;
    this.setEntryState(outgoing, "parked");
    if (!this.isCurrentEntry(outgoing)) return;
    if (incoming.refs.size === 0 || incoming.state !== "parked") {
      incoming.rotationIncoming = false;
      this.rotationCurrent = undefined;
      this.advanceRotation();
      return;
    }
    this.setEntryState(incoming, "desired");
    this.enqueueSubscribe(incoming);
  }

  private finishRotationIncoming(incoming: Entry): void {
    if (!incoming.rotationIncoming) return;
    incoming.rotationIncoming = false;
    if (this.rotationCurrent?.incoming === incoming) {
      this.rotationCurrent = undefined;
      this.advanceRotation();
    }
  }

  private resetRotation(): void {
    for (const entry of this.entries.values()) {
      entry.rotationOutgoing = undefined;
      entry.rotationIncoming = false;
    }
    this.rotationCurrent = undefined;
    this.rotationQueue.length = 0;
  }

  /**
   * 회전 pair의 한쪽 수명이 끝나면 이 lease 전체를 취소합니다. 현재 control job은
   * server ack까지 그대로 두되, callback이 일반 unsubscribe/retarget 경로로 처리되게
   * 회전 표식과 대기 pair만 제거합니다.
   */
  private cancelRotationFor(entry: Entry): void {
    if (
      !entry.rotationOutgoing &&
      !entry.rotationIncoming &&
      this.rotationCurrent?.outgoing !== entry &&
      this.rotationCurrent?.incoming !== entry
    ) return;
    this.resetRotation();
  }

  private retireDataKey(descriptor: SubscriptionDescriptor): void {
    const key = descriptorKey(descriptor);
    this.retiredDataKeys.delete(key);
    this.retiredDataKeys.add(key);
    while (this.retiredDataKeys.size > MAX_RETIRED_DATA_KEYS) {
      const oldest = this.retiredDataKeys.values().next().value;
      if (typeof oldest !== "string") return;
      this.retiredDataKeys.delete(oldest);
    }
  }

  private createRetarget(next: SubscriptionDescriptor): Retarget {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: KisError) => void;
    const retarget: Retarget = {
      next,
      promise: new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      }),
      resolve: () => {
        if (retarget.settled) return;
        retarget.settled = true;
        resolvePromise();
      },
      reject: (error) => {
        if (retarget.settled) return;
        retarget.settled = true;
        rejectPromise(error);
      },
      settled: false,
    };
    return retarget;
  }

  private completeRetarget(entry: Entry): void {
    const retarget = entry.retarget;
    if (!retarget || this.entries.get(entry.key) !== entry) return;
    if (entry.refs.size === 0) {
      entry.retarget = undefined;
      this.deleteEntry(entry);
      retarget.resolve();
      return;
    }

    const nextKey = descriptorKey(retarget.next);
    let existing = this.entries.get(nextKey);
    if (existing?.removing) {
      if (existing.queuedAction === "unsubscribe" && this.currentJob?.entry !== existing) {
        this.cancelQueuedUnsubscribe(existing);
      } else if (this.currentJob?.entry === existing && this.currentJob.action === "unsubscribe") {
        // 서버 해제는 이미 전송됐습니다. doomed entry는 map에서 분리하고, 같은 key의
        // 새 physical entry가 그 ack 뒤에 다시 subscribe하도록 합니다.
        this.deleteEntry(existing);
        existing = undefined;
      } else {
        // pending subscribe가 끝난 뒤의 unsubscribe를 먼저 처리하도록 source를 보존합니다.
        return;
      }
    }
    if (this.destroyed || this.entries.get(entry.key) !== entry) return;

    entry.retarget = undefined;
    const mergesIntoExistingEntry = existing !== undefined;
    const refs = [...entry.refs];
    const next: Entry = existing ?? {
        key: nextKey,
        descriptor: retarget.next,
        createdAt: this.safeNow(),
        order: ++this.entrySequence,
        generation: 1,
        state: "desired",
        subscribed: false,
        liveAt: undefined,
        lastDataAt: undefined,
        refs: new Set(),
        demand: undefined,
        queuedAction: undefined,
        removing: false,
        retarget: undefined,
        rotationOutgoing: undefined,
        rotationIncoming: false,
      };
    if (!existing) {
      this.entries.set(next.key, next);
      // 기존 physical entry의 retain 하나를 새 entry가 그대로 승계합니다.
    }
    for (const ref of refs) {
      entry.refs.delete(ref);
      ref.entry = next;
      next.refs.add(ref);
    }
    this.entries.delete(entry.key);
    entry.generation += 1;
    entry.queuedAction = undefined;
    if (mergesIntoExistingEntry) {
      // 대상 physical entry는 자체 retain을 이미 보유하므로 source demand만 해제합니다.
      this.releaseDemand(entry);
    } else {
      // 새 key는 source physical demand를 승계하므로 release하지 않습니다.
      next.demand = entry.demand;
      entry.demand = undefined;
    }
    this.enqueueSubscribe(next);
    retarget.resolve();
    this.rebalanceSubscriptions();
    if (this.destroyed || this.entries.get(next.key) !== next) return;
    this.publishState(next);
    this.pump();
  }

  private cancelQueuedUnsubscribe(entry: Entry): void {
    if (entry.queuedAction !== "unsubscribe" || this.currentJob?.entry === entry) return;
    entry.queuedAction = undefined;
    for (let index = this.controlQueue.length - 1; index >= 0; index -= 1) {
      const job = this.controlQueue[index];
      if (job.entry === entry && job.action === "unsubscribe") this.controlQueue.splice(index, 1);
    }
    entry.removing = false;
  }

  private rejectRetarget(entry: Entry, error: KisError): void {
    const retarget = entry.retarget;
    if (!retarget) return;
    entry.retarget = undefined;
    retarget.reject(error);
  }

  private setEntryState(entry: Entry, state: PhysicalSubscriptionState): void {
    if (entry.state === state) return;
    entry.state = state;
    this.publishState(entry);
  }

  private publishState(entry: Entry, oneRef?: Ref): void {
    const snapshot = SubscriptionSupervisor.toSnapshot(entry);
    const refs = oneRef ? [oneRef] : [...entry.refs];
    for (const ref of refs) this.invoke(ref.observer.onState, snapshot);
    for (const listener of [...this.stateListeners]) this.invoke(listener, snapshot);
  }

  private publishData(entry: Entry, event: SubscriptionDataEvent): void {
    for (const ref of [...entry.refs]) this.invoke(ref.observer.onData, event);
    for (const listener of [...this.dataListeners]) this.invoke(listener, event);
  }

  private invoke<T>(listener: ((value: T) => void | Promise<void>) | undefined, value: T): void {
    if (!listener) return;
    try {
      const result = listener(value);
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // 한 버튼의 render/callback 실패는 다른 구독과 control queue를 멈추지 않습니다.
    }
  }

  private deleteEntry(entry: Entry): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.cancelRotationFor(entry);
    this.entries.delete(entry.key);
    entry.generation += 1;
    entry.queuedAction = undefined;
    for (const ref of entry.refs) ref.entry = undefined;
    entry.refs.clear();
    this.releaseDemand(entry);
    this.rebalanceSubscriptions();
  }

  private releaseDemand(entry: Entry): void {
    const demand = entry.demand;
    entry.demand = undefined;
    if (!demand || demand.released) return;
    demand.released = true;
    try { this.connection.release(); } catch { /* a transport release cannot leak a ref */ }
  }

  private isCurrentEntry(entry: Entry): boolean {
    return !this.destroyed && this.entries.get(entry.key) === entry;
  }

  private normalizeObserver(input: SubscriptionObserver): SubscriptionObserver {
    if (!input || typeof input !== "object") throw subscriptionError("구독 리스너가 올바르지 않습니다.");
    const onData = this.readOwnFunction(input, "onData");
    const onState = this.readOwnFunction(input, "onState");
    return Object.freeze({
      ...(onData ? { onData: onData as SubscriptionObserver["onData"] } : {}),
      ...(onState ? { onState: onState as SubscriptionObserver["onState"] } : {}),
    });
  }

  private normalizeDescriptor(input: SubscriptionDescriptor): SubscriptionDescriptor {
    if (!input || typeof input !== "object") throw subscriptionError("구독 정보가 올바르지 않습니다.");
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(input);
    } catch {
      throw subscriptionError("구독 정보를 읽을 수 없습니다.");
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw subscriptionError("구독 정보 형식이 올바르지 않습니다.");
    }
    const trId = this.readOwnString(input, "trId");
    const trKey = this.readOwnString(input, "trKey");
    if (!trId || !trKey || trId.trim() !== trId || trKey.trim() !== trKey || trId.length > 64 || trKey.length > 128) {
      throw subscriptionError("구독 정보가 올바르지 않습니다.");
    }
    return cloneDescriptor({ trId, trKey });
  }

  private readOwnString(input: object, key: string): string | undefined {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && "value" in descriptor && typeof descriptor.value === "string"
        ? descriptor.value
        : undefined;
    } catch {
      throw subscriptionError("구독 정보를 읽을 수 없습니다.");
    }
  }

  private readOwnFunction(input: object, key: string): ((value: unknown) => void | Promise<void>) | undefined {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) return undefined;
      if (!("value" in descriptor) || typeof descriptor.value !== "function") {
        throw subscriptionError("구독 리스너가 올바르지 않습니다.");
      }
      return descriptor.value as (value: unknown) => void | Promise<void>;
    } catch (error) {
      if (error instanceof KisError) throw error;
      throw subscriptionError("구독 리스너를 읽을 수 없습니다.");
    }
  }

  private clearControlTimeout(): void {
    this.controlTimeoutGeneration += 1;
    if (this.controlTimeout === undefined) return;
    this.clearTimeoutFn(this.controlTimeout);
    this.controlTimeout = undefined;
  }

  private clearControlTimers(): void {
    this.clearControlTimeout();
    this.controlSendGeneration += 1;
    this.controlRetryGeneration += 1;
    if (this.controlSendTimer !== undefined) this.clearTimeoutFn(this.controlSendTimer);
    if (this.controlRetryTimer !== undefined) this.clearTimeoutFn(this.controlRetryTimer);
    this.controlSendTimer = undefined;
    this.controlRetryTimer = undefined;
  }

  private armControlTimeout(job: ControlJob): void {
    const generation = ++this.controlTimeoutGeneration;
    let handle: TimerHandle;
    try {
      handle = this.setTimeoutFn(() => {
        if (generation !== this.controlTimeoutGeneration) return;
        this.controlTimeout = undefined;
        this.controlTimeoutGeneration += 1;
        this.handleControlTimeout(job);
      }, CONTROL_TIMEOUT_MS);
    } catch {
      this.handleControlTimeout(job);
      return;
    }
    if (generation !== this.controlTimeoutGeneration || this.destroyed || this.currentJob !== job) {
      try { this.clearTimeoutFn(handle); } catch { /* stale synchronous timer */ }
      return;
    }
    this.controlTimeout = handle;
  }

  private armControlSend(job: QueuedJob, milliseconds: number): void {
    const generation = ++this.controlSendGeneration;
    let handle: TimerHandle;
    try {
      handle = this.setTimeoutFn(() => {
        if (generation !== this.controlSendGeneration) return;
        this.controlSendTimer = undefined;
        this.controlSendGeneration += 1;
        this.sendJob(job);
      }, milliseconds);
    } catch {
      this.requeue(job, true);
      this.connection.forceReconnect("subscription control send timer failed");
      return;
    }
    if (generation !== this.controlSendGeneration || this.destroyed) {
      try { this.clearTimeoutFn(handle); } catch { /* stale synchronous timer */ }
      return;
    }
    this.controlSendTimer = handle;
  }

  private armControlRetry(): void {
    const generation = ++this.controlRetryGeneration;
    let handle: TimerHandle;
    try {
      handle = this.setTimeoutFn(() => {
        if (generation !== this.controlRetryGeneration) return;
        this.controlRetryTimer = undefined;
        this.controlRetryGeneration += 1;
        this.pump();
      }, CONTROL_SPACING_MS);
    } catch {
      this.connection.forceReconnect("subscription control retry timer failed");
      return;
    }
    if (generation !== this.controlRetryGeneration || this.destroyed) {
      try { this.clearTimeoutFn(handle); } catch { /* stale synchronous timer */ }
      return;
    }
    this.controlRetryTimer = handle;
  }

  private armIntervals(): void {
    const staleGeneration = ++this.staleGeneration;
    let staleHandle: TimerHandle;
    try {
      staleHandle = this.setIntervalFn(() => {
        if (staleGeneration === this.staleGeneration) this.markStaleEntries();
      }, STALE_CHECK_INTERVAL_MS);
    } catch {
      this.unsubscribeMessage();
      this.unsubscribeState();
      throw subscriptionError("구독 타이머를 시작하지 못했습니다.");
    }
    if (staleGeneration === this.staleGeneration && !this.destroyed) this.staleTimer = staleHandle;
    else {
      try { this.clearIntervalFn(staleHandle); } catch { /* synchronous destroy */ }
    }

    const rotationGeneration = ++this.rotationGeneration;
    let rotationHandle: TimerHandle;
    try {
      rotationHandle = this.setIntervalFn(() => {
        if (rotationGeneration === this.rotationGeneration) this.startRotationLease();
      }, ROTATION_LEASE_MS);
    } catch {
      this.staleGeneration += 1;
      if (this.staleTimer !== undefined) this.clearIntervalFn(this.staleTimer);
      this.staleTimer = undefined;
      this.unsubscribeMessage();
      this.unsubscribeState();
      throw subscriptionError("구독 타이머를 시작하지 못했습니다.");
    }
    if (rotationGeneration === this.rotationGeneration && !this.destroyed) this.rotationTimer = rotationHandle;
    else {
      try { this.clearIntervalFn(rotationHandle); } catch { /* synchronous destroy */ }
    }
  }

  private safeNow(): number {
    try {
      const now = this.now();
      return Number.isFinite(now) ? now : Date.now();
    } catch {
      return Date.now();
    }
  }

  private safeMonotonicNow(): number {
    let value = this.lastMonotonic;
    try {
      const current = this.monotonicNow();
      if (Number.isFinite(current)) value = Math.max(this.lastMonotonic, current);
    } catch {
      // Keep the previous monotonic reading when the host clock fails.
    }
    this.lastMonotonic = value;
    return value;
  }

  private recordSettingsFailure(): void {
    try {
      this.diagnostics.record(subscriptionError("WebSocket 구독 연결을 시작하지 못했습니다."));
    } catch {
      // Diagnostics must be unable to affect connection recovery.
    }
  }

  private assertUsable(): void {
    if (this.destroyed) throw subscriptionError("종료된 구독 관리자는 사용할 수 없습니다.");
  }

  private static toSnapshot(entry: Entry): SubscriptionSnapshot {
    return Object.freeze({
      descriptor: entry.descriptor,
      state: entry.state,
      generation: entry.generation,
      refCount: entry.refs.size,
      subscribed: entry.subscribed,
      ...(entry.liveAt === undefined ? {} : { liveAt: entry.liveAt }),
      ...(entry.lastDataAt === undefined ? {} : { lastDataAt: entry.lastDataAt }),
    });
  }
}
