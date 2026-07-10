import { KisError } from "../core/errors.js";
import { actionSettingsEqual } from "../settings/schema.js";
import type {
  StockActionAppearInput,
  StockActionPort,
} from "./stock-action-controller.js";

const MAX_INTERNAL_WRITE_MARKERS = 8;

export interface StockActionControllerPort<Settings> {
  appear(input: StockActionAppearInput<Settings>): Promise<void>;
  updateSettings(actionId: string, settings: Settings): Promise<void>;
  disappear(actionId: string): Promise<void>;
  manualRefresh(actionId: string): Promise<void>;
}

export interface ActionWrapperDiagnosticsPort {
  record(error: KisError): void;
}

export const noopActionWrapperDiagnostics: ActionWrapperDiagnosticsPort = Object.freeze({
  record: () => undefined,
});

export interface ActionSettingsPort<Settings> {
  setSettings(settings: Settings): Promise<void>;
}

export interface ActionImagePort {
  setImage(image?: string): Promise<void>;
}

interface InternalWrite<Settings> {
  readonly settings: Settings;
}

interface WrapperState<Settings> {
  epoch: number;
  active: boolean;
  persistenceTail: Promise<void>;
  readonly internalWrites: InternalWrite<Settings>[];
}

/** Orders SDK lifecycle events without owning market or rendering policy. */
export class StockActionWrapperRuntime<Settings> {
  private readonly states = new Map<string, WrapperState<Settings>>();
  private readonly recordedErrors = new WeakSet<object>();
  private nextEpoch = 0;

  constructor(
    private readonly controller: StockActionControllerPort<Settings>,
    private readonly migrate: (settings: unknown) => Settings,
    private readonly diagnostics: ActionWrapperDiagnosticsPort,
  ) {}

  async appear(
    actionId: string,
    rawSettings: unknown,
    settingsPort: ActionSettingsPort<Settings>,
    imagePort: ActionImagePort,
  ): Promise<void> {
    const { state, epoch } = this.advance(actionId, true);
    const settings = this.safeMigrate(rawSettings);
    if (!settings) return;

    await this.invoke(() => this.controller.appear({
      actionId,
      settings,
      actionPort: this.actionPort(imagePort),
    }));
    if (!this.isCurrent(actionId, state, epoch, true)) return;
    this.schedulePersistence(actionId, state, epoch, rawSettings, settings, settingsPort);
  }

  async settingsChanged(
    actionId: string,
    rawSettings: unknown,
    settingsPort: ActionSettingsPort<Settings>,
  ): Promise<void> {
    const existing = this.states.get(actionId);
    if (existing && this.consumeInternalWrite(existing, rawSettings)) return;
    if (existing && !existing.active) return;

    const { state, epoch } = this.advance(actionId, true);
    const settings = this.safeMigrate(rawSettings);
    if (!settings) return;

    await this.invoke(() => this.controller.updateSettings(actionId, settings));
    if (!this.isCurrent(actionId, state, epoch, true)) return;
    this.schedulePersistence(actionId, state, epoch, rawSettings, settings, settingsPort);
  }

  async disappear(actionId: string): Promise<void> {
    this.advance(actionId, false);
    await this.invoke(() => this.controller.disappear(actionId));
  }

  async manualRefresh(actionId: string): Promise<void> {
    await this.invoke(() => this.controller.manualRefresh(actionId));
  }

  private advance(
    actionId: string,
    active: boolean,
  ): { state: WrapperState<Settings>; epoch: number } {
    let state = this.states.get(actionId);
    if (!state) {
      state = {
        epoch: 0,
        active,
        persistenceTail: Promise.resolve(),
        internalWrites: [],
      };
      this.states.set(actionId, state);
    }
    const epoch = ++this.nextEpoch;
    state.epoch = epoch;
    state.active = active;
    return { state, epoch };
  }

  private isCurrent(
    actionId: string,
    state: WrapperState<Settings>,
    epoch: number,
    active: boolean,
  ): boolean {
    return this.states.get(actionId) === state &&
      state.epoch === epoch &&
      state.active === active;
  }

  private safeMigrate(rawSettings: unknown): Settings | undefined {
    try {
      return this.migrate(rawSettings);
    } catch (error) {
      this.record(error);
      return undefined;
    }
  }

  private schedulePersistence(
    actionId: string,
    state: WrapperState<Settings>,
    epoch: number,
    rawSettings: unknown,
    settings: Settings,
    port: ActionSettingsPort<Settings>,
  ): void {
    if (actionSettingsEqual(rawSettings, settings)) return;
    const operation = state.persistenceTail.then(async () => {
      if (!this.isCurrent(actionId, state, epoch, true)) return;
      const marker: InternalWrite<Settings> = { settings };
      state.internalWrites.push(marker);
      if (state.internalWrites.length > MAX_INTERNAL_WRITE_MARKERS) {
        state.internalWrites.splice(
          0,
          state.internalWrites.length - MAX_INTERNAL_WRITE_MARKERS,
        );
      }
      try {
        await port.setSettings(settings);
      } catch (error) {
        this.removeInternalWrite(state, marker);
        this.record(error);
      }
    });
    state.persistenceTail = operation.catch((error: unknown) => {
      this.record(error);
    });
  }

  private consumeInternalWrite(state: WrapperState<Settings>, settings: unknown): boolean {
    const index = state.internalWrites.findIndex((entry) =>
      actionSettingsEqual(entry.settings, settings),
    );
    if (index < 0) return false;
    state.internalWrites.splice(index, 1);
    return true;
  }

  private removeInternalWrite(
    state: WrapperState<Settings>,
    marker: InternalWrite<Settings>,
  ): void {
    const index = state.internalWrites.indexOf(marker);
    if (index >= 0) state.internalWrites.splice(index, 1);
  }

  private actionPort(action: ActionImagePort): StockActionPort {
    return Object.freeze({
      setImage: async (image: string) => {
        try {
          await action.setImage(image);
        } catch (error) {
          throw this.record(error);
        }
      },
    });
  }

  private async invoke(operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.record(error);
    }
  }

  private record(error: unknown): KisError {
    const safe = error instanceof KisError
      ? error
      : Object.freeze(new KisError({
          code: "SETTINGS",
          scope: "action",
          retryable: true,
          safeMessage: "액션 이벤트를 안전하게 처리하지 못했습니다.",
        }));
    if (typeof error === "object" && error !== null && this.recordedErrors.has(error)) {
      return safe;
    }
    if (typeof error === "object" && error !== null) this.recordedErrors.add(error);
    this.recordedErrors.add(safe);
    try { this.diagnostics.record(safe); } catch { /* diagnostics are observational */ }
    return safe;
  }
}
