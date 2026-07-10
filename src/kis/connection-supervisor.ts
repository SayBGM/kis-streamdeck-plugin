import WebSocket from "ws";
import { diagnosticsStore, type DiagnosticsStore } from "../core/diagnostics-store.js";
import { KisError } from "../core/errors.js";
import { KIS_WS_URL } from "../types/index.js";
import type { ApprovalKeyLease } from "./credential-session.js";

export const CONNECTION_STATES = [
  "idle",
  "connecting",
  "open",
  "reconnect_wait",
  "stopped",
] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];
export type TimerHandle = unknown;
export type SupervisorListener<T> = (value: T) => void | Promise<void>;

/** 최소 WebSocket 표면입니다. 테스트는 이 인터페이스만 구현하면 됩니다. */
export interface SocketLike {
  readonly readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close?(): void;
  terminate?(): void;
  ping?(): void;
}

export type WebSocketFactory = (url: string) => SocketLike;

export interface ApprovalKeyPort {
  getApprovalKey(): Promise<ApprovalKeyLease | string>;
}

export interface KisControlCommand {
  readonly trType: "1" | "2";
  readonly trId: string;
  readonly trKey: string;
}

export interface ConnectionSupervisorOptions {
  readonly socketFactory?: WebSocketFactory;
  readonly credentials: ApprovalKeyPort;
  readonly url?: string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimeout?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
  readonly setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
  readonly diagnostics?: Pick<DiagnosticsStore, "record" | "increment">;
}

interface ConnectionAttempt {
  readonly id: number;
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: KisError): void;
  settled: boolean;
}

interface ApprovalIdentity {
  readonly credentialGeneration: number;
}

interface ApprovalRequest {
  readonly epoch: number;
  readonly promise: Promise<ApprovalKeyLease | undefined>;
}

const SOCKET_OPEN = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_IDLE_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const APPROVAL_KEY_REFRESH_INTERVAL_MS = 30 * 60_000;
const STABLE_LIVENESS_MS = 30_000;
const RECONNECT_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

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

function supervisorError(
  code: "NETWORK" | "TIMEOUT" | "AUTH_REJECTED" | "PROTOCOL" | "SETTINGS",
  retryable: boolean,
  safeMessage: string,
  metadata?: Readonly<Record<string, unknown>>,
): KisError {
  return Object.freeze(new KisError({
    code,
    scope: "websocket",
    retryable,
    safeMessage,
    metadata,
  }));
}

function stoppedError(): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "websocket",
    retryable: false,
    safeMessage: "종료된 WebSocket 연결은 다시 시작할 수 없습니다.",
  }));
}

function isUsableText(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * 구독과 시세 해석을 모르는 WebSocket transport 상태 관리자입니다.
 * 승인 키는 이 객체 안에만 보관하며, 구독 계층에는 `sendKisControl` capability만 제공합니다.
 */
export class ConnectionSupervisor {
  private readonly socketFactory: WebSocketFactory;
  private readonly credentials: ApprovalKeyPort;
  private readonly url: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutFn: NonNullable<ConnectionSupervisorOptions["setTimeout"]>;
  private readonly clearTimeoutFn: NonNullable<ConnectionSupervisorOptions["clearTimeout"]>;
  private readonly setIntervalFn: NonNullable<ConnectionSupervisorOptions["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<ConnectionSupervisorOptions["clearInterval"]>;
  private readonly diagnostics: Pick<DiagnosticsStore, "record" | "increment">;

  private currentState: ConnectionState = "idle";
  private retainCount = 0;
  private socket: SocketLike | undefined;
  private socketEpoch = 0;
  private attemptEpoch = 0;
  private connectionAttempt: ConnectionAttempt | undefined;
  private reconnectTimer: TimerHandle | undefined;
  private connectTimeoutTimer: TimerHandle | undefined;
  private heartbeatIntervalTimer: TimerHandle | undefined;
  private heartbeatTimeoutTimer: TimerHandle | undefined;
  private approvalRefreshTimer: TimerHandle | undefined;
  private stableLivenessTimer: TimerHandle | undefined;
  private reconnectAttempts = 0;
  private reconnectGeneration = 0;
  private lastActivityAt = 0;
  private openedAt = 0;
  private hasConfirmedLiveness = false;
  private awaitingHeartbeat = false;
  private approval: ApprovalKeyLease | undefined;
  private approvalRequestEpoch = 0;
  private approvalRequest: ApprovalRequest | undefined;
  private readonly messageListeners = new Set<SupervisorListener<string>>();
  private readonly stateListeners = new Set<SupervisorListener<ConnectionState>>();

  constructor(options: ConnectionSupervisorOptions) {
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.credentials = options.credentials;
    this.url = options.url ?? KIS_WS_URL;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimeoutFn = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? defaultClearTimeout;
    this.setIntervalFn = options.setInterval ?? defaultSetInterval;
    this.clearIntervalFn = options.clearInterval ?? defaultClearInterval;
    this.diagnostics = options.diagnostics ?? diagnosticsStore;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get demand(): number {
    return this.retainCount;
  }

  /** 승인 키나 fingerprint를 노출하지 않는 상태 조회입니다. */
  get approvalIdentity(): ApprovalIdentity | undefined {
    return this.approval
      ? Object.freeze({ credentialGeneration: this.approval.credentialGeneration })
      : undefined;
  }

  onMessage(listener: SupervisorListener<string>): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: SupervisorListener<ConnectionState>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  retain(): Promise<void> {
    if (this.currentState === "stopped") return Promise.reject(stoppedError());
    this.retainCount += 1;
    return this.ensureConnection();
  }

  release(): void {
    if (this.currentState === "stopped") return;
    this.setDemand(Math.max(0, this.retainCount - 1));
  }

  setDemand(count: number): Promise<void> {
    if (this.currentState === "stopped") return Promise.reject(stoppedError());
    this.retainCount = Number.isSafeInteger(count) && count > 0 ? count : 0;
    if (this.retainCount === 0) {
      this.stopForNoDemand();
      return Promise.resolve();
    }
    return this.ensureConnection();
  }

  /** 명시적 재연결. 대기 중이면 기존 단일 타이머를 유지합니다. */
  forceReconnect(_reason = "requested"): void {
    if (this.currentState === "stopped" || this.retainCount === 0) return;
    if (this.currentState === "reconnect_wait") return;
    this.recover("forced reconnect");
  }

  /**
   * 새 자격증명 세대가 적용됐을 때 호출할 수 있습니다. 실패해도 기존 open socket과
   * 기존 승인 키는 유지됩니다. 이전 갱신 결과는 request epoch로 폐기합니다.
   */
  async refreshApprovalKey(): Promise<boolean> {
    if (this.currentState === "stopped") return false;
    try {
      const lease = await this.getOrStartApprovalRequest().promise;
      if (!lease) return false;
    } catch {
      this.recordFailure("AUTH_REJECTED", true, "승인 키를 갱신하지 못했습니다.");
      return false;
    }
    if (this.retainCount > 0 && this.currentState !== "open") {
      void this.ensureConnection().catch(() => undefined);
    }
    return true;
  }

  sendRaw(data: string): boolean {
    if (typeof data !== "string" || !this.isCurrentSocketOpen()) return false;
    try {
      this.socket!.send(data);
      return true;
    } catch {
      this.recover("send failed");
      return false;
    }
  }

  /** 구독 계층이 승인 키를 읽지 않고 KIS 제어 프레임을 전송하는 제한된 capability입니다. */
  sendKisControl(command: KisControlCommand): boolean {
    if (!this.approval || !this.isValidControlCommand(command)) return false;
    return this.sendRaw(JSON.stringify({
      header: {
        approval_key: this.approval.approvalKey,
        custtype: "P",
        tr_type: command.trType,
        "content-type": "utf-8",
      },
      body: { input: { tr_id: command.trId, tr_key: command.trKey } },
    }));
  }

  destroy(): void {
    if (this.currentState === "stopped") return;
    this.retainCount = 0;
    this.clearReconnectTimer();
    this.clearApprovalRefreshTimer();
    this.clearSocketTimers();
    this.cancelAttempt(stoppedError());
    this.disposeCurrentSocket();
    this.approval = undefined;
    this.setState("stopped");
    this.messageListeners.clear();
    this.stateListeners.clear();
  }

  private ensureConnection(): Promise<void> {
    if (this.currentState === "stopped") return Promise.reject(stoppedError());
    if (this.retainCount === 0 || this.currentState === "open") return Promise.resolve();
    if (this.currentState === "connecting" && this.connectionAttempt) {
      return this.connectionAttempt.promise;
    }
    if (this.currentState === "reconnect_wait") {
      return Promise.resolve();
    }
    return this.beginConnect();
  }

  private beginConnect(): Promise<void> {
    this.clearReconnectTimer();
    const attempt = this.createAttempt();
    this.connectionAttempt = attempt;
    // A caller may intentionally not await retain(); prevent rejected attempts from becoming global errors.
    void attempt.promise.catch(() => undefined);
    this.setState("connecting");
    if (!this.isCurrentAttempt(attempt)) return attempt.promise;
    void this.acquireApprovalAndCreateSocket(attempt);
    return attempt.promise;
  }

  private createAttempt(): ConnectionAttempt {
    const id = ++this.attemptEpoch;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: KisError) => void;
    const attempt: ConnectionAttempt = {
      id,
      promise: new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      }),
      resolve: () => {
        if (attempt.settled) return;
        attempt.settled = true;
        resolvePromise();
      },
      reject: (error) => {
        if (attempt.settled) return;
        attempt.settled = true;
        rejectPromise(error);
      },
      settled: false,
    };
    return attempt;
  }

  private async acquireApprovalAndCreateSocket(attempt: ConnectionAttempt): Promise<void> {
    while (this.isCurrentAttempt(attempt)) {
      if (!this.approval) {
        try {
          const lease = await this.getOrStartApprovalRequest().promise;
          if (!this.isCurrentAttempt(attempt)) return;
          if (!lease) continue;
        } catch {
          this.failAttempt(attempt, supervisorError(
            "AUTH_REJECTED",
            true,
            "승인 키를 가져오지 못했습니다.",
          ));
          return;
        }
      }
      this.createSocket(attempt);
      return;
    }
  }

  private createSocket(attempt: ConnectionAttempt): void {
    if (!this.isCurrentAttempt(attempt) || !this.approval) return;
    let socket: SocketLike;
    try {
      socket = this.socketFactory(this.url);
    } catch {
      this.failAttempt(attempt, supervisorError(
        "NETWORK",
        true,
        "WebSocket을 만들지 못했습니다.",
      ));
      return;
    }
    if (!this.isCurrentAttempt(attempt)) {
      this.disposeSocket(socket);
      return;
    }
    const socketEpoch = ++this.socketEpoch;
    this.socket = socket;
    this.startConnectTimeout(socket, socketEpoch, attempt);
    try {
      socket.on("open", () => this.handleOpen(socket, socketEpoch, attempt));
      socket.on("message", (data: unknown) => this.handleMessage(socket, socketEpoch, data));
      socket.on("pong", () => this.handleActivity(socket, socketEpoch));
      socket.on("error", () => this.handleSocketFailure(socket, socketEpoch, "socket error"));
      socket.on("close", () => this.handleSocketFailure(socket, socketEpoch, "socket closed"));
    } catch {
      this.handleSocketFailure(socket, socketEpoch, "socket listener failed");
    }
  }

  /**
   * 동시에 발생한 승인 키 요청은 현재 in-flight promise 하나를 공유합니다.
   * 완료 뒤의 낮은 credential generation은 폐기하며, 키 값은 외부에 노출하지 않습니다.
   */
  private getOrStartApprovalRequest(): ApprovalRequest {
    if (this.approvalRequest) return this.approvalRequest;
    const epoch = ++this.approvalRequestEpoch;
    const promise = this.performApprovalRequest(epoch);
    const request: ApprovalRequest = { epoch, promise };
    this.approvalRequest = request;
    void promise.then(
      () => this.clearApprovalRequest(request),
      () => this.clearApprovalRequest(request),
    );
    return request;
  }

  private async performApprovalRequest(epoch: number): Promise<ApprovalKeyLease | undefined> {
    const lease = this.normalizeApprovalLease(await this.credentials.getApprovalKey());
    if (this.isStopped() || epoch !== this.approvalRequestEpoch) return undefined;
    if (
      this.approval &&
      lease.credentialGeneration < this.approval.credentialGeneration
    ) {
      return undefined;
    }
    this.approval = lease;
    this.startApprovalRefreshTimer();
    return lease;
  }

  private clearApprovalRequest(request: ApprovalRequest): void {
    if (this.approvalRequest === request) this.approvalRequest = undefined;
  }

  private handleOpen(socket: SocketLike, socketEpoch: number, attempt: ConnectionAttempt): void {
    if (!this.isCurrentSocket(socket, socketEpoch) || !this.isCurrentAttempt(attempt)) return;
    this.clearConnectTimeout();
    this.connectionAttempt = undefined;
    attempt.resolve();
    this.openedAt = this.safeNow();
    this.lastActivityAt = this.openedAt;
    this.hasConfirmedLiveness = false;
    this.awaitingHeartbeat = false;
    this.setState("open");
    if (!this.isCurrentSocket(socket, socketEpoch) || this.currentState !== "open") {
      return;
    }
    this.startHeartbeat(socket, socketEpoch);
    this.startStableLivenessTimer(socket, socketEpoch);
  }

  private handleMessage(socket: SocketLike, socketEpoch: number, data: unknown): void {
    if (!this.isCurrentSocket(socket, socketEpoch)) return;
    this.handleActivity(socket, socketEpoch);
    const raw = this.toRawMessage(data);
    this.publish(this.messageListeners, raw);
    if (this.isPingPong(raw)) this.sendRaw(raw);
  }

  private handleActivity(socket: SocketLike, socketEpoch: number): void {
    if (!this.isCurrentSocket(socket, socketEpoch)) return;
    this.lastActivityAt = this.safeNow();
    this.hasConfirmedLiveness = true;
    this.awaitingHeartbeat = false;
    this.clearHeartbeatTimeout();
    this.resetBackoffAfterConfirmedLiveness(socket, socketEpoch);
  }

  private handleSocketFailure(socket: SocketLike, socketEpoch: number, reason: string): void {
    if (!this.isCurrentSocket(socket, socketEpoch)) return;
    this.recover(reason);
  }

  private failAttempt(attempt: ConnectionAttempt, error: KisError): void {
    if (!this.isCurrentAttempt(attempt)) return;
    this.recordError(error);
    attempt.reject(error);
    this.connectionAttempt = undefined;
    this.disposeCurrentSocket();
    this.clearSocketTimers();
    this.scheduleReconnect();
  }

  private recover(_reason: string): void {
    if (this.currentState === "stopped") return;
    const error = supervisorError("NETWORK", true, "WebSocket 연결이 끊어졌습니다.");
    this.recordError(error);
    this.clearSocketTimers();
    this.cancelAttempt(error);
    this.disposeCurrentSocket();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.currentState === "stopped") return;
    if (this.retainCount === 0) {
      this.setState("idle");
      return;
    }
    if (this.reconnectTimer !== undefined) return;
    const delay = this.nextReconnectDelay();
    const generation = ++this.reconnectGeneration;
    this.setState("reconnect_wait");
    if (
      generation !== this.reconnectGeneration ||
      this.currentState !== "reconnect_wait" ||
      this.retainCount === 0
    ) {
      return;
    }
    try {
      const expectedState = this.currentState;
      const timer = this.setTimeoutFn(() => {
        if (generation !== this.reconnectGeneration) return;
        this.reconnectTimer = undefined;
        this.reconnectGeneration += 1;
        if (this.currentState !== expectedState || this.retainCount === 0) return;
        void this.beginConnect().catch(() => undefined);
      }, delay);
      if (generation !== this.reconnectGeneration || this.currentState !== "reconnect_wait") {
        try {
          this.clearTimeoutFn(timer);
        } catch {
          // A generation guard prevents an already-queued stale callback.
        }
        return;
      }
      this.reconnectTimer = timer;
      this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, RECONNECT_DELAYS_MS.length - 1);
      this.diagnostics.increment("websocketReconnects");
    } catch {
      this.setState("idle");
      this.recordFailure("NETWORK", true, "WebSocket 재연결 타이머를 시작하지 못했습니다.");
    }
  }

  private nextReconnectDelay(): number {
    const base = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    let random = 0.5;
    try {
      const value = this.random();
      if (Number.isFinite(value)) random = Math.min(1, Math.max(0, value));
    } catch {
      // Deterministic zero-jitter fallback keeps recovery alive if a host random source fails.
    }
    return Math.max(0, Math.round(base * (0.9 + random * 0.2)));
  }

  private startConnectTimeout(socket: SocketLike, socketEpoch: number, attempt: ConnectionAttempt): void {
    this.clearConnectTimeout();
    try {
      this.connectTimeoutTimer = this.setTimeoutFn(() => {
        this.connectTimeoutTimer = undefined;
        if (!this.isCurrentSocket(socket, socketEpoch) || !this.isCurrentAttempt(attempt)) return;
        this.failAttempt(attempt, supervisorError(
          "TIMEOUT",
          true,
          "WebSocket 연결 시간이 초과되었습니다.",
        ));
      }, CONNECT_TIMEOUT_MS);
    } catch {
      this.failAttempt(attempt, supervisorError(
        "NETWORK",
        true,
        "WebSocket 연결 타이머를 시작하지 못했습니다.",
      ));
    }
  }

  private startHeartbeat(socket: SocketLike, socketEpoch: number): void {
    this.clearHeartbeatTimers();
    try {
      this.heartbeatIntervalTimer = this.setIntervalFn(() => {
        if (!this.isCurrentSocket(socket, socketEpoch) || this.currentState !== "open") return;
        if (this.awaitingHeartbeat || this.safeNow() - this.lastActivityAt < HEARTBEAT_IDLE_MS) return;
        if (typeof socket.ping !== "function") {
          this.recover("heartbeat unavailable");
          return;
        }
        try {
          socket.ping();
          this.awaitingHeartbeat = true;
          this.startHeartbeatTimeout(socket, socketEpoch);
        } catch {
          this.recover("heartbeat ping failed");
        }
      }, HEARTBEAT_IDLE_MS);
    } catch {
      this.recover("heartbeat timer failed");
    }
  }

  private startHeartbeatTimeout(socket: SocketLike, socketEpoch: number): void {
    this.clearHeartbeatTimeout();
    try {
      this.heartbeatTimeoutTimer = this.setTimeoutFn(() => {
        this.heartbeatTimeoutTimer = undefined;
        if (!this.isCurrentSocket(socket, socketEpoch) || !this.awaitingHeartbeat) return;
        this.recover("heartbeat timeout");
      }, HEARTBEAT_TIMEOUT_MS);
    } catch {
      this.recover("heartbeat timeout timer failed");
    }
  }

  private startStableLivenessTimer(socket: SocketLike, socketEpoch: number): void {
    this.clearStableLivenessTimer();
    try {
      this.stableLivenessTimer = this.setTimeoutFn(() => {
        this.stableLivenessTimer = undefined;
        if (!this.isCurrentSocket(socket, socketEpoch) || this.currentState !== "open") return;
        this.resetBackoffAfterConfirmedLiveness(socket, socketEpoch);
      }, STABLE_LIVENESS_MS);
    } catch {
      // The retry counter staying elevated is safer than treating an unknown timer state as healthy.
    }
  }

  private startApprovalRefreshTimer(): void {
    if (this.retainCount === 0 || this.currentState === "stopped" || this.approvalRefreshTimer !== undefined) return;
    try {
      this.approvalRefreshTimer = this.setIntervalFn(() => {
        void this.refreshApprovalKey().catch(() => undefined);
      }, APPROVAL_KEY_REFRESH_INTERVAL_MS);
    } catch {
      this.recordFailure("NETWORK", true, "승인 키 갱신 타이머를 시작하지 못했습니다.");
    }
  }

  private stopForNoDemand(): void {
    this.clearReconnectTimer();
    this.clearApprovalRefreshTimer();
    this.clearSocketTimers();
    this.cancelAttempt();
    this.disposeCurrentSocket();
    this.setState("idle");
  }

  private cancelAttempt(error = supervisorError(
    "NETWORK",
    true,
    "WebSocket 연결 시도가 취소되었습니다.",
  )): void {
    if (!this.connectionAttempt) return;
    this.connectionAttempt.reject(error);
    this.connectionAttempt = undefined;
  }

  private disposeCurrentSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = undefined;
    this.socketEpoch += 1;
    this.disposeSocket(socket);
  }

  private disposeSocket(socket: SocketLike): void {
    try {
      if (typeof socket.terminate === "function") {
        socket.terminate();
      } else {
        socket.close?.();
      }
    } catch {
      // Socket teardown cannot change recovery policy.
    }
  }

  private clearSocketTimers(): void {
    this.clearConnectTimeout();
    this.clearHeartbeatTimers();
    this.clearStableLivenessTimer();
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer === undefined) return;
    try {
      this.clearTimeoutFn(this.connectTimeoutTimer);
    } catch {
      // An old callback still has an epoch guard.
    }
    this.connectTimeoutTimer = undefined;
  }

  private clearHeartbeatTimers(): void {
    if (this.heartbeatIntervalTimer !== undefined) {
      try {
        this.clearIntervalFn(this.heartbeatIntervalTimer);
      } catch {
        // Epoch guards protect a timer that cannot be cleared.
      }
      this.heartbeatIntervalTimer = undefined;
    }
    this.clearHeartbeatTimeout();
    this.awaitingHeartbeat = false;
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer === undefined) return;
    try {
      this.clearTimeoutFn(this.heartbeatTimeoutTimer);
    } catch {
      // Epoch guards protect a timer that cannot be cleared.
    }
    this.heartbeatTimeoutTimer = undefined;
  }

  private clearStableLivenessTimer(): void {
    if (this.stableLivenessTimer === undefined) return;
    try {
      this.clearTimeoutFn(this.stableLivenessTimer);
    } catch {
      // The callback validates the current socket before mutating state.
    }
    this.stableLivenessTimer = undefined;
  }

  private resetBackoffAfterConfirmedLiveness(
    socket: SocketLike,
    socketEpoch: number,
  ): void {
    if (
      !this.isCurrentSocket(socket, socketEpoch) ||
      this.currentState !== "open" ||
      this.awaitingHeartbeat ||
      !this.hasConfirmedLiveness ||
      this.safeNow() - this.openedAt < STABLE_LIVENESS_MS
    ) {
      return;
    }
    this.reconnectAttempts = 0;
  }

  private clearReconnectTimer(): void {
    const timer = this.reconnectTimer;
    this.reconnectTimer = undefined;
    this.reconnectGeneration += 1;
    if (timer !== undefined) {
      try {
        this.clearTimeoutFn(timer);
      } catch {
        // A callback cannot reconnect after its generation changes.
      }
    }
  }

  private clearApprovalRefreshTimer(): void {
    if (this.approvalRefreshTimer === undefined) return;
    try {
      this.clearIntervalFn(this.approvalRefreshTimer);
    } catch {
      // Future refreshes still reject safely when stopped.
    }
    this.approvalRefreshTimer = undefined;
  }

  private isCurrentAttempt(attempt: ConnectionAttempt): boolean {
    return this.currentState === "connecting" &&
      this.connectionAttempt === attempt &&
      this.retainCount > 0;
  }

  private isStopped(): boolean {
    return this.currentState === "stopped";
  }

  private isCurrentSocket(socket: SocketLike, socketEpoch: number): boolean {
    return this.currentState !== "stopped" &&
      this.socket === socket &&
      this.socketEpoch === socketEpoch;
  }

  private isCurrentSocketOpen(): boolean {
    return this.currentState === "open" &&
      this.socket !== undefined &&
      this.socket.readyState === SOCKET_OPEN;
  }

  private setState(next: ConnectionState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.publish(this.stateListeners, next);
  }

  private publish<T>(listeners: Set<SupervisorListener<T>>, value: T): void {
    for (const listener of [...listeners]) {
      try {
        const result = listener(value);
        if (result && typeof (result as PromiseLike<void>).then === "function") {
          void Promise.resolve(result).catch(() => undefined);
        }
      } catch {
        // Observers are not allowed to interrupt transport lifecycle transitions.
      }
    }
  }

  private safeNow(): number {
    try {
      const value = this.now();
      return Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private normalizeApprovalLease(value: ApprovalKeyLease | string): ApprovalKeyLease {
    if (typeof value === "string") {
      if (!isUsableText(value)) throw new TypeError("invalid approval key");
      return Object.freeze({
        approvalKey: value,
        credentialGeneration: 0,
        credentialFingerprint: "legacy",
      });
    }
    if (
      !value ||
      !isUsableText(value.approvalKey) ||
      !Number.isSafeInteger(value.credentialGeneration) ||
      value.credentialGeneration < 0 ||
      !isUsableText(value.credentialFingerprint)
    ) {
      throw new TypeError("invalid approval lease");
    }
    return Object.freeze({
      approvalKey: value.approvalKey,
      credentialGeneration: value.credentialGeneration,
      credentialFingerprint: value.credentialFingerprint,
    });
  }

  private isValidControlCommand(command: KisControlCommand): boolean {
    return (command.trType === "1" || command.trType === "2") &&
      isUsableText(command.trId) &&
      isUsableText(command.trKey);
  }

  private toRawMessage(value: unknown): string {
    try {
      return typeof value === "string" ? value : String(value);
    } catch {
      return "";
    }
  }

  private isPingPong(raw: string): boolean {
    if (raw.startsWith("PINGPONG")) return true;
    if (!raw.startsWith("{")) return false;
    try {
      const decoded: unknown = JSON.parse(raw);
      if (!decoded || typeof decoded !== "object") return false;
      const header = (decoded as { header?: unknown }).header;
      return !!header && typeof header === "object" &&
        (header as { tr_id?: unknown }).tr_id === "PINGPONG";
    } catch {
      return false;
    }
  }

  private recordFailure(
    code: "NETWORK" | "TIMEOUT" | "AUTH_REJECTED" | "PROTOCOL" | "SETTINGS",
    retryable: boolean,
    safeMessage: string,
  ): void {
    this.recordError(supervisorError(code, retryable, safeMessage));
  }

  private recordError(error: KisError): void {
    try {
      this.diagnostics.record(error, { state: this.currentState });
    } catch {
      // Diagnostics cannot affect connectivity.
    }
  }
}
