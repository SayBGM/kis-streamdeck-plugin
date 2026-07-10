import { StockActionController } from "../actions/stock-action-controller.js";
import { DiagnosticsStore } from "../core/diagnostics-store.js";
import { MarketClock } from "../core/market-clock.js";
import {
  ConnectionSupervisor,
  type ConnectionSupervisorOptions,
} from "../kis/connection-supervisor.js";
import {
  CredentialSession,
  fingerprintCredentials,
  type CredentialSessionOptions,
} from "../kis/credential-session.js";
import { RestCoordinator } from "../kis/rest-coordinator.js";
import { SubscriptionSupervisor } from "../kis/subscription-supervisor.js";
import {
  getDomesticMarketAdapter,
  overseasStockAdapter,
} from "../markets/market-adapter.js";
import { RenderScheduler } from "../renderer/render-scheduler.js";
import { renderStockActionViewDataUri } from "../renderer/stock-card.js";
import {
  PiController,
  type PiOutboundPort,
} from "../pi/pi-controller.js";
import {
  migrateDomesticStockSettings,
  migrateOverseasStockSettings,
  type DomesticStockSettingsV2,
  type OverseasStockSettingsV2,
} from "../settings/schema.js";
import {
  SettingsRepository,
  type SettingsPersistence,
  type SettingsSnapshot,
} from "../settings/settings-repository.js";
import type { Market } from "../types/index.js";

export interface PluginRuntimeServices {
  readonly settingsRepository: SettingsRepository;
  readonly credentialSession: CredentialSession;
  readonly connectionSupervisor: ConnectionSupervisor;
  readonly subscriptionSupervisor: SubscriptionSupervisor;
  readonly restCoordinator: RestCoordinator;
  readonly renderScheduler: RenderScheduler;
  readonly clocks: Readonly<Record<Market, MarketClock>>;
  readonly domesticController: StockActionController<DomesticStockSettingsV2>;
  readonly overseasController: StockActionController<OverseasStockSettingsV2>;
  readonly diagnostics: DiagnosticsStore;
  readonly piController: PiController;
}

export interface CreatePluginRuntimeOptions {
  readonly settingsPersistence: SettingsPersistence;
  readonly diagnostics?: DiagnosticsStore;
  readonly credentialSessionOptions?: CredentialSessionOptions;
  readonly connectionSupervisorOptions?: Omit<
    ConnectionSupervisorOptions,
    "credentials" | "diagnostics"
  >;
  readonly piSender?: PiOutboundPort;
}

interface RuntimeCredentialIdentity {
  readonly configured: boolean;
  readonly credentialGeneration: number;
  readonly tuple: string;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Owns the shared plugin services and their deterministic startup/shutdown order. */
export class PluginRuntime {
  private initialization?: Promise<void>;
  private destruction?: Promise<void>;
  private destroyed = false;
  private unsubscribeCredentialIdentity?: () => void;
  private credentialIdentityTuple?: string;
  private credentialIdentityEpoch = 0;

  constructor(readonly services: PluginRuntimeServices) {}

  get domesticController(): StockActionController<DomesticStockSettingsV2> {
    return this.services.domesticController;
  }

  get overseasController(): StockActionController<OverseasStockSettingsV2> {
    return this.services.overseasController;
  }

  get diagnostics(): DiagnosticsStore {
    return this.services.diagnostics;
  }

  get piController(): PiController {
    return this.services.piController;
  }

  initialize(): Promise<void> {
    this.observeCredentialIdentity();
    if (!this.initialization) {
      const operation = this.initializeOnce();
      const retryable = operation.catch((error: unknown) => {
        if (this.initialization === retryable) this.initialization = undefined;
        throw error;
      });
      this.initialization = retryable;
    }
    return this.initialization;
  }

  /**
   * Global-settings events never apply their payload directly. A no-op repository
   * transaction performs the serialized fresh read and only persists migration.
   */
  async refreshGlobalSettings(): Promise<void> {
    if (this.destroyed) return;
    this.observeCredentialIdentity();
    await this.services.settingsRepository.update(() => undefined);
    if (this.destroyed) return;
    await this.services.credentialSession.reconcile();
  }

  destroy(): Promise<void> {
    if (!this.destruction) {
      this.destroyed = true;
      this.destruction = this.destroyOnce();
    }
    return this.destruction;
  }

  private async initializeOnce(): Promise<void> {
    await this.services.settingsRepository.initialize();
    if (this.destroyed) return;
    await this.services.credentialSession.initialize();
  }

  private observeCredentialIdentity(): void {
    if (this.destroyed || this.unsubscribeCredentialIdentity) return;
    this.unsubscribeCredentialIdentity = this.services.settingsRepository.subscribe((snapshot) => {
      if (this.destroyed) return;
      this.applyCredentialSnapshot(snapshot);
    });
  }

  private applyCredentialSnapshot(snapshot: SettingsSnapshot): void {
    const identity = this.identityFromSnapshot(snapshot);
    if (identity.tuple === this.credentialIdentityTuple) return;
    this.credentialIdentityTuple = identity.tuple;
    this.credentialIdentityEpoch += 1;
    this.services.connectionSupervisor.applyCredentialIdentity({
      configured: identity.configured,
      credentialGeneration: identity.credentialGeneration,
      identityEpoch: this.credentialIdentityEpoch,
    });
  }

  private identityFromSnapshot(snapshot: SettingsSnapshot): RuntimeCredentialIdentity {
    let credentialGeneration = 0;
    let configured = false;
    let fingerprint = "invalid";
    let baseKnown = false;
    let persistenceDegraded = false;
    try {
      const settings = ownDataProperty(snapshot, "settings");
      const status = ownDataProperty(snapshot, "status");
      const generation = ownDataProperty(settings, "credentialGeneration");
      credentialGeneration = Number.isSafeInteger(generation) && (generation as number) >= 0
        ? generation as number
        : 0;
      baseKnown = ownDataProperty(status, "baseKnown") === true;
      persistenceDegraded = ownDataProperty(status, "persistenceDegraded") === true;
      const rawAppKey = ownDataProperty(settings, "appKey");
      const rawAppSecret = ownDataProperty(settings, "appSecret");
      const appKey = typeof rawAppKey === "string" ? rawAppKey.trim() : "";
      const appSecret = typeof rawAppSecret === "string" ? rawAppSecret.trim() : "";
      fingerprint = "none";
      if (appKey.length > 0 && appSecret.length > 0) {
        fingerprint = fingerprintCredentials(appKey, appSecret);
      }
      configured = baseKnown &&
        !persistenceDegraded &&
        appKey.length > 0 &&
        appSecret.length > 0 &&
        ownDataProperty(settings, "credentialFingerprint") === fingerprint;
    } catch {
      configured = false;
      fingerprint = "invalid";
      credentialGeneration = 0;
      baseKnown = false;
      persistenceDegraded = true;
    }
    const tuple = [
      baseKnown ? "ready" : "unknown",
      persistenceDegraded ? "degraded" : "healthy",
      configured ? "configured" : "unconfigured",
      String(credentialGeneration),
      fingerprint,
    ].join(":");
    return Object.freeze({ configured, credentialGeneration, tuple });
  }

  private async destroyOnce(): Promise<void> {
    const unsubscribeCredentialIdentity = this.unsubscribeCredentialIdentity;
    this.unsubscribeCredentialIdentity = undefined;
    try { unsubscribeCredentialIdentity?.(); } catch { /* best-effort shutdown */ }
    const cleanup = [
      () => this.services.piController.destroy(),
      () => this.services.subscriptionSupervisor.destroy(),
      () => this.services.connectionSupervisor.destroy(),
      () => this.services.renderScheduler.destroy(),
      ...[...new Set(Object.values(this.services.clocks))].map(
        (clock) => () => clock.stop(),
      ),
    ];
    for (const operation of cleanup) {
      try { operation(); } catch { /* best-effort shutdown */ }
    }
    await Promise.allSettled([
      Promise.resolve().then(() => this.services.domesticController.destroy()),
      Promise.resolve().then(() => this.services.overseasController.destroy()),
    ]);
  }
}

export function createPluginRuntime(options: CreatePluginRuntimeOptions): PluginRuntime {
  const diagnostics = options.diagnostics ?? new DiagnosticsStore();
  const settingsRepository = new SettingsRepository(options.settingsPersistence);
  const credentialSession = new CredentialSession(
    settingsRepository,
    { ...options.credentialSessionOptions, diagnostics },
  );
  const connectionSupervisor = new ConnectionSupervisor({
    ...options.connectionSupervisorOptions,
    credentials: credentialSession,
    diagnostics,
  });
  const subscriptionSupervisor = new SubscriptionSupervisor({
    connection: connectionSupervisor,
    diagnostics,
  });
  const restCoordinator = new RestCoordinator(credentialSession, { diagnostics });
  const renderScheduler = new RenderScheduler();
  const clocks = Object.freeze({
    domestic: new MarketClock("domestic"),
    overseas: new MarketClock("overseas"),
  });

  const domesticController = new StockActionController<DomesticStockSettingsV2>({
    settingsRepository,
    clocks,
    subscriptions: subscriptionSupervisor,
    restCoordinator,
    renderScheduler,
    adapterResolver: (settings) => getDomesticMarketAdapter(settings.instrumentType),
    migrateSettings: migrateDomesticStockSettings,
    renderer: renderStockActionViewDataUri,
    fallbackMarket: "domestic",
  });
  const overseasController = new StockActionController<OverseasStockSettingsV2>({
    settingsRepository,
    clocks,
    subscriptions: subscriptionSupervisor,
    restCoordinator,
    renderScheduler,
    adapterResolver: () => overseasStockAdapter,
    migrateSettings: migrateOverseasStockSettings,
    renderer: renderStockActionViewDataUri,
    fallbackMarket: "overseas",
  });
  const piController = new PiController({
    settingsRepository,
    credentialSession,
    connection: connectionSupervisor,
    subscriptions: subscriptionSupervisor,
    rest: restCoordinator,
    render: renderScheduler,
    diagnostics,
    manualRefresh: (market, actionId) => market === "domestic"
      ? domesticController.manualRefresh(actionId)
      : overseasController.manualRefresh(actionId),
    sender: options.piSender ?? { send: async () => undefined },
  });

  return new PluginRuntime(Object.freeze({
    settingsRepository,
    credentialSession,
    connectionSupervisor,
    subscriptionSupervisor,
    restCoordinator,
    renderScheduler,
    clocks,
    domesticController,
    overseasController,
    diagnostics,
    piController,
  }));
}
