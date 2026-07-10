import { KisError } from "../core/errors.js";
import type { GlobalSettings } from "../types/index.js";
import {
  globalSettingsEqual,
  migrateGlobalSettings,
  type GlobalSettingsV2,
} from "./schema.js";

const DEFAULT_RETRY_DELAYS = [1_000, 2_000, 4_000] as const;

export interface SettingsPersistence {
  getGlobalSettings(): Promise<GlobalSettings>;
  setGlobalSettings(settings: GlobalSettingsV2): Promise<void>;
}

export interface SettingsRepositoryStatus {
  readonly baseKnown: boolean;
  readonly persistenceDegraded: boolean;
  readonly error?: KisError;
}

export interface SettingsSnapshot {
  readonly settings: Readonly<GlobalSettingsV2>;
  readonly status: SettingsRepositoryStatus;
}

/**
 * The updater receives an isolated mutable draft. Remove fields with `delete`;
 * assigning `undefined` is not a deletion. The return value is intentionally ignored.
 */
export type SettingsUpdater = (draft: GlobalSettingsV2) => void;
export type SettingsListener = (snapshot: SettingsSnapshot) => void;

export interface SettingsRepositoryOptions {
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly retryDelays?: readonly number[];
}

interface NormalizedRead {
  readonly settings: GlobalSettingsV2;
  readonly migrationRequired: boolean;
}

type AttemptResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function cloneSettings(settings: GlobalSettingsV2): GlobalSettingsV2 {
  return migrateGlobalSettings(settings);
}

function freezeStatus(status: SettingsRepositoryStatus): SettingsRepositoryStatus {
  return Object.freeze({
    baseKnown: status.baseKnown,
    persistenceDegraded: status.persistenceDegraded,
    ...(status.error ? { error: status.error } : {}),
  });
}

function settingsPersistenceError(
  safeMessage: string,
  status: Pick<SettingsRepositoryStatus, "baseKnown" | "persistenceDegraded">,
): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: true,
    safeMessage,
    metadata: status,
  }));
}

function nextRevisionError(): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: false,
    safeMessage: "설정 리비전을 더 이상 증가시킬 수 없습니다.",
  }));
}

export class SettingsRepository {
  private readonly persistence: SettingsPersistence;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly retryDelays: readonly number[];
  private settings: GlobalSettingsV2 = deepFreeze(migrateGlobalSettings({}));
  private status: SettingsRepositoryStatus = freezeStatus({
    baseKnown: false,
    persistenceDegraded: false,
  });
  private readonly listeners = new Set<SettingsListener>();
  private initialization?: Promise<SettingsSnapshot>;
  private updateTail: Promise<void> = Promise.resolve();

  constructor(
    persistence: SettingsPersistence,
    options: SettingsRepositoryOptions = {},
  ) {
    this.persistence = persistence;
    this.sleep = options.sleep ?? defaultSleep;
    this.retryDelays = [...(options.retryDelays ?? DEFAULT_RETRY_DELAYS)];
  }

  initialize(): Promise<SettingsSnapshot> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce();
    }
    return this.initialization;
  }

  whenReady(): Promise<SettingsSnapshot> {
    return this.initialize();
  }

  getSnapshot(): SettingsSnapshot {
    const snapshot: SettingsSnapshot = {
      settings: deepFreeze(cloneSettings(this.settings)),
      status: freezeStatus(this.status),
    };
    return Object.freeze(snapshot);
  }

  getStatus(): SettingsRepositoryStatus {
    return freezeStatus(this.status);
  }

  /**
   * Subscriptions immediately receive the current snapshot once. Listener failures
   * are isolated from the repository and from other listeners.
   */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    this.callListener(listener, this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  update(updater: SettingsUpdater): Promise<SettingsSnapshot> {
    const operation = this.updateTail.then(async () => {
      await this.whenReady();
      return this.applyUpdate(updater);
    });
    this.updateTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async initializeOnce(): Promise<SettingsSnapshot> {
    const read = await this.readWithRetry();
    if (!read.ok) {
      const error = settingsPersistenceError("설정을 불러오지 못했습니다.", {
        baseKnown: false,
        persistenceDegraded: true,
      });
      this.replaceState(this.settings, {
        baseKnown: false,
        persistenceDegraded: true,
        error,
      });
      this.emit();
      return this.getSnapshot();
    }

    this.replaceState(read.value.settings, {
      baseKnown: true,
      persistenceDegraded: false,
    });
    this.emit();

    if (!read.value.migrationRequired) {
      return this.getSnapshot();
    }

    const persisted = await this.writeWithRetry(read.value.settings);
    if (!persisted.ok) {
      const error = settingsPersistenceError("마이그레이션한 설정을 저장하지 못했습니다.", {
        baseKnown: true,
        persistenceDegraded: true,
      });
      this.replaceState(this.settings, {
        baseKnown: true,
        persistenceDegraded: true,
        error,
      });
      this.emit();
    }

    return this.getSnapshot();
  }

  private async applyUpdate(updater: SettingsUpdater): Promise<SettingsSnapshot> {
    let base = this.settings;
    let refreshed = false;
    if (!this.status.baseKnown || this.status.persistenceDegraded) {
      const read = await this.readWithRetry();
      if (!read.ok) {
        const error = settingsPersistenceError("최신 설정을 불러오지 못했습니다.", {
          baseKnown: false,
          persistenceDegraded: true,
        });
        this.replaceState(this.settings, {
          baseKnown: false,
          persistenceDegraded: true,
          error,
        });
        throw error;
      }
      base = read.value.settings;
      refreshed = true;
    }

    const draft = cloneSettings(base);
    updater(draft);
    const candidate = migrateGlobalSettings(draft);
    candidate.settingsRevision = base.settingsRevision;

    if (globalSettingsEqual(candidate, base)) {
      if (refreshed) {
        this.replaceState(base, {
          baseKnown: true,
          persistenceDegraded: false,
        });
      }
      return this.getSnapshot();
    }

    if (base.settingsRevision >= Number.MAX_SAFE_INTEGER) {
      throw nextRevisionError();
    }
    candidate.settingsRevision = base.settingsRevision + 1;

    const persisted = await this.writeWithRetry(candidate);
    if (!persisted.ok) {
      const error = settingsPersistenceError("설정을 저장하지 못했습니다.", {
        baseKnown: this.status.baseKnown,
        persistenceDegraded: true,
      });
      this.replaceState(this.settings, {
        baseKnown: this.status.baseKnown,
        persistenceDegraded: true,
        error,
      });
      throw error;
    }

    this.replaceState(candidate, {
      baseKnown: true,
      persistenceDegraded: false,
    });
    this.emit();
    return this.getSnapshot();
  }

  private async readWithRetry(): Promise<AttemptResult<NormalizedRead>> {
    return this.attempt(async () => {
      const raw = await this.persistence.getGlobalSettings();
      const settings = migrateGlobalSettings(raw);
      return {
        settings,
        migrationRequired: !globalSettingsEqual(raw, settings),
      };
    });
  }

  private writeWithRetry(settings: GlobalSettingsV2): Promise<AttemptResult<void>> {
    return this.attempt(() => this.persistence.setGlobalSettings(cloneSettings(settings)));
  }

  private async attempt<T>(operation: () => Promise<T>): Promise<AttemptResult<T>> {
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt += 1) {
      try {
        return { ok: true, value: await operation() };
      } catch {
        if (attempt === this.retryDelays.length) {
          return { ok: false };
        }
        try {
          await this.sleep(this.retryDelays[attempt]);
        } catch {
          // A failed delay must not leave readiness pending or skip the next attempt.
        }
      }
    }
    return { ok: false };
  }

  private replaceState(
    settings: GlobalSettingsV2,
    status: SettingsRepositoryStatus,
  ): void {
    this.settings = deepFreeze(cloneSettings(settings));
    this.status = freezeStatus(status);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      this.callListener(listener, snapshot);
    }
  }

  private callListener(listener: SettingsListener, snapshot: SettingsSnapshot): void {
    try {
      listener(snapshot);
    } catch {
      // Listener ownership stays outside the persistence boundary.
    }
  }
}
