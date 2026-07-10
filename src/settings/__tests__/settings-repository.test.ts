import { describe, expect, it, vi } from "vitest";
import { KisError } from "../../core/errors.js";
import type { GlobalSettings } from "../../types/index.js";
import { migrateGlobalSettings, type GlobalSettingsV2 } from "../schema.js";
import {
  SettingsRepository,
  type SettingsPersistence,
} from "../settings-repository.js";

function v2(overrides: Partial<GlobalSettingsV2> = {}): GlobalSettingsV2 {
  return migrateGlobalSettings({
    schemaVersion: 2,
    settingsRevision: 0,
    credentialGeneration: 0,
    accessTokenVersion: 0,
    preferences: {
      dataMode: "automatic",
      renderIntervalMs: 2_000,
      backupPollIntervalMs: 30_000,
    },
    ...overrides,
  });
}

function makePersistence(
  getGlobalSettings: () => Promise<GlobalSettings>,
  setGlobalSettings: (settings: GlobalSettingsV2) => Promise<void> = async () => {},
): SettingsPersistence & {
  getGlobalSettings: ReturnType<typeof vi.fn<() => Promise<GlobalSettings>>>;
  setGlobalSettings: ReturnType<
    typeof vi.fn<(settings: GlobalSettingsV2) => Promise<void>>
  >;
} {
  return {
    getGlobalSettings: vi.fn(getGlobalSettings),
    setGlobalSettings: vi.fn(setGlobalSettings),
  };
}

function expectSettingsError(error: unknown): void {
  expect(error).toBeInstanceOf(KisError);
  expect(error).toMatchObject({
    code: "SETTINGS",
    scope: "settings",
  });
}

describe("SettingsRepository initialization", () => {
  it("retries reads with the configured delays and resolves readiness degraded", async () => {
    const persistence = makePersistence(async () => {
      throw new Error("disk unavailable");
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const repository = new SettingsRepository(persistence, { sleep });

    const snapshot = await repository.whenReady();

    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1_000, 2_000, 4_000]);
    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
    expect(snapshot.settings).toEqual(v2());
    expect(snapshot.status).toMatchObject({
      baseKnown: false,
      persistenceDegraded: true,
    });
    expectSettingsError(snapshot.status.error);
  });

  it("uses one in-flight initialization for initialize and whenReady", async () => {
    let resolveRead!: (settings: GlobalSettings) => void;
    const persistence = makePersistence(
      () => new Promise<GlobalSettings>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });

    const first = repository.initialize();
    const second = repository.initialize();
    const ready = repository.whenReady();

    expect(second).toBe(first);
    expect(ready).toBe(first);
    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(1);

    resolveRead(v2());
    await Promise.all([first, second, ready]);
    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("keeps an in-memory migrated snapshot when migration persistence exhausts retries", async () => {
    const disk: GlobalSettings = {
      updateMode: "hybrid",
      throttleMs: "5001",
      external: { keep: true },
    };
    const diskBefore = structuredClone(disk);
    const persistence = makePersistence(
      async () => disk,
      async () => {
        throw new Error("write unavailable");
      },
    );
    const sleep = vi.fn(async (_ms: number) => {});
    const repository = new SettingsRepository(persistence, { sleep });

    const snapshot = await repository.initialize();

    expect(disk).toEqual(diskBefore);
    expect(snapshot.settings).toMatchObject({
      schemaVersion: 2,
      settingsRevision: 0,
      external: { keep: true },
      preferences: { renderIntervalMs: 10_000 },
    });
    expect(snapshot.settings).not.toHaveProperty("updateMode");
    expect(snapshot.settings).not.toHaveProperty("throttleMs");
    expect(snapshot.status).toMatchObject({
      baseKnown: true,
      persistenceDegraded: true,
    });
    expectSettingsError(snapshot.status.error);
    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1_000, 2_000, 4_000]);
  });
});

describe("SettingsRepository updates", () => {
  it("does not write when an unknown base cannot be refreshed", async () => {
    const persistence = makePersistence(async () => {
      throw new Error("disk unavailable");
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const repository = new SettingsRepository(persistence, { sleep });
    await repository.whenReady();

    let caught: unknown;
    try {
      await repository.update((draft) => {
        draft.appKey = "must-not-be-written";
      });
    } catch (error) {
      caught = error;
    }

    expectSettingsError(caught);
    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(8);
    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([
      1_000, 2_000, 4_000,
      1_000, 2_000, 4_000,
    ]);
  });

  it("refreshes an unknown base and preserves unseen external fields", async () => {
    const externalDisk: GlobalSettings = {
      settingsRevision: 7,
      external: { installedByAnotherComponent: true },
    };
    let reads = 0;
    const persistence = makePersistence(async () => {
      reads += 1;
      if (reads <= 4) throw new Error("initial read unavailable");
      return externalDisk;
    });
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.whenReady();

    const snapshot = await repository.update((draft) => {
      draft.preferences.dataMode = "rest-only";
    });

    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(1);
    expect(persistence.setGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        settingsRevision: 8,
        external: { installedByAnotherComponent: true },
        preferences: expect.objectContaining({ dataMode: "rest-only" }),
      }),
    );
    expect(snapshot.settings.external).toEqual({ installedByAnotherComponent: true });
    expect(snapshot.status).toEqual({
      baseKnown: true,
      persistenceDegraded: false,
    });
  });

  it("refreshes a healthy base and advances from the latest external revision", async () => {
    let disk = v2({ settingsRevision: 2, initializedField: "initial" });
    const persistence = makePersistence(
      async () => structuredClone(disk),
      async (settings) => {
        disk = structuredClone(settings);
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();

    disk = v2({
      settingsRevision: 9,
      externalField: { installedOutsideRepository: true },
    });
    const snapshot = await repository.update((draft) => {
      draft.repositoryField = "preserved-with-external";
    });

    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(2);
    expect(snapshot.settings).toMatchObject({
      settingsRevision: 10,
      externalField: { installedOutsideRepository: true },
      repositoryField: "preserved-with-external",
    });
    expect(snapshot.settings).not.toHaveProperty("initializedField");
  });

  it("serializes concurrent updates without losing fields and increments revisions in order", async () => {
    const writes: GlobalSettingsV2[] = [];
    let disk = v2({ settingsRevision: 4 });
    const persistence = makePersistence(
      async () => structuredClone(disk),
      async (settings) => {
        writes.push(structuredClone(settings));
        disk = structuredClone(settings);
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();

    const first = repository.update((draft) => {
      draft.firstExtension = { enabled: true };
    });
    const second = repository.update((draft) => {
      draft.secondExtension = "preserved";
    });
    const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      settingsRevision: 5,
      firstExtension: { enabled: true },
    });
    expect(writes[0]).not.toHaveProperty("secondExtension");
    expect(writes[1]).toMatchObject({
      settingsRevision: 6,
      firstExtension: { enabled: true },
      secondExtension: "preserved",
    });
    expect(firstSnapshot.settings.settingsRevision).toBe(5);
    expect(secondSnapshot.settings.settingsRevision).toBe(6);
    expect(repository.getSnapshot().settings).toMatchObject({
      firstExtension: { enabled: true },
      secondExtension: "preserved",
    });
    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(3);
  });

  it("does not persist or emit for a structural no-op excluding revision", async () => {
    const persistence = makePersistence(async () => v2({ settingsRevision: 3 }));
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();
    const listener = vi.fn();
    repository.subscribe(listener);

    const snapshot = await repository.update((draft) => {
      draft.settingsRevision = 999;
      draft.preferences.dataMode = "automatic";
    });

    expect(snapshot.settings.settingsRevision).toBe(3);
    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not commit a failed write and refreshes the base before the next update", async () => {
    const initial = v2({ settingsRevision: 3, initialField: "keep-until-refresh" });
    const refreshed = v2({
      settingsRevision: 7,
      externalField: { fromDisk: true },
    });
    let disk = initial;
    let writes = 0;
    const persistence = makePersistence(
      async () => structuredClone(disk),
      async (settings) => {
        writes += 1;
        if (writes <= 4) throw new Error("write unavailable");
        disk = structuredClone(settings);
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();
    const listener = vi.fn();
    repository.subscribe(listener);
    disk = refreshed;

    await expect(repository.update((draft) => {
      draft.failedField = "never-commit";
    })).rejects.toMatchObject({ code: "SETTINGS" });

    const afterFailure = repository.getSnapshot();
    expect(afterFailure.settings).toEqual(refreshed);
    expect(afterFailure.settings).not.toHaveProperty("failedField");
    expect(afterFailure.status).toMatchObject({
      baseKnown: true,
      persistenceDegraded: true,
    });
    expect(listener).toHaveBeenCalledTimes(2);

    const recovered = await repository.update((draft) => {
      draft.recoveredField = "committed";
    });

    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(3);
    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(5);
    expect(recovered.settings).toMatchObject({
      settingsRevision: 8,
      externalField: { fromDisk: true },
      recoveredField: "committed",
    });
    expect(recovered.settings).not.toHaveProperty("failedField");
    expect(recovered.status.persistenceDegraded).toBe(false);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("persists a recovered legacy base even when the updater is a no-op", async () => {
    const legacy: GlobalSettings = {
      settingsRevision: 5,
      updateMode: "hybrid",
      throttleMs: "5001",
      external: { preserved: true },
    };
    let reads = 0;
    const persistence = makePersistence(async () => {
      reads += 1;
      if (reads <= 4) throw new Error("initial read unavailable");
      return structuredClone(legacy);
    });
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();
    const listener = vi.fn();
    repository.subscribe(listener);

    const recovered = await repository.update(() => {});

    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(5);
    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(1);
    expect(persistence.setGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        settingsRevision: 5,
        external: { preserved: true },
        preferences: expect.objectContaining({ renderIntervalMs: 10_000 }),
      }),
    );
    expect(recovered.settings).not.toHaveProperty("updateMode");
    expect(recovered.settings).not.toHaveProperty("throttleMs");
    expect(recovered.status).toEqual({
      baseKnown: true,
      persistenceDegraded: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0]).toEqual(recovered);
  });

  it("exposes a degraded recovered base when no-op migration persistence fails", async () => {
    const legacy: GlobalSettings = {
      settingsRevision: 6,
      pollIntervalSec: "15",
      external: "keep-after-failure",
    };
    let reads = 0;
    const persistence = makePersistence(
      async () => {
        reads += 1;
        if (reads <= 4) throw new Error("initial read unavailable");
        return structuredClone(legacy);
      },
      async () => {
        throw new Error("migration write unavailable");
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();
    const listener = vi.fn();
    repository.subscribe(listener);

    await expect(repository.update(() => {})).rejects.toMatchObject({
      code: "SETTINGS",
      scope: "settings",
    });

    const snapshot = repository.getSnapshot();
    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(4);
    expect(snapshot.settings).toMatchObject({
      schemaVersion: 2,
      settingsRevision: 6,
      external: "keep-after-failure",
      preferences: { backupPollIntervalMs: 15_000 },
    });
    expect(snapshot.settings).not.toHaveProperty("pollIntervalSec");
    expect(snapshot.status).toMatchObject({
      baseKnown: true,
      persistenceDegraded: true,
      error: { code: "SETTINGS" },
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("keeps the update queue usable after a mutator throws", async () => {
    let disk = v2({ settingsRevision: 2, external: "keep" });
    const persistence = makePersistence(
      async () => structuredClone(disk),
      async (settings) => {
        disk = structuredClone(settings);
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();

    await expect(repository.update(() => {
      throw new Error("mutator failed");
    })).rejects.toThrow("mutator failed");
    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
    expect(repository.getSnapshot().settings).toEqual(v2({
      settingsRevision: 2,
      external: "keep",
    }));

    const recovered = await repository.update((draft) => {
      draft.afterMutatorFailure = true;
    });

    expect(recovered.settings).toMatchObject({
      settingsRevision: 3,
      external: "keep",
      afterMutatorFailure: true,
    });
    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(3);
    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsRepository snapshots and subscriptions", () => {
  it("returns deeply immutable clones and isolates listener failures and unsubscribe", async () => {
    const persistence = makePersistence(async () => v2({
      external: { nested: ["keep"] },
    }));
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();

    const snapshot = repository.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.settings)).toBe(true);
    expect(Object.isFrozen(snapshot.settings.external)).toBe(true);
    expect(() => {
      (snapshot.settings.external as { nested: string[] }).nested.push("mutate");
    }).toThrow();
    expect(repository.getSnapshot().settings.external).toEqual({ nested: ["keep"] });

    expect(() => repository.subscribe(() => {
      throw new Error("listener failure");
    })).not.toThrow();
    const listener = vi.fn();
    const unsubscribe = repository.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    await repository.update((draft) => {
      draft.firstUpdate = true;
    });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await repository.update((draft) => {
      draft.secondUpdate = true;
    });
    expect(listener).toHaveBeenCalledTimes(2);

    const status = repository.getStatus();
    expect(Object.isFrozen(status)).toBe(true);
    expect(status).toEqual({ baseKnown: true, persistenceDegraded: false });
  });

  it("uses a stable listener snapshot when a callback unsubscribes and resubscribes", async () => {
    let disk = v2();
    const persistence = makePersistence(
      async () => structuredClone(disk),
      async (settings) => {
        disk = structuredClone(settings);
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();

    let duringUpdate = false;
    let resubscribed = false;
    let unsubscribe = () => {};
    const listener = vi.fn(() => {
      if (duringUpdate && !resubscribed) {
        resubscribed = true;
        unsubscribe();
        unsubscribe = repository.subscribe(listener);
      }
    });
    unsubscribe = repository.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);

    duringUpdate = true;
    await repository.update((draft) => {
      draft.firstEmission = true;
    });
    duringUpdate = false;

    expect(listener).toHaveBeenCalledTimes(3);
    await repository.update((draft) => {
      draft.secondEmission = true;
    });
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("consumes each asynchronous listener rejection", async () => {
    let disk = v2();
    const persistence = makePersistence(
      async () => structuredClone(disk),
      async (settings) => {
        disk = structuredClone(settings);
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let reject = false;
    try {
      repository.subscribe(async () => {
        if (reject) throw new Error("async listener failed");
      });
      reject = true;

      await repository.update((draft) => {
        draft.emitAsyncFailure = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
