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

  it("serializes concurrent updates without losing fields and increments revisions in order", async () => {
    const writes: GlobalSettingsV2[] = [];
    const persistence = makePersistence(
      async () => v2({ settingsRevision: 4 }),
      async (settings) => {
        writes.push(structuredClone(settings));
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
    let reads = 0;
    let writes = 0;
    const persistence = makePersistence(
      async () => {
        reads += 1;
        return reads === 1 ? initial : refreshed;
      },
      async () => {
        writes += 1;
        if (writes <= 4) throw new Error("write unavailable");
      },
    );
    const repository = new SettingsRepository(persistence, {
      sleep: async () => {},
    });
    await repository.initialize();

    await expect(repository.update((draft) => {
      draft.failedField = "never-commit";
    })).rejects.toMatchObject({ code: "SETTINGS" });

    const afterFailure = repository.getSnapshot();
    expect(afterFailure.settings).toEqual(initial);
    expect(afterFailure.settings).not.toHaveProperty("failedField");
    expect(afterFailure.status.persistenceDegraded).toBe(true);

    const recovered = await repository.update((draft) => {
      draft.recoveredField = "committed";
    });

    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(2);
    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(5);
    expect(recovered.settings).toMatchObject({
      settingsRevision: 8,
      externalField: { fromDisk: true },
      recoveredField: "committed",
    });
    expect(recovered.settings).not.toHaveProperty("failedField");
    expect(recovered.settings).not.toHaveProperty("initialField");
    expect(recovered.status.persistenceDegraded).toBe(false);
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
});
