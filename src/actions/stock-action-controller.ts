import { isOverseasDayTradingAt, type MarketSnapshot } from "../core/market-clock.js";
import { KisError, type KisErrorCode } from "../core/errors.js";
import type {
  CanonicalInstrument,
  KisWebSocketDescriptor,
  MarketAdapter,
  QuoteSample,
} from "../markets/market-adapter.js";
import type {
  PhysicalSubscriptionState,
  SubscriptionDataEvent,
  SubscriptionHandle,
  SubscriptionObserver,
  SubscriptionSnapshot,
} from "../kis/subscription-supervisor.js";
import type { RestQuoteRequest } from "../kis/rest-coordinator.js";
import type { RenderCategory, RenderIntervalMs, RenderRequest } from "../renderer/render-scheduler.js";
import type { SettingsSnapshot } from "../settings/settings-repository.js";
import type { GlobalPreferencesV2 } from "../settings/schema.js";
import type { Market, MarketSession } from "../types/index.js";

const INITIAL_WS_GRACE_MS = 5_000;
const POLICY_TICK_MS = 60_000;
const RECOVERY_DISPLAY_MS = 2_000;

type TimerHandle = unknown;

export interface StockActionPort {
  setImage(image: string): void | Promise<void>;
}

export interface StockActionAppearInput<Settings> {
  readonly actionId: string;
  readonly settings: Settings;
  readonly actionPort: StockActionPort;
}

export type StockActionConnection = "LIVE" | "BACKUP" | "BROKEN" | "waiting";

export interface StockActionViewError {
  readonly code: KisErrorCode;
  readonly message: string;
}

export interface StockActionViewInstrument {
  readonly symbol: string;
  readonly name: string;
  readonly market: Market;
}

/** 렌더러에 전달되는 유일한 불변 화면 모델입니다. */
export interface StockActionView {
  readonly actionId: string;
  readonly instrument: StockActionViewInstrument;
  readonly session: MarketSession;
  readonly quote?: Readonly<QuoteSample>;
  readonly connection: StockActionConnection;
  readonly stale: boolean;
  readonly refreshing: boolean;
  readonly recovery: boolean;
  readonly error?: StockActionViewError;
}

export interface StockActionSettingsRepositoryPort {
  whenReady(): Promise<SettingsSnapshot>;
  getSnapshot(): SettingsSnapshot;
  subscribe(listener: (snapshot: SettingsSnapshot) => void | Promise<void>): () => void;
}

export interface StockActionClockPort {
  snapshot(): MarketSnapshot;
  subscribe(listener: (snapshot: MarketSnapshot) => void | Promise<void>): () => void;
  start(): void;
  stop(): void;
}

export interface StockActionSubscriptionPort {
  subscribe(
    descriptor: KisWebSocketDescriptor,
    observer?: SubscriptionObserver,
  ): SubscriptionHandle;
  retargetAll(
    oldDescriptor: KisWebSocketDescriptor,
    nextDescriptor: KisWebSocketDescriptor,
  ): Promise<void>;
}

export interface StockActionRestPort {
  requestQuote(input: RestQuoteRequest): Promise<QuoteSample>;
}

export interface StockActionRenderSchedulerPort {
  activate(targetId: string, intervalMs: RenderIntervalMs): number;
  updateInterval(targetId: string, generation: number, intervalMs: RenderIntervalMs): boolean;
  submit(targetId: string, generation: number, request: RenderRequest): boolean;
  remove(targetId: string, generation: number): boolean;
}

export interface StockActionControllerDependencies<Settings> {
  readonly settingsRepository: StockActionSettingsRepositoryPort;
  readonly clocks: Readonly<Record<Market, StockActionClockPort>>;
  readonly subscriptions: StockActionSubscriptionPort;
  readonly restCoordinator: StockActionRestPort;
  readonly renderScheduler: StockActionRenderSchedulerPort;
  readonly adapterResolver: (settings: Settings) => MarketAdapter<Settings>;
  readonly migrateSettings?: (settings: Settings) => Settings;
  readonly renderer: (view: StockActionView) => string | Promise<string>;
  readonly fallbackMarket?: Market;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout?: (handle: TimerHandle) => void;
}

interface ActionRecord<Settings> {
  epoch: number;
  input?: StockActionAppearInput<Settings>;
}

interface SubscriptionBinding {
  policyGeneration: number;
}

interface ActionSession<Settings> {
  readonly actionId: string;
  readonly lifecycleEpoch: number;
  readonly input: StockActionAppearInput<Settings>;
  readonly adapter: MarketAdapter<Settings>;
  readonly instrument: CanonicalInstrument;
  readonly clock: StockActionClockPort;
  readonly renderGeneration: number;
  policyGeneration: number;
  preferences: GlobalPreferencesV2;
  snapshot: MarketSnapshot;
  subscription?: SubscriptionHandle;
  subscriptionBinding?: SubscriptionBinding;
  wsDescriptor?: KisWebSocketDescriptor;
  subscriptionState?: PhysicalSubscriptionState;
  unsubscribeClock?: () => void;
  graceTimer?: TimerHandle;
  pollTimer?: TimerHandle;
  policyTimer?: TimerHandle;
  recoveryTimer?: TimerHandle;
  fallbackAbort?: AbortController;
  readonly policyAbortControllers: Set<AbortController>;
  retargetPromise?: Promise<void>;
  manualAbort?: AbortController;
  lastQuote?: QuoteSample;
  connection: StockActionConnection;
  stale: boolean;
  error?: StockActionViewError;
  hasValidWebSocketData: boolean;
  webSocketRevision: number;
  fallbackActive: boolean;
  closedRequestKey?: string;
  manualPromise?: Promise<void>;
  credentialIdentityKey: string;
  destroyed: boolean;
}

function defaultSetTimeout(callback: () => void, delayMs: number): TimerHandle {
  return setTimeout(callback, delayMs);
}

function defaultClearTimeout(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCredentials(snapshot: SettingsSnapshot): boolean {
  return snapshot.status.baseKnown &&
    isNonEmptyString(snapshot.settings.appKey) &&
    isNonEmptyString(snapshot.settings.appSecret);
}

function credentialIdentityKey(snapshot: SettingsSnapshot): string {
  return JSON.stringify([
    hasCredentials(snapshot),
    snapshot.settings.credentialGeneration,
    snapshot.settings.credentialFingerprint ?? "",
  ]);
}

function safeError(value: unknown, fallbackCode: KisErrorCode): StockActionViewError {
  if (value instanceof KisError) {
    return Object.freeze({ code: value.code, message: value.safeMessage });
  }
  return Object.freeze({
    code: fallbackCode,
    message: fallbackCode === "INVALID_INSTRUMENT"
      ? "종목 설정이 올바르지 않습니다."
      : "시세를 불러오지 못했습니다.",
  });
}

function clonePreferences(snapshot: SettingsSnapshot): GlobalPreferencesV2 {
  return Object.freeze({
    ...snapshot.settings.preferences,
    dataMode: snapshot.settings.preferences.dataMode,
    renderIntervalMs: snapshot.settings.preferences.renderIntervalMs,
    backupPollIntervalMs: snapshot.settings.preferences.backupPollIntervalMs,
  });
}

function isRealtime(session: MarketSession): boolean {
  return session !== "CLOSED";
}

function sameDescriptor(
  left: KisWebSocketDescriptor | undefined,
  right: KisWebSocketDescriptor,
): boolean {
  return left?.trId === right.trId && left.trKey === right.trKey;
}

function sameMarketSnapshot(left: MarketSnapshot, right: MarketSnapshot): boolean {
  return left.market === right.market &&
    left.session === right.session &&
    left.sessionEpoch === right.sessionEpoch &&
    left.nextTransitionAt === right.nextTransitionAt;
}

function semanticKey(view: StockActionView): string {
  return JSON.stringify([
    view.instrument.name,
    view.instrument.symbol,
    view.instrument.market,
    view.session,
    view.quote?.price ?? null,
    view.quote?.changeRate ?? null,
    view.quote?.sign ?? null,
    view.connection,
    view.stale,
    view.refreshing,
    view.recovery,
    view.error?.code ?? null,
    view.error?.message ?? null,
  ]);
}

function freezeQuote(quote: QuoteSample | undefined): Readonly<QuoteSample> | undefined {
  if (!quote) return undefined;
  return Object.freeze({ ...quote });
}

/**
 * Stream Deck 이벤트와 KIS 계층 사이의 공통 액션 수명주기/데이터 정책 엔진입니다.
 * SDK 객체는 StockActionPort 외에는 보관하지 않으며 모든 비동기 경계는 버튼 세대로 차단합니다.
 */
export class StockActionController<Settings> {
  private readonly settingsRepository: StockActionSettingsRepositoryPort;
  private readonly clocks: Readonly<Record<Market, StockActionClockPort>>;
  private readonly subscriptions: StockActionSubscriptionPort;
  private readonly restCoordinator: StockActionRestPort;
  private readonly renderScheduler: StockActionRenderSchedulerPort;
  private readonly adapterResolver: (settings: Settings) => MarketAdapter<Settings>;
  private readonly migrateSettings: (settings: Settings) => Settings;
  private readonly renderer: (view: StockActionView) => string | Promise<string>;
  private readonly fallbackMarket: Market;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly records = new Map<string, ActionRecord<Settings>>();
  private readonly sessions = new Map<string, ActionSession<Settings>>();
  private readonly fatalRenderGenerations = new Map<string, number>();
  private settingsSnapshot?: SettingsSnapshot;
  private unsubscribeSettings?: () => void;
  private settingsSubscriptionStarted = false;
  private destroyed = false;
  private nextEpoch = 0;

  constructor(dependencies: StockActionControllerDependencies<Settings>) {
    this.settingsRepository = dependencies.settingsRepository;
    this.clocks = dependencies.clocks;
    this.subscriptions = dependencies.subscriptions;
    this.restCoordinator = dependencies.restCoordinator;
    this.renderScheduler = dependencies.renderScheduler;
    this.adapterResolver = dependencies.adapterResolver;
    this.migrateSettings = dependencies.migrateSettings ?? ((settings) => settings);
    this.renderer = dependencies.renderer;
    this.fallbackMarket = dependencies.fallbackMarket ?? "domestic";
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimeout ?? defaultSetTimeout;
    this.clearTimer = dependencies.clearTimeout ?? defaultClearTimeout;
  }

  async appear(input: StockActionAppearInput<Settings>): Promise<void> {
    if (this.destroyed) {
      await this.settingsRepository.whenReady();
      return;
    }
    const epoch = ++this.nextEpoch;
    const previous = this.records.get(input.actionId);
    this.records.set(input.actionId, { epoch, input });
    if (previous) this.teardownSession(input.actionId);

    const ready = await this.ensureReady();
    const record = this.records.get(input.actionId);
    if (this.destroyed || record?.epoch !== epoch || record.input !== input) return;
    await this.createSession(input, epoch, ready);
  }

  async updateSettings(actionId: string, settings: Settings): Promise<void> {
    if (this.destroyed) {
      await this.settingsRepository.whenReady();
      return;
    }
    const previous = this.records.get(actionId);
    if (!previous?.input) {
      await this.ensureReady();
      return;
    }
    const epoch = ++this.nextEpoch;
    const input: StockActionAppearInput<Settings> = {
      actionId,
      settings,
      actionPort: previous.input.actionPort,
    };
    this.records.set(actionId, { epoch, input });
    this.teardownSession(actionId);

    const ready = await this.ensureReady();
    if (this.destroyed || this.records.get(actionId)?.epoch !== epoch) return;
    await this.createSession(input, epoch, ready);
  }

  async disappear(actionId: string): Promise<void> {
    const epoch = ++this.nextEpoch;
    this.records.set(actionId, { epoch });
    this.teardownSession(actionId);
    await this.ensureReady();
    if (this.records.get(actionId)?.epoch === epoch) this.records.delete(actionId);
  }

  async manualRefresh(actionId: string): Promise<void> {
    await this.ensureReady();
    const session = this.sessions.get(actionId);
    if (!session || !this.isCurrent(session) || session.manualPromise) {
      return session?.manualPromise;
    }
    const operation = this.performManual(session).finally(() => {
      if (session.manualPromise === operation) session.manualPromise = undefined;
    });
    session.manualPromise = operation;
    return operation;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.nextEpoch += 1;
    for (const actionId of [...this.sessions.keys()]) this.teardownSession(actionId);
    for (const actionId of [...this.fatalRenderGenerations.keys()]) this.teardownSession(actionId);
    this.records.clear();
    try { this.unsubscribeSettings?.(); } catch { /* best effort */ }
    this.unsubscribeSettings = undefined;
    for (const clock of new Set(Object.values(this.clocks))) {
      try { clock.stop(); } catch { /* best effort */ }
    }
    await this.settingsRepository.whenReady();
  }

  private async ensureReady(): Promise<SettingsSnapshot> {
    await this.settingsRepository.whenReady();
    this.settingsSnapshot = this.settingsRepository.getSnapshot();
    if (!this.settingsSubscriptionStarted && !this.destroyed) {
      this.settingsSubscriptionStarted = true;
      this.unsubscribeSettings = this.settingsRepository.subscribe((snapshot) => {
        this.settingsSnapshot = snapshot;
        this.reconfigureForGlobalSettings(snapshot);
      });
    }
    return this.settingsSnapshot;
  }

  private async createSession(
    input: StockActionAppearInput<Settings>,
    epoch: number,
    global: SettingsSnapshot,
  ): Promise<void> {
    let adapter: MarketAdapter<Settings>;
    let instrument: CanonicalInstrument;
    let actionSettings: Settings;
    try {
      actionSettings = this.migrateSettings(input.settings);
      adapter = this.adapterResolver(actionSettings);
      instrument = adapter.toInstrument(actionSettings);
    } catch (error) {
      this.renderStandaloneFatal(input, epoch, safeError(error, "INVALID_INSTRUMENT"), global);
      return;
    }

    const preferences = clonePreferences(global);
    const clock = this.clocks[adapter.market];
    const renderGeneration = this.renderScheduler.activate(
      input.actionId,
      preferences.renderIntervalMs,
    );
    const session: ActionSession<Settings> = {
      actionId: input.actionId,
      lifecycleEpoch: epoch,
      input: { ...input, settings: actionSettings },
      adapter,
      instrument,
      clock,
      renderGeneration,
      policyGeneration: 1,
      preferences,
      snapshot: clock.snapshot(),
      connection: "waiting",
      stale: false,
      hasValidWebSocketData: false,
      webSocketRevision: 0,
      fallbackActive: false,
      policyAbortControllers: new Set(),
      credentialIdentityKey: credentialIdentityKey(global),
      destroyed: false,
    };
    this.sessions.set(input.actionId, session);

    if (!hasCredentials(global)) {
      session.connection = "BROKEN";
      session.error = Object.freeze({
        code: global.status.baseKnown ? "NO_CREDENTIALS" : "SETTINGS",
        message: global.status.baseKnown
          ? "KIS API 자격증명을 입력해 주세요."
          : "설정을 불러오지 못했습니다.",
      });
      this.submitView(session, "immediate");
      return;
    }

    this.attachClock(session);
    this.reconfigurePolicy(session);
  }

  private renderStandaloneFatal(
    input: StockActionAppearInput<Settings>,
    epoch: number,
    error: StockActionViewError,
    global: SettingsSnapshot,
  ): void {
    if (this.records.get(input.actionId)?.epoch !== epoch) return;
    const generation = this.renderScheduler.activate(
      input.actionId,
      global.settings.preferences.renderIntervalMs,
    );
    this.fatalRenderGenerations.set(input.actionId, generation);
    const view: StockActionView = Object.freeze({
      actionId: input.actionId,
      instrument: Object.freeze({ symbol: "", name: "설정 필요", market: this.fallbackMarket }),
      session: "CLOSED",
      connection: "BROKEN",
      stale: false,
      refreshing: false,
      recovery: false,
      error,
    });
    this.renderScheduler.submit(input.actionId, generation, {
      category: "immediate",
      semanticKey: semanticKey(view),
      render: () => this.renderer(view),
      commit: async (image) => {
        if (this.destroyed || this.records.get(input.actionId)?.epoch !== epoch) return;
        await input.actionPort.setImage(image);
      },
    });
  }

  private reconfigureForGlobalSettings(snapshot: SettingsSnapshot): void {
    for (const session of [...this.sessions.values()]) {
      if (!this.isCurrent(session)) continue;
      const nextIdentityKey = credentialIdentityKey(snapshot);
      const effective = this.effectiveSnapshot(session.adapter.market, session.clock.snapshot());
      const preserveClosedRequest = hasCredentials(snapshot) &&
        session.credentialIdentityKey === nextIdentityKey &&
        !isRealtime(session.snapshot.session) &&
        !isRealtime(effective.session) &&
        session.snapshot.sessionEpoch === effective.sessionEpoch;
      session.preferences = clonePreferences(snapshot);
      this.renderScheduler.updateInterval(
        session.actionId,
        session.renderGeneration,
        session.preferences.renderIntervalMs,
      );
      if (preserveClosedRequest) {
        session.snapshot = effective;
        continue;
      }
      session.credentialIdentityKey = nextIdentityKey;
      session.policyGeneration += 1;
      this.clearPolicyWork(session, true);
      if (!hasCredentials(snapshot)) {
        session.closedRequestKey = undefined;
        this.detachClock(session);
        session.connection = "BROKEN";
        session.error = Object.freeze({
          code: snapshot.status.baseKnown ? "NO_CREDENTIALS" : "SETTINGS",
          message: snapshot.status.baseKnown
            ? "KIS API 자격증명을 입력해 주세요."
            : "설정을 불러오지 못했습니다.",
        });
        this.submitView(session, "immediate");
      } else {
        session.error = undefined;
        this.attachClock(session);
        this.reconfigurePolicy(session);
      }
    }
  }

  private reconfigurePolicy(session: ActionSession<Settings>): void {
    if (!this.isCurrent(session)) return;
    const generation = ++session.policyGeneration;
    this.clearPolicyWork(session, false);
    session.snapshot = this.effectiveSnapshot(session.adapter.market, session.clock.snapshot());
    this.armPolicyTick(session, generation);
    if (session.preferences.dataMode === "automatic" && isRealtime(session.snapshot.session)) {
      session.hasValidWebSocketData = false;
      session.webSocketRevision += 1;
      session.subscriptionState = undefined;
      this.startAutomaticRealtime(session, generation);
      return;
    }

    this.releaseSubscription(session);
    if (session.preferences.dataMode === "rest-only" && isRealtime(session.snapshot.session)) {
      this.startRestOnlyRealtime(session, generation);
      return;
    }
    this.startClosedRest(session, generation);
  }

  private startAutomaticRealtime(session: ActionSession<Settings>, generation: number): void {
    session.connection = session.lastQuote ? session.connection : "waiting";
    session.stale = false;
    session.error = undefined;
    let descriptor: KisWebSocketDescriptor;
    let reusedSubscription = false;
    try {
      descriptor = session.adapter.webSocketDescriptor(session.instrument, this.safeNow());
      const existingBinding = session.subscriptionBinding;
      if (session.subscription && existingBinding && session.wsDescriptor) {
        reusedSubscription = true;
        existingBinding.policyGeneration = generation;
        if (
          !sameDescriptor(session.wsDescriptor, descriptor) &&
          !this.beginRetarget(session, generation, descriptor)
        ) return;
      } else {
        this.releaseSubscription(session);
        const binding: SubscriptionBinding = { policyGeneration: generation };
        session.subscriptionBinding = binding;
        session.wsDescriptor = descriptor;
        const observer: SubscriptionObserver = {
          onState: (value) => {
            if (session.subscriptionBinding !== binding) return;
            this.handleSubscriptionState(session, binding.policyGeneration, value);
          },
          onData: (event) => {
            if (session.subscriptionBinding !== binding) return;
            this.handleSubscriptionData(session, binding.policyGeneration, event);
          },
        };
        session.subscription = this.subscriptions.subscribe(descriptor, observer);
      }
    } catch (error) {
      this.releaseSubscription(session);
      session.connection = "BROKEN";
      session.error = safeError(error, "SUBSCRIPTION_REJECTED");
      this.submitView(session, "control");
      this.startFallback(session, generation, true);
      return;
    }
    if (reusedSubscription) {
      const physicalSnapshot = session.subscription?.snapshot;
      if (physicalSnapshot) {
        this.handleSubscriptionState(session, generation, physicalSnapshot);
      } else {
        this.submitView(session, "control");
      }
    } else {
      this.submitView(session, "control");
    }
    if (!session.fallbackActive) this.armGrace(session, generation);
  }

  private startRestOnlyRealtime(session: ActionSession<Settings>, generation: number): void {
    session.fallbackActive = true;
    void this.performRest(session, generation, "initial", false);
    this.armPoll(session, generation);
  }

  private startClosedRest(session: ActionSession<Settings>, generation: number): void {
    const credentialGeneration = this.settingsSnapshot?.settings.credentialGeneration ?? 0;
    const key = JSON.stringify([
      session.instrument.key,
      session.snapshot.sessionEpoch,
      credentialGeneration,
    ]);
    if (session.closedRequestKey === key) return;
    session.closedRequestKey = key;
    void this.performRest(session, generation, "initial", false);
  }

  private handleSubscriptionState(
    session: ActionSession<Settings>,
    generation: number,
    snapshot: SubscriptionSnapshot,
  ): void {
    if (!this.isPolicyCurrent(session, generation)) return;
    session.subscriptionState = snapshot.state;
    session.stale = snapshot.state === "stale";
    if (
      snapshot.state === "stale" ||
      snapshot.state === "parked" ||
      snapshot.state === "rejected" ||
      (session.hasValidWebSocketData &&
        (snapshot.state === "desired" || snapshot.state === "pending"))
    ) {
      this.submitView(session, "control");
      this.startFallback(session, generation, true);
      return;
    }
    this.submitView(session, "control");
  }

  private handleSubscriptionData(
    session: ActionSession<Settings>,
    generation: number,
    event: SubscriptionDataEvent,
  ): void {
    if (!this.isPolicyCurrent(session, generation)) return;
    let parsed: QuoteSample;
    try {
      const effective = this.effectiveSnapshot(session.adapter.market, session.clock.snapshot());
      parsed = session.adapter.parseWebSocket(event.fields, session.instrument, {
        receivedAt: event.receivedAt,
        sessionEpoch: effective.sessionEpoch,
      });
    } catch (error) {
      if (!session.lastQuote) {
        session.connection = "BROKEN";
        session.error = safeError(error, "PROTOCOL");
        this.submitView(session, "control");
      }
      this.startFallback(session, generation, true);
      return;
    }

    const recovering = session.connection === "BACKUP" || session.connection === "BROKEN";
    session.lastQuote = parsed;
    session.connection = "LIVE";
    session.error = undefined;
    session.stale = false;
    session.hasValidWebSocketData = true;
    session.webSocketRevision += 1;
    this.stopFallback(session);
    if (recovering) this.showRecovery(session, generation);
    else this.submitView(session, "normal");
  }

  private armGrace(session: ActionSession<Settings>, generation: number): void {
    this.clearHandle(session, "graceTimer");
    session.graceTimer = this.safeSetTimeout(() => {
      session.graceTimer = undefined;
      if (!this.isPolicyCurrent(session, generation) || session.hasValidWebSocketData) return;
      this.startFallback(session, generation, true);
    }, INITIAL_WS_GRACE_MS);
  }

  private startFallback(
    session: ActionSession<Settings>,
    generation: number,
    immediate: boolean,
  ): void {
    if (!this.isPolicyCurrent(session, generation)) return;
    this.clearHandle(session, "graceTimer");
    if (!session.fallbackActive) session.fallbackActive = true;
    if (immediate && !session.fallbackAbort) {
      void this.performRest(session, generation, "fallback", true);
    }
    this.armPoll(session, generation);
  }

  private stopFallback(session: ActionSession<Settings>): void {
    session.fallbackActive = false;
    this.clearHandle(session, "graceTimer");
    this.clearHandle(session, "pollTimer");
    const controller = session.fallbackAbort;
    session.fallbackAbort = undefined;
    try { controller?.abort(); } catch { /* best effort */ }
  }

  private armPoll(session: ActionSession<Settings>, generation: number): void {
    if (!this.isPolicyCurrent(session, generation) || session.pollTimer !== undefined) return;
    session.pollTimer = this.safeSetTimeout(() => {
      session.pollTimer = undefined;
      if (!this.isPolicyCurrent(session, generation) || !session.fallbackActive) return;
      if (!session.fallbackAbort) void this.performRest(session, generation, "fallback", true);
      this.armPoll(session, generation);
    }, session.preferences.backupPollIntervalMs);
  }

  private async performRest(
    session: ActionSession<Settings>,
    generation: number,
    priority: "initial" | "fallback",
    abortableFallback: boolean,
  ): Promise<void> {
    if (!this.isPolicyCurrent(session, generation)) return;
    const controller = new AbortController();
    session.policyAbortControllers.add(controller);
    if (abortableFallback) session.fallbackAbort = controller;
    const webSocketRevision = session.webSocketRevision;
    try {
      const result = await this.restCoordinator.requestQuote({
        adapter: session.adapter,
        instrument: session.instrument,
        marketSnapshot: session.snapshot,
        priority,
        signal: controller.signal,
      });
      if (
        !this.isPolicyCurrent(session, generation) ||
        session.webSocketRevision !== webSocketRevision
      ) return;
      session.lastQuote = result;
      session.connection = "BACKUP";
      session.error = undefined;
      session.stale = false;
      this.submitView(session, "normal");
    } catch (error) {
      if (!this.isPolicyCurrent(session, generation) || controller.signal.aborted) return;
      if (!session.lastQuote) {
        session.connection = "BROKEN";
        session.error = safeError(error, "NETWORK");
        this.submitView(session, "control");
      }
    } finally {
      if (session.fallbackAbort === controller) session.fallbackAbort = undefined;
      session.policyAbortControllers.delete(controller);
    }
  }

  private async performManual(session: ActionSession<Settings>): Promise<void> {
    const generation = session.policyGeneration;
    const webSocketRevision = session.webSocketRevision;
    const controller = new AbortController();
    session.manualAbort = controller;
    this.submitView(session, "immediate", { refreshing: true });
    try {
      const result = await this.restCoordinator.requestQuote({
        adapter: session.adapter,
        instrument: session.instrument,
        marketSnapshot: session.snapshot,
        priority: "manual",
        signal: controller.signal,
      });
      if (
        !this.isPolicyCurrent(session, generation) ||
        session.webSocketRevision !== webSocketRevision
      ) return;
      session.lastQuote = result;
      session.connection = "BACKUP";
      session.error = undefined;
      this.submitView(session, "immediate");
    } catch (error) {
      if (!this.isPolicyCurrent(session, generation) || controller.signal.aborted) return;
      if (!session.lastQuote) {
        session.connection = "BROKEN";
        session.error = safeError(error, "NETWORK");
      }
      this.submitView(session, "immediate");
    } finally {
      if (session.manualAbort === controller) session.manualAbort = undefined;
    }
  }

  private showRecovery(session: ActionSession<Settings>, generation: number): void {
    this.clearHandle(session, "recoveryTimer");
    this.submitView(session, "control", { recovery: true });
    const timer = this.safeSetTimeout(() => {
      session.recoveryTimer = undefined;
      if (this.isPolicyCurrent(session, generation)) this.submitView(session, "normal");
    }, RECOVERY_DISPLAY_MS);
    session.recoveryTimer = timer;
    if (timer === undefined && this.isPolicyCurrent(session, generation)) {
      this.submitView(session, "normal");
    }
  }

  private armPolicyTick(session: ActionSession<Settings>, generation: number): void {
    this.clearHandle(session, "policyTimer");
    session.policyTimer = this.safeSetTimeout(() => {
      session.policyTimer = undefined;
      if (!this.isPolicyCurrent(session, generation)) return;
      this.handlePolicyTick(session, generation);
    }, POLICY_TICK_MS);
  }

  private handlePolicyTick(session: ActionSession<Settings>, generation: number): void {
    if (!this.isPolicyCurrent(session, generation)) return;
    const effective = this.effectiveSnapshot(session.adapter.market, session.clock.snapshot());
    const realtimeChanged = isRealtime(effective.session) !== isRealtime(session.snapshot.session) ||
      effective.sessionEpoch !== session.snapshot.sessionEpoch;
    session.snapshot = effective;
    if (realtimeChanged) {
      this.reconfigurePolicy(session);
      return;
    }

    if (session.subscription && session.wsDescriptor && !session.retargetPromise) {
      const next = session.adapter.webSocketDescriptor(session.instrument, this.safeNow());
      if (!sameDescriptor(session.wsDescriptor, next)) {
        this.beginRetarget(session, generation, next);
      }
    }
    this.armPolicyTick(session, generation);
  }

  private beginRetarget(
    session: ActionSession<Settings>,
    generation: number,
    next: KisWebSocketDescriptor,
  ): boolean {
    if (session.retargetPromise) return true;
    const old = session.wsDescriptor;
    const binding = session.subscriptionBinding;
    if (!old || !binding || !session.subscription) return false;
    let operation: Promise<void>;
    try {
      operation = Promise.resolve(this.subscriptions.retargetAll(old, next));
    } catch (error) {
      this.handleRetargetFailure(session, generation, error);
      return false;
    }
    session.retargetPromise = operation;
    void operation.then(
      () => {
        if (session.retargetPromise === operation) session.retargetPromise = undefined;
        if (this.isCurrent(session) && session.subscriptionBinding === binding) {
          session.wsDescriptor = next;
        }
      },
      (error) => {
        if (session.retargetPromise === operation) session.retargetPromise = undefined;
        this.handleRetargetFailure(session, generation, error);
      },
    );
    return true;
  }

  private handleRetargetFailure(
    session: ActionSession<Settings>,
    generation: number,
    error: unknown,
  ): void {
    if (!this.isPolicyCurrent(session, generation)) return;
    if (!session.lastQuote) {
      session.connection = "BROKEN";
      session.error = safeError(error, "SUBSCRIPTION_REJECTED");
      this.submitView(session, "control");
    }
    this.startFallback(session, generation, true);
  }

  private effectiveSnapshot(market: Market, source: MarketSnapshot): MarketSnapshot {
    if (market !== "overseas" || !isOverseasDayTradingAt(this.safeNow())) return source;
    if (source.session !== "CLOSED") return source;
    const now = this.safeNow();
    const sessionEpoch = this.overseasDaySessionEpoch(now);
    return Object.freeze({
      market: "overseas",
      session: "REG",
      sessionEpoch,
      nextTransitionAt: Math.max(sessionEpoch + 1, this.overseasDaySessionEnd(now)),
    });
  }

  private overseasDaySessionEpoch(now: number): number {
    const parts = this.kstParts(now);
    return Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0);
  }

  private overseasDaySessionEnd(now: number): number {
    return this.overseasDaySessionEpoch(now) + (6 * 60 + 30) * 60_000;
  }

  private kstParts(now: number): { year: number; month: number; day: number } {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const values: Record<string, string> = {};
    for (const part of formatter.formatToParts(new Date(now))) {
      if (part.type !== "literal") values[part.type] = part.value;
    }
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
  }

  private submitView(
    session: ActionSession<Settings>,
    category: RenderCategory,
    overrides: { refreshing?: boolean; recovery?: boolean } = {},
  ): void {
    if (!this.isCurrent(session)) return;
    const capturedPolicyGeneration = session.policyGeneration;
    const view: StockActionView = Object.freeze({
      actionId: session.actionId,
      instrument: Object.freeze({
        symbol: session.instrument.symbol,
        name: session.instrument.displayName,
        market: session.instrument.market,
      }),
      session: session.snapshot.session,
      ...(session.lastQuote ? { quote: freezeQuote(session.lastQuote) } : {}),
      connection: session.connection,
      stale: session.stale,
      refreshing: overrides.refreshing ?? false,
      recovery: overrides.recovery ?? false,
      ...(session.error ? { error: session.error } : {}),
    });
    this.renderScheduler.submit(session.actionId, session.renderGeneration, {
      category,
      semanticKey: semanticKey(view),
      render: () => this.renderer(view),
      commit: async (image) => {
        if (!this.isCurrent(session) || session.policyGeneration !== capturedPolicyGeneration) return;
        await session.input.actionPort.setImage(image);
      },
    });
  }

  private clearPolicyWork(session: ActionSession<Settings>, releaseSubscription: boolean): void {
    this.clearHandle(session, "graceTimer");
    this.clearHandle(session, "pollTimer");
    this.clearHandle(session, "policyTimer");
    this.clearHandle(session, "recoveryTimer");
    session.fallbackActive = false;
    session.fallbackAbort = undefined;
    for (const controller of [...session.policyAbortControllers]) {
      try { controller.abort(); } catch { /* best effort */ }
    }
    session.policyAbortControllers.clear();
    const manual = session.manualAbort;
    session.manualAbort = undefined;
    try { manual?.abort(); } catch { /* best effort */ }
    if (releaseSubscription) this.releaseSubscription(session);
  }

  private releaseSubscription(session: ActionSession<Settings>): void {
    const handle = session.subscription;
    session.subscription = undefined;
    session.subscriptionBinding = undefined;
    session.retargetPromise = undefined;
    session.wsDescriptor = undefined;
    session.subscriptionState = undefined;
    try { handle?.release(); } catch { /* best effort */ }
  }

  private teardownSession(actionId: string): void {
    const session = this.sessions.get(actionId);
    if (!session) {
      const fatalGeneration = this.fatalRenderGenerations.get(actionId);
      if (fatalGeneration !== undefined) {
        this.fatalRenderGenerations.delete(actionId);
        this.renderScheduler.remove(actionId, fatalGeneration);
      }
      return;
    }
    this.sessions.delete(actionId);
    session.destroyed = true;
    session.policyGeneration += 1;
    this.clearPolicyWork(session, true);
    try { session.unsubscribeClock?.(); } catch { /* best effort */ }
    session.unsubscribeClock = undefined;
    this.renderScheduler.remove(actionId, session.renderGeneration);
  }

  private attachClock(session: ActionSession<Settings>): void {
    if (session.unsubscribeClock || !this.isCurrent(session)) return;
    try { session.clock.start(); } catch { /* snapshot remains usable */ }
    let subscribing = true;
    try {
      const unsubscribe = session.clock.subscribe((marketSnapshot) => {
        if (!this.isCurrent(session)) return;
        const unchanged = sameMarketSnapshot(session.snapshot, marketSnapshot);
        session.snapshot = marketSnapshot;
        if (subscribing || unchanged) return;
        const global = this.settingsSnapshot;
        if (!global || !hasCredentials(global)) return;
        this.reconfigurePolicy(session);
      });
      session.unsubscribeClock = unsubscribe;
    } catch {
      session.unsubscribeClock = undefined;
    } finally {
      subscribing = false;
    }
  }

  private detachClock(session: ActionSession<Settings>): void {
    const unsubscribe = session.unsubscribeClock;
    session.unsubscribeClock = undefined;
    try { unsubscribe?.(); } catch { /* best effort */ }
  }

  private isCurrent(session: ActionSession<Settings>): boolean {
    return !this.destroyed && !session.destroyed &&
      this.sessions.get(session.actionId) === session &&
      this.records.get(session.actionId)?.epoch === session.lifecycleEpoch;
  }

  private isPolicyCurrent(session: ActionSession<Settings>, generation: number): boolean {
    return this.isCurrent(session) && session.policyGeneration === generation;
  }

  private clearHandle<Key extends "graceTimer" | "pollTimer" | "policyTimer" | "recoveryTimer">(
    session: ActionSession<Settings>,
    key: Key,
  ): void {
    const handle = session[key];
    session[key] = undefined;
    if (handle === undefined) return;
    try { this.clearTimer(handle); } catch { /* best effort */ }
  }

  private safeSetTimeout(callback: () => void, delayMs: number): TimerHandle | undefined {
    try {
      return this.setTimer(() => {
        try { callback(); } catch { /* timer boundary isolation */ }
      }, delayMs);
    } catch {
      return undefined;
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
}
