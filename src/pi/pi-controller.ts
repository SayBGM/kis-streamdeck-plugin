import type {
  DiagnosticEvent,
  DiagnosticsCounter,
  DiagnosticsSnapshot,
} from "../core/diagnostics-store.js";
import { KisError, sanitizeMetadata } from "../core/errors.js";
import {
  CONNECTION_STATES,
  type ConnectionState,
  type ConnectionSupervisorDiagnostics,
} from "../kis/connection-supervisor.js";
import type { CredentialIdentity } from "../kis/credential-session.js";
import type { RestCoordinatorDiagnostics } from "../kis/rest-coordinator.js";
import {
  PHYSICAL_SUBSCRIPTION_STATES,
  type PhysicalSubscriptionState,
  type SubscriptionSupervisorDiagnostics,
} from "../kis/subscription-supervisor.js";
import type { RenderSchedulerDiagnostics } from "../renderer/render-scheduler.js";
import { getStockCardCacheDiagnostics } from "../renderer/stock-card.js";
import type {
  SettingsRepository,
  SettingsSnapshot,
} from "../settings/settings-repository.js";
import type { GlobalSettingsV2 } from "../settings/schema.js";
import type { Market } from "../types/index.js";
import {
  parsePiCommand,
  type PiCommand,
  type PiDiagnosticsSnapshot,
  type PiPush,
  type PiResponse,
  type SanitizedPiSnapshot,
} from "./protocol.js";

const DIAGNOSTICS_INTERVAL_MS = 2_000;
const COUNTERS = [
  "authFailures",
  "restFailures",
  "websocketReconnects",
  "subscriptionRejects",
  "settingsFailures",
  "manualRefreshes",
] as const satisfies readonly DiagnosticsCounter[];
const ERROR_CODES = new Set([
  "NO_CREDENTIALS",
  "AUTH_REJECTED",
  "AUTH_RATE_LIMITED",
  "NETWORK",
  "TIMEOUT",
  "INVALID_INSTRUMENT",
  "PROTOCOL",
  "SUBSCRIPTION_REJECTED",
  "SETTINGS",
]);
const ERROR_SCOPES = new Set(["auth", "rest", "websocket", "action", "settings"]);
const CONNECTION_STATE_SET = new Set<string>(CONNECTION_STATES);

type TimerHandle = unknown;

export type PiOutboundMessage = PiResponse | PiPush;

export interface PiOutboundPort {
  send(contextId: string, message: PiOutboundMessage): Promise<void>;
}

export interface PiCredentialPort {
  reconcile(): Promise<CredentialIdentity>;
  saveCredentials(
    appKey: unknown,
    appSecret: unknown,
    expectedRevision?: number,
  ): Promise<CredentialIdentity>;
  clearCredentials(expectedRevision?: number): Promise<CredentialIdentity>;
  getAccessToken(): Promise<unknown>;
}

export interface PiConnectionPort {
  readonly state: ConnectionState;
  readonly demand: number;
  getDiagnostics(): ConnectionSupervisorDiagnostics;
  refreshApprovalKey(): Promise<boolean>;
  forceReconnect(reason?: string): void;
}

export interface PiControllerOptions {
  readonly settingsRepository: Pick<
    SettingsRepository,
    "whenReady" | "getSnapshot" | "update"
  >;
  readonly credentialSession: PiCredentialPort;
  readonly connection: PiConnectionPort;
  readonly subscriptions: { getDiagnostics(): SubscriptionSupervisorDiagnostics };
  readonly rest: { getDiagnostics(): RestCoordinatorDiagnostics };
  readonly render: { getDiagnostics(): RenderSchedulerDiagnostics };
  readonly diagnostics: { report(): DiagnosticsSnapshot; record?(error: KisError): void };
  readonly manualRefresh: (market: Market, actionId: string) => Promise<void>;
  readonly sender: PiOutboundPort;
  readonly setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly clearInterval?: (handle: TimerHandle) => void;
}

interface VisibleContext {
  readonly contextId: string;
  market: Market;
  appearances: number;
  generation: number;
}

interface OperationFence {
  readonly controllerGeneration: number;
  readonly contextId: string;
  readonly contextGeneration?: number;
  readonly tracked: boolean;
}

function defaultSetInterval(callback: () => void, milliseconds: number): TimerHandle {
  return setInterval(callback, milliseconds);
}

function defaultClearInterval(handle: TimerHandle): void {
  clearInterval(handle as ReturnType<typeof setInterval>);
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function safeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable && "value" in descriptor
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function dataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (descriptor.enumerable && "value" in descriptor) copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return undefined;
  }
}

function maskAppKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  if (!key) return undefined;
  if (key.length <= 4) return "•".repeat(key.length);
  const prefixLength = Math.min(3, Math.max(1, key.length - 3));
  const suffixLength = Math.min(3, key.length - prefixLength);
  return `${key.slice(0, prefixLength)}••••${key.slice(-suffixLength)}`;
}

function configured(settings: Readonly<GlobalSettingsV2>): boolean {
  return typeof settings.appKey === "string" && settings.appKey.trim().length > 0 &&
    typeof settings.appSecret === "string" && settings.appSecret.trim().length > 0;
}

function protocolError(): KisError {
  return Object.freeze(new KisError({
    code: "PROTOCOL",
    scope: "action",
    retryable: false,
    safeMessage: "허용되지 않은 Property Inspector 명령입니다.",
  }));
}

function settingsUnavailableError(): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: true,
    safeMessage: "설정을 안전하게 불러오지 못했습니다.",
  }));
}

function conflictError(): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: true,
    safeMessage: "다른 설정 변경이 먼저 저장되었습니다. 최신 값을 다시 불러오세요.",
  }));
}

function authRetryError(): KisError {
  return Object.freeze(new KisError({
    code: "AUTH_REJECTED",
    scope: "auth",
    retryable: true,
    safeMessage: "인증 연결을 다시 준비하지 못했습니다.",
  }));
}

function normalizeError(error: unknown): KisError {
  if (error instanceof KisError) return error;
  return settingsUnavailableError();
}

function assertReady(snapshot: SettingsSnapshot): void {
  if (!snapshot.status.baseKnown || snapshot.status.persistenceDegraded) {
    throw snapshot.status.error ?? settingsUnavailableError();
  }
}

function assertRevision(
  settings: Readonly<GlobalSettingsV2>,
  expectedRevision?: number,
): void {
  if (expectedRevision !== undefined && settings.settingsRevision !== expectedRevision) {
    throw conflictError();
  }
}

function safeEvent(value: unknown): DiagnosticEvent | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptors(value);
    const code = descriptor.code?.value;
    const scope = descriptor.scope?.value;
    const retryable = descriptor.retryable?.value;
    const at = descriptor.at?.value;
    const metadata = descriptor.metadata?.value;
    if (
      !ERROR_CODES.has(code) ||
      !ERROR_SCOPES.has(scope) ||
      typeof retryable !== "boolean" ||
      typeof at !== "number" ||
      !Number.isFinite(at)
    ) return undefined;
    const metadataRecord = dataRecord(metadata);
    const safeMetadata = metadataRecord
      ? sanitizeMetadata(metadataRecord)
      : {};
    return Object.freeze({
      code,
      scope,
      retryable,
      at,
      ...(Object.keys(safeMetadata).length > 0 ? { metadata: safeMetadata } : {}),
    }) as DiagnosticEvent;
  } catch {
    return undefined;
  }
}

function safeRecentErrors(value: unknown): DiagnosticsSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { events: [], counters: {} };
  }
  try {
    const eventSource = ownData(value, "events");
    const counterSource = ownData(value, "counters");
    const events = Array.isArray(eventSource)
      ? eventSource.map(safeEvent).filter((event): event is DiagnosticEvent => event !== undefined).slice(-100)
      : [];
    const counters: Partial<Record<DiagnosticsCounter, number>> = {};
    if (typeof counterSource === "object" && counterSource !== null && !Array.isArray(counterSource)) {
      for (const key of COUNTERS) {
        const descriptor = Object.getOwnPropertyDescriptor(counterSource, key);
        if (descriptor && "value" in descriptor && typeof descriptor.value === "number" && Number.isFinite(descriptor.value)) {
          counters[key] = descriptor.value;
        }
      }
    }
    return { events, counters };
  } catch {
    return { events: [], counters: {} };
  }
}

function safeConnection(value: unknown, fallback: PiConnectionPort): PiDiagnosticsSnapshot["websocket"] {
  const sourceState = ownData(value, "state");
  const state = typeof sourceState === "string" && CONNECTION_STATE_SET.has(sourceState)
    ? sourceState as ConnectionState
    : CONNECTION_STATE_SET.has(fallback.state) ? fallback.state : "idle";
  const lastActivityAt = safeTimestamp(ownData(value, "lastActivityAt"));
  return {
    state,
    demand: safeInteger(ownData(value, "demand") ?? fallback.demand),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    heartbeatPending: ownData(value, "heartbeatPending") === true,
    reconnectAttempts: safeInteger(ownData(value, "reconnectAttempts")),
  };
}

function safeSubscriptions(value: unknown): PiDiagnosticsSnapshot["subscriptions"] {
  const states: Partial<Record<PhysicalSubscriptionState, number>> = {};
  const stateSource = ownData(value, "states");
  if (typeof stateSource === "object" && stateSource !== null && !Array.isArray(stateSource)) {
    for (const state of PHYSICAL_SUBSCRIPTION_STATES) {
      const descriptor = Object.getOwnPropertyDescriptor(stateSource, state);
      if (descriptor && "value" in descriptor) states[state] = safeInteger(descriptor.value);
    }
  }
  return {
    total: safeInteger(ownData(value, "total")),
    states,
    queuedControls: safeInteger(ownData(value, "queuedControls")),
    rotationActive: ownData(value, "rotationActive") === true,
    rotationQueued: safeInteger(ownData(value, "rotationQueued")),
  };
}

function safeRest(value: unknown, failures: number): PiDiagnosticsSnapshot["restBackup"] {
  return {
    queuedRequests: safeInteger(ownData(value, "queuedRequests")),
    sharedRequests: safeInteger(ownData(value, "sharedRequests")),
    activeTransports: safeInteger(ownData(value, "activeTransports")),
    cacheEntries: safeInteger(ownData(value, "cacheEntries")),
    startsInRateWindow: safeInteger(ownData(value, "startsInRateWindow")),
    failures,
  };
}

function safeRender(value: unknown): Omit<PiDiagnosticsSnapshot["render"], "cacheEntries"> {
  return {
    activeTargets: safeInteger(ownData(value, "activeTargets")),
    queuedTargets: safeInteger(ownData(value, "queuedTargets")),
    submitted: safeInteger(ownData(value, "submitted")),
    coalesced: safeInteger(ownData(value, "coalesced")),
    renders: safeInteger(ownData(value, "renders")),
    commits: safeInteger(ownData(value, "commits")),
    semanticSkips: safeInteger(ownData(value, "semanticSkips")),
    imageSkips: safeInteger(ownData(value, "imageSkips")),
    supersededSkips: safeInteger(ownData(value, "supersededSkips")),
    staleDrops: safeInteger(ownData(value, "staleDrops")),
    failures: safeInteger(ownData(value, "failures")),
  };
}

/** Command-only Property Inspector boundary. Sensitive runtime capabilities never cross it. */
export class PiController {
  private readonly settingsRepository: PiControllerOptions["settingsRepository"];
  private readonly credentials: PiControllerOptions["credentialSession"];
  private readonly connection: PiControllerOptions["connection"];
  private readonly subscriptions: PiControllerOptions["subscriptions"];
  private readonly rest: PiControllerOptions["rest"];
  private readonly render: PiControllerOptions["render"];
  private readonly diagnostics: PiControllerOptions["diagnostics"];
  private readonly manualRefresh: PiControllerOptions["manualRefresh"];
  private readonly sender: PiOutboundPort;
  private readonly setIntervalFn: NonNullable<PiControllerOptions["setInterval"]>;
  private readonly clearIntervalFn: NonNullable<PiControllerOptions["clearInterval"]>;
  private readonly contexts = new Map<string, VisibleContext>();
  private readonly contextGenerations = new Map<string, number>();
  private interval: TimerHandle | undefined;
  private diagnosticsPush: Promise<void> | undefined;
  private nextGeneration = 0;
  private controllerGeneration = 1;
  private commandTail: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(options: PiControllerOptions) {
    this.settingsRepository = options.settingsRepository;
    this.credentials = options.credentialSession;
    this.connection = options.connection;
    this.subscriptions = options.subscriptions;
    this.rest = options.rest;
    this.render = options.render;
    this.diagnostics = options.diagnostics;
    this.manualRefresh = options.manualRefresh;
    this.sender = options.sender;
    this.setIntervalFn = options.setInterval ?? defaultSetInterval;
    this.clearIntervalFn = options.clearInterval ?? defaultClearInterval;
  }

  async propertyInspectorDidAppear(contextId: string, market: Market): Promise<void> {
    if (this.destroyed || !contextId) return;
    let context = this.contexts.get(contextId);
    if (context) {
      context.appearances += 1;
      context.market = market;
    } else {
      context = {
        contextId,
        market,
        appearances: 1,
        generation: ++this.nextGeneration,
      };
      this.contexts.set(contextId, context);
      this.contextGenerations.set(contextId, context.generation);
    }
    this.ensureInterval();
    const generation = context.generation;
    try {
      const snapshot = await this.buildSnapshot();
      if (this.isCurrent(contextId, generation)) {
        await this.safeSend(contextId, { type: "settings/update", snapshot });
      }
    } catch (error) {
      this.record(normalizeError(error));
    }
  }

  async propertyInspectorDidDisappear(contextId: string): Promise<void> {
    const context = this.contexts.get(contextId);
    if (!context) {
      this.contextGenerations.set(contextId, ++this.nextGeneration);
      if (this.contexts.size === 0) this.clearDiagnosticsInterval();
      return;
    }
    context.appearances -= 1;
    if (context.appearances <= 0) {
      this.contexts.delete(contextId);
      this.contextGenerations.set(contextId, ++this.nextGeneration);
    }
    if (this.contexts.size === 0) this.clearDiagnosticsInterval();
  }

  handleCommand(contextId: string, market: Market, rawCommand: unknown): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const parsed = parsePiCommand(rawCommand);
    const requestId = parsed?.requestId ?? "invalid";
    const fence = this.captureFence(contextId);
    const operation = this.commandTail.then(async () => {
      if (!this.fenceCurrent(fence)) return;
      if (!parsed) {
        await this.safeSend(
          contextId,
          this.failure(requestId, protocolError()),
          () => this.fenceCurrent(fence),
        );
        return;
      }
      try {
        await this.execute(contextId, market, parsed, () => this.fenceCurrent(fence));
        if (!this.fenceCurrent(fence)) return;
        const snapshot = await this.buildSnapshot();
        if (!this.fenceCurrent(fence)) return;
        await this.safeSend(
          contextId,
          { requestId, ok: true, snapshot },
          () => this.fenceCurrent(fence),
        );
      } catch (error) {
        const safe = normalizeError(error);
        this.record(safe);
        const snapshot = await this.recoverSnapshot(safe, () => this.fenceCurrent(fence));
        await this.safeSend(
          contextId,
          this.failure(requestId, safe, snapshot),
          () => this.fenceCurrent(fence),
        );
      }
    });
    this.commandTail = operation.catch(() => undefined);
    return operation;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.controllerGeneration += 1;
    this.contexts.clear();
    this.clearDiagnosticsInterval();
  }

  private async execute(
    contextId: string,
    market: Market,
    command: PiCommand,
    current: () => boolean,
  ): Promise<void> {
    if (!current()) return;
    if (command.type === "settings/request" || command.type === "diagnostics/request") {
      await this.readySnapshot();
      return;
    }
    if (command.type === "credentials/save") {
      const settingsSnapshot = await this.readySnapshot();
      if (!current()) return;
      assertRevision(settingsSnapshot.settings, command.settingsRevision);
      const secret = command.appSecret === undefined
        ? settingsSnapshot.settings.appSecret
        : command.appSecret;
      if (!current()) return;
      // Once persistence starts it cannot be cancelled; every follow-up is fenced.
      await this.credentials.saveCredentials(
        command.appKey,
        secret,
        command.settingsRevision,
      );
      if (!current()) return;
      await this.credentials.reconcile();
      return;
    }
    if (command.type === "credentials/clear") {
      const settingsSnapshot = await this.readySnapshot();
      if (!current()) return;
      assertRevision(settingsSnapshot.settings, command.settingsRevision);
      if (!current()) return;
      await this.credentials.clearCredentials(command.settingsRevision);
      if (!current()) return;
      await this.credentials.reconcile();
      return;
    }
    if (command.type === "preferences/save") {
      if (!current()) return;
      await this.settingsRepository.update((draft) => {
        assertRevision(draft, command.settingsRevision);
        draft.preferences = {
          ...draft.preferences,
          ...command.preferences,
        };
      });
      return;
    }
    if (command.type === "auth/retry") {
      if (!current()) return;
      await this.credentials.reconcile();
      if (!current()) return;
      await this.credentials.getAccessToken();
      if (!current()) return;
      if (!await this.connection.refreshApprovalKey()) throw authRetryError();
      return;
    }
    if (command.type === "ws/reconnect") {
      if (current()) this.connection.forceReconnect("property-inspector");
      return;
    }
    if (current()) await this.manualRefresh(market, contextId);
  }

  private async readySnapshot(): Promise<SettingsSnapshot> {
    await this.settingsRepository.whenReady();
    const snapshot = this.settingsRepository.getSnapshot();
    assertReady(snapshot);
    return snapshot;
  }

  private async buildSnapshot(): Promise<SanitizedPiSnapshot> {
    const snapshot = await this.readySnapshot();
    const settings = snapshot.settings;
    const diagnostics = this.buildDiagnostics(settings);
    const maskedAppKey = maskAppKey(settings.appKey);
    return {
      schemaVersion: 2,
      settingsRevision: settings.settingsRevision,
      credentialsConfigured: configured(settings),
      ...(maskedAppKey ? { maskedAppKey } : {}),
      preferences: {
        dataMode: settings.preferences.dataMode,
        renderIntervalMs: settings.preferences.renderIntervalMs,
        backupPollIntervalMs: settings.preferences.backupPollIntervalMs,
      },
      diagnostics,
    };
  }

  private buildDiagnostics(settings: Readonly<GlobalSettingsV2>): PiDiagnosticsSnapshot {
    let recentErrors: DiagnosticsSnapshot = { events: [], counters: {} };
    let connection: unknown;
    let subscriptions: unknown;
    let rest: unknown;
    let render: unknown;
    try { recentErrors = safeRecentErrors(this.diagnostics.report()); } catch { /* safe fallback */ }
    try { connection = this.connection.getDiagnostics(); } catch { /* safe fallback */ }
    try { subscriptions = this.subscriptions.getDiagnostics(); } catch { /* safe fallback */ }
    try { rest = this.rest.getDiagnostics(); } catch { /* safe fallback */ }
    try { render = this.render.getDiagnostics(); } catch { /* safe fallback */ }
    const tokenExpiresAt = configured(settings) ? safeTimestamp(settings.accessTokenExpiry) : undefined;
    return {
      auth: {
        configured: configured(settings),
        credentialGeneration: safeInteger(settings.credentialGeneration),
        ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
      },
      websocket: safeConnection(connection, this.connection),
      subscriptions: safeSubscriptions(subscriptions),
      restBackup: safeRest(rest, safeInteger(recentErrors.counters.restFailures)),
      render: {
        ...safeRender(render),
        cacheEntries: safeInteger(getStockCardCacheDiagnostics().entries),
      },
      recentErrors,
    };
  }

  private failure(
    requestId: string,
    error: KisError,
    snapshot?: SanitizedPiSnapshot,
  ): PiResponse {
    return {
      requestId,
      ok: false,
      error: {
        code: error.code,
        scope: error.scope,
        retryable: error.retryable,
        safeMessage: error.safeMessage,
      },
      ...(snapshot ? { snapshot } : {}),
    };
  }

  private async recoverSnapshot(
    error: KisError,
    current: () => boolean,
  ): Promise<SanitizedPiSnapshot | undefined> {
    if (error.code !== "SETTINGS" || !current()) return undefined;
    try {
      // A revision conflict can be thrown before the repository adopts the fresh
      // disk state. A no-op transaction refreshes it without advancing revision.
      await this.settingsRepository.update(() => undefined);
      if (!current()) return undefined;
      return await this.buildSnapshot();
    } catch {
      return undefined;
    }
  }

  private ensureInterval(): void {
    if (this.interval !== undefined || this.contexts.size === 0 || this.destroyed) return;
    try {
      this.interval = this.setIntervalFn(() => {
        this.startDiagnosticsPush();
      }, DIAGNOSTICS_INTERVAL_MS);
    } catch {
      this.interval = undefined;
    }
  }

  private clearDiagnosticsInterval(): void {
    const interval = this.interval;
    this.interval = undefined;
    if (interval === undefined) return;
    try { this.clearIntervalFn(interval); } catch { /* best effort */ }
  }

  private startDiagnosticsPush(): void {
    if (this.diagnosticsPush || this.destroyed || this.contexts.size === 0) return;
    const generation = this.controllerGeneration;
    const operation = this.pushDiagnostics(generation).finally(() => {
      if (this.diagnosticsPush === operation) this.diagnosticsPush = undefined;
    });
    this.diagnosticsPush = operation;
    void operation.catch(() => undefined);
  }

  private async pushDiagnostics(generation: number): Promise<void> {
    if (
      this.destroyed ||
      generation !== this.controllerGeneration ||
      this.contexts.size === 0
    ) return;
    const visible = [...this.contexts.values()].map((context) => ({
      contextId: context.contextId,
      generation: context.generation,
    }));
    let snapshot: SanitizedPiSnapshot;
    try {
      snapshot = await this.buildSnapshot();
    } catch (error) {
      this.record(normalizeError(error));
      return;
    }
    if (this.destroyed || generation !== this.controllerGeneration) return;
    for (const context of visible) {
      if (!this.isCurrent(context.contextId, context.generation)) continue;
      await this.safeSend(
        context.contextId,
        { type: "diagnostics/update", snapshot },
        () => generation === this.controllerGeneration &&
          this.isCurrent(context.contextId, context.generation),
      );
    }
  }

  private isCurrent(contextId: string, generation: number): boolean {
    const current = this.contexts.get(contextId);
    return current?.generation === generation && current.appearances > 0;
  }

  private captureFence(contextId: string): OperationFence {
    const context = this.contexts.get(contextId);
    return Object.freeze({
      controllerGeneration: this.controllerGeneration,
      contextId,
      ...(context ? { contextGeneration: context.generation } : {}),
      tracked: this.contextGenerations.has(contextId),
    });
  }

  private fenceCurrent(fence: OperationFence): boolean {
    if (
      this.destroyed ||
      fence.controllerGeneration !== this.controllerGeneration
    ) return false;
    if (!fence.tracked) {
      return !this.contextGenerations.has(fence.contextId);
    }
    if (fence.contextGeneration === undefined) return false;
    return this.isCurrent(fence.contextId, fence.contextGeneration);
  }

  private async safeSend(
    contextId: string,
    message: PiOutboundMessage,
    current: () => boolean = () => !this.destroyed,
  ): Promise<void> {
    if (!current()) return;
    try { await this.sender.send(contextId, message); } catch { /* PI may have disappeared */ }
  }

  private record(error: KisError): void {
    try { this.diagnostics.record?.(error); } catch { /* observational */ }
  }
}
