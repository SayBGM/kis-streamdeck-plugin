import { StockActionController } from "../actions/stock-action-controller.js";
import { DiagnosticsStore } from "../core/diagnostics-store.js";
import { MarketClock } from "../core/market-clock.js";
import { ConnectionSupervisor } from "../kis/connection-supervisor.js";
import {
  CredentialSession,
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
  readonly piSender?: PiOutboundPort;
}

/** Owns the shared plugin services and their deterministic startup/shutdown order. */
export class PluginRuntime {
  private initialization?: Promise<void>;
  private destruction?: Promise<void>;
  private destroyed = false;

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

  private async destroyOnce(): Promise<void> {
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
