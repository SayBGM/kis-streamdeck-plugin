import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { migrateGlobalSettings, type GlobalSettingsV2 } from "../../settings/schema.js";
import {
  SettingsRepository,
  type SettingsPersistence,
} from "../../settings/settings-repository.js";
import {
  CredentialSession,
  fingerprintCredentials,
  type CredentialSettingsPort,
} from "../credential-session.js";

function expectedFingerprint(appKey: string, appSecret: string): string {
  const key = appKey.trim();
  const secret = appSecret.trim();
  return createHash("sha256")
    .update(`${key.length}:${key}${secret.length}:${secret}`, "utf8")
    .digest("hex");
}

function makeRepository(initial: unknown): {
  repository: SettingsRepository;
  readDisk: () => GlobalSettingsV2;
  writeDisk: (settings: unknown) => void;
  persistence: SettingsPersistence & {
    getGlobalSettings: ReturnType<typeof vi.fn>;
    setGlobalSettings: ReturnType<typeof vi.fn>;
  };
} {
  let disk = structuredClone(initial) as GlobalSettingsV2;
  const persistence = {
    getGlobalSettings: vi.fn(async () => structuredClone(disk)),
    setGlobalSettings: vi.fn(async (settings: GlobalSettingsV2) => {
      disk = structuredClone(settings);
    }),
  };
  return {
    repository: new SettingsRepository(persistence, { sleep: async () => {} }),
    readDisk: () => structuredClone(disk),
    writeDisk: (settings: unknown) => { disk = structuredClone(settings) as GlobalSettingsV2; },
    persistence,
  };
}

describe("CredentialSession credential state", () => {
  it("returns the latest identity after credentials are saved following bootstrap", async () => {
    const { repository } = makeRepository(migrateGlobalSettings({}));
    const session = new CredentialSession(repository);

    await expect(session.initialize()).resolves.toEqual({
      configured: false,
      credentialGeneration: 0,
    });
    await session.saveCredentials("key", "secret");

    await expect(session.initialize()).resolves.toMatchObject({
      configured: true,
      credentialGeneration: 1,
      credentialFingerprint: expectedFingerprint("key", "secret"),
    });
  });

  it("reconciles credentials written externally after an empty successful bootstrap", async () => {
    const { repository, readDisk, writeDisk } = makeRepository(migrateGlobalSettings({}));
    const session = new CredentialSession(repository);
    await expect(session.initialize()).resolves.toMatchObject({ configured: false });

    writeDisk(migrateGlobalSettings({ appKey: " external-key ", appSecret: " external-secret " }));
    await repository.update(() => undefined);

    await expect(session.reconcile()).resolves.toMatchObject({
      configured: true,
      credentialGeneration: 1,
      credentialFingerprint: expectedFingerprint("external-key", "external-secret"),
    });
    expect(readDisk()).toMatchObject({
      appKey: "external-key",
      appSecret: "external-secret",
      credentialGeneration: 1,
      credentialFingerprint: expectedFingerprint("external-key", "external-secret"),
    });
  });

  it("singleflights concurrent reconciliation when external credentials need repair", async () => {
    const raw = migrateGlobalSettings({ appKey: "key", appSecret: "secret" });
    const repaired = migrateGlobalSettings({
      ...raw,
      credentialFingerprint: expectedFingerprint("key", "secret"),
      credentialGeneration: 1,
      accessTokenVersion: 1,
    });
    const snapshot = (settings: GlobalSettingsV2) => Object.freeze({
      settings,
      status: Object.freeze({ baseKnown: true, persistenceDegraded: false }),
    });
    let current = snapshot(raw);
    let resolveUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => { resolveUpdate = resolve; });
    const port: CredentialSettingsPort = {
      whenReady: vi.fn(async () => current),
      getSnapshot: vi.fn(() => current),
      update: vi.fn(async () => {
        await updateGate;
        current = snapshot(repaired);
        return current;
      }),
    };
    const session = new CredentialSession(port);

    const first = session.reconcile();
    const second = session.reconcile();
    await vi.waitFor(() => expect(port.update).toHaveBeenCalledOnce());
    resolveUpdate();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ configured: true, credentialGeneration: 1 }),
      expect.objectContaining({ configured: true, credentialGeneration: 1 }),
    ]);
    expect(port.update).toHaveBeenCalledOnce();
  });

  it("does not rewrite or advance generation for a valid token-only self write", async () => {
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, readDisk, persistence } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 3,
      accessTokenVersion: 4,
    }));
    const session = new CredentialSession(repository);
    await session.initialize();
    await repository.update((draft) => {
      draft.accessToken = "token";
      draft.accessTokenExpiry = 1_900_000_000_000;
      draft.accessTokenFingerprint = fingerprint;
      draft.accessTokenVersion = 5;
    });
    const writesAfterToken = persistence.setGlobalSettings.mock.calls.length;
    const revisionAfterToken = readDisk().settingsRevision;

    await session.reconcile();

    expect(persistence.setGlobalSettings).toHaveBeenCalledTimes(writesAfterToken);
    expect(readDisk()).toMatchObject({
      settingsRevision: revisionAfterToken,
      credentialGeneration: 3,
      accessTokenVersion: 5,
    });
  });

  it("returns the latest identity after credentials are cleared following bootstrap", async () => {
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 4,
      accessTokenVersion: 6,
    }));
    const session = new CredentialSession(repository);

    await expect(session.initialize()).resolves.toMatchObject({ configured: true });
    await session.clearCredentials();

    await expect(session.initialize()).resolves.toEqual({
      configured: false,
      credentialGeneration: 5,
    });
  });

  it("treats readiness only as a barrier and reads the latest repository snapshot", async () => {
    const staleSettings = migrateGlobalSettings({});
    const latestSettings = migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: expectedFingerprint("key", "secret"),
      credentialGeneration: 2,
    });
    const staleSnapshot = Object.freeze({
      settings: staleSettings,
      status: Object.freeze({ baseKnown: true, persistenceDegraded: false }),
    });
    const latestSnapshot = Object.freeze({
      settings: latestSettings,
      status: Object.freeze({ baseKnown: true, persistenceDegraded: false }),
    });
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const port: CredentialSettingsPort = {
      whenReady: vi.fn(async () => {
        await ready;
        return staleSnapshot;
      }),
      getSnapshot: vi.fn(() => latestSnapshot),
      update: vi.fn(async () => latestSnapshot),
    };
    const session = new CredentialSession(port);

    const pending = session.initialize();
    releaseReady();

    await expect(pending).resolves.toMatchObject({
      configured: true,
      credentialGeneration: 2,
      credentialFingerprint: expectedFingerprint("key", "secret"),
    });
    expect(port.getSnapshot).toHaveBeenCalled();
    expect(port.update).not.toHaveBeenCalled();
  });

  it("singleflights concurrent bootstrap and memoizes the successful normalized state", async () => {
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, persistence } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 3,
      accessTokenVersion: 4,
    }));
    const session = new CredentialSession(repository);

    const [first, second] = await Promise.all([session.initialize(), session.initialize()]);
    const readsAfterBootstrap = persistence.getGlobalSettings.mock.calls.length;
    await session.initialize();

    expect(first).toEqual(second);
    expect(first).toMatchObject({ configured: true, credentialGeneration: 3 });
    expect(readsAfterBootstrap).toBe(1);
    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(readsAfterBootstrap);
  });

  it("does not add persistence reads when reusing a valid token after bootstrap", async () => {
    const now = 1_800_000_000_000;
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, persistence } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 2,
      accessToken: "persisted-token",
      accessTokenExpiry: now + 60 * 60_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 6,
    }));
    const session = new CredentialSession(repository, { now: () => now });
    await session.initialize();
    const readsAfterBootstrap = persistence.getGlobalSettings.mock.calls.length;

    await expect(session.getPersistedAccessToken()).resolves.toMatchObject({
      token: "persisted-token",
      tokenVersion: 6,
    });
    await session.getPersistedAccessToken();

    expect(persistence.getGlobalSettings).toHaveBeenCalledTimes(readsAfterBootstrap);
  });

  it("does not memoize a failed bootstrap so a later settings recovery can retry", async () => {
    let available = false;
    const disk = migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
    });
    const persistence: SettingsPersistence = {
      getGlobalSettings: vi.fn(async () => {
        if (!available) throw new Error("temporarily unavailable");
        return structuredClone(disk);
      }),
      setGlobalSettings: vi.fn(async () => {}),
    };
    const repository = new SettingsRepository(persistence, { sleep: async () => {} });
    const session = new CredentialSession(repository);

    await expect(session.initialize()).rejects.toMatchObject({ code: "SETTINGS" });
    available = true;
    await expect(session.initialize()).resolves.toMatchObject({ configured: true });
  });

  it("waits for SettingsRepository readiness before attempting a credential write", async () => {
    let resolveRead!: (settings: GlobalSettingsV2) => void;
    let ready = false;
    const persistence: SettingsPersistence = {
      getGlobalSettings: vi.fn(() => ready
        ? Promise.resolve(migrateGlobalSettings({}))
        : new Promise<GlobalSettingsV2>((resolve) => {
            resolveRead = (settings) => {
              ready = true;
              resolve(settings);
            };
          })),
      setGlobalSettings: vi.fn(async () => {}),
    };
    const repository = new SettingsRepository(persistence, { sleep: async () => {} });
    const session = new CredentialSession(repository);

    const pending = session.saveCredentials("key", "secret");
    await Promise.resolve();

    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
    resolveRead(migrateGlobalSettings({}));
    await pending;
    expect(persistence.setGlobalSettings).toHaveBeenCalledOnce();
  });

  it("bootstraps a legacy credential fingerprint and discards its unbound token", async () => {
    const { repository, readDisk } = makeRepository({
      appKey: " legacy-key ",
      appSecret: " legacy-secret ",
      accessToken: "legacy-token-must-not-survive",
      accessTokenExpiry: 9_999_999_999_999,
    });
    const session = new CredentialSession(repository);

    const identity = await session.initialize();
    const disk = readDisk();

    expect(identity).toEqual({
      configured: true,
      credentialGeneration: 1,
      credentialFingerprint: expectedFingerprint("legacy-key", "legacy-secret"),
    });
    expect(disk).toMatchObject({
      appKey: "legacy-key",
      appSecret: "legacy-secret",
      credentialGeneration: 1,
      credentialFingerprint: expectedFingerprint("legacy-key", "legacy-secret"),
      accessTokenVersion: 1,
    });
    expect(disk).not.toHaveProperty("accessToken");
    expect(disk).not.toHaveProperty("accessTokenExpiry");
    expect(disk).not.toHaveProperty("accessTokenFingerprint");
  });

  it.each([
    ["appKey only", { appKey: "orphan-key" }],
    ["appSecret only", { appSecret: "orphan-secret" }],
  ])("clears a partial credential state (%s) and advances both security generations", async (_label, partial) => {
    const fingerprint = "stale-fingerprint";
    const { repository, readDisk } = makeRepository(migrateGlobalSettings({
      ...partial,
      credentialFingerprint: fingerprint,
      credentialGeneration: 5,
      accessToken: "stale-token",
      accessTokenExpiry: 9_999_999_999_999,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 8,
    }));
    const session = new CredentialSession(repository);

    await expect(session.initialize()).resolves.toEqual({
      configured: false,
      credentialGeneration: 6,
    });
    const disk = readDisk();
    expect(disk).toMatchObject({ credentialGeneration: 6, accessTokenVersion: 9 });
    expect(disk).not.toHaveProperty("appKey");
    expect(disk).not.toHaveProperty("appSecret");
    expect(disk).not.toHaveProperty("credentialFingerprint");
    expect(disk).not.toHaveProperty("accessToken");
  });

  it("leaves a completely empty authentication state unchanged", async () => {
    const { repository, readDisk, persistence } = makeRepository(migrateGlobalSettings({}));
    const session = new CredentialSession(repository);

    await session.initialize();

    expect(readDisk()).toMatchObject({ credentialGeneration: 0, accessTokenVersion: 0 });
    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("uses a length-delimited SHA-256 fingerprint of normalized credentials", () => {
    expect(fingerprintCredentials(" key ", " secret ")).toBe(
      expectedFingerprint("key", "secret"),
    );
    expect(fingerprintCredentials("ab", "c")).not.toBe(
      fingerprintCredentials("a", "bc"),
    );
  });

  it.each([
    ["number", 123],
    ["symbol", Symbol("raw-secret")],
    ["getter object", Object.defineProperty({}, "trim", {
      get() { throw new Error("raw-secret"); },
    })],
    ["proxy", new Proxy({}, {
      get() { throw new Error("raw-secret"); },
    })],
  ])("rejects unsafe fingerprint input (%s) without exposing runtime errors", (_label, unsafe) => {
    let caught: unknown;
    try {
      fingerprintCredentials(unsafe as never, "secret");
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "NO_CREDENTIALS", scope: "auth" });
    expect(JSON.stringify(caught)).not.toContain("raw-secret");
  });

  it("increments credential and token generations only when saved credentials change", async () => {
    const { repository, readDisk } = makeRepository({});
    const session = new CredentialSession(repository);

    await session.saveCredentials(" key ", " secret ");
    const first = readDisk();
    await session.saveCredentials("key", "secret");
    const unchanged = readDisk();
    await session.saveCredentials("new-key", "new-secret");
    const changed = readDisk();

    expect(first).toMatchObject({ credentialGeneration: 1, accessTokenVersion: 1 });
    expect(unchanged).toMatchObject({
      settingsRevision: first.settingsRevision,
      credentialGeneration: 1,
      accessTokenVersion: 1,
    });
    expect(changed).toMatchObject({ credentialGeneration: 2, accessTokenVersion: 2 });
  });

  it("rejects empty credential saves without clearing the current identity", async () => {
    const { repository, readDisk } = makeRepository({});
    const session = new CredentialSession(repository);
    await session.saveCredentials("key", "secret");

    await expect(session.saveCredentials(" ", "new-secret")).rejects.toMatchObject({
      code: "NO_CREDENTIALS",
      scope: "auth",
      retryable: false,
    });
    expect(readDisk()).toMatchObject({ appKey: "key", appSecret: "secret" });
  });

  it.each([
    ["number", 123],
    ["symbol", Symbol("raw-secret")],
    ["getter object", Object.defineProperty({}, "trim", {
      get() { throw new Error("raw-secret"); },
    })],
    ["proxy", new Proxy({}, {
      get() { throw new Error("raw-secret"); },
    })],
  ])("rejects unsafe credential saves (%s) without mutating the current identity", async (_label, unsafe) => {
    const { repository, readDisk } = makeRepository({});
    const session = new CredentialSession(repository);
    await session.saveCredentials("key", "secret");

    const caught = await session.saveCredentials(unsafe as never, "raw-secret").catch((error) => error);

    expect(caught).toMatchObject({ code: "NO_CREDENTIALS", scope: "auth" });
    expect(JSON.stringify(caught)).not.toContain("raw-secret");
    expect(readDisk()).toMatchObject({ appKey: "key", appSecret: "secret" });
  });

  it("clears credentials and tokens once without repeatedly advancing generations", async () => {
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, readDisk } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 4,
      accessToken: "token",
      accessTokenExpiry: 9_999_999_999_999,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 8,
    }));
    const session = new CredentialSession(repository);

    await session.clearCredentials();
    const first = readDisk();
    await session.clearCredentials();
    const unchanged = readDisk();

    expect(first).toMatchObject({ credentialGeneration: 5, accessTokenVersion: 9 });
    expect(first).not.toHaveProperty("appKey");
    expect(first).not.toHaveProperty("appSecret");
    expect(first).not.toHaveProperty("credentialFingerprint");
    expect(first).not.toHaveProperty("accessToken");
    expect(unchanged.settingsRevision).toBe(first.settingsRevision);
    expect(unchanged.credentialGeneration).toBe(5);
    expect(unchanged.accessTokenVersion).toBe(9);
  });

  it("reuses only a fingerprint-bound persisted token outside the five-minute safety window", async () => {
    const now = 1_800_000_000_000;
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 2,
      accessToken: "persisted-token",
      accessTokenExpiry: now + 5 * 60_000 + 1,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 6,
    }));
    const session = new CredentialSession(repository, { now: () => now });

    await expect(session.getPersistedAccessToken()).resolves.toEqual({
      token: "persisted-token",
      expiresAt: now + 5 * 60_000 + 1,
      credentialGeneration: 2,
      credentialFingerprint: fingerprint,
      tokenVersion: 6,
    });
  });

  it("invalidates a persisted token inside the expiry safety window", async () => {
    const now = 1_800_000_000_000;
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, readDisk } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 2,
      accessToken: "expiring-token",
      accessTokenExpiry: now + 5 * 60_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 6,
    }));
    const session = new CredentialSession(repository, { now: () => now });

    await expect(session.getPersistedAccessToken()).resolves.toBeNull();
    expect(readDisk()).toMatchObject({ accessTokenVersion: 7 });
    expect(readDisk()).not.toHaveProperty("accessToken");
  });

  it("uses generation, fingerprint, and token version as a 401 invalidation CAS", async () => {
    const now = 1_800_000_000_000;
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, readDisk } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 3,
      accessToken: "current-token",
      accessTokenExpiry: now + 60 * 60_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 9,
    }));
    const session = new CredentialSession(repository, { now: () => now });
    const lease = await session.getPersistedAccessToken();
    expect(lease).not.toBeNull();

    await expect(session.invalidateAccessToken({
      credentialGeneration: 3,
      credentialFingerprint: fingerprint,
      tokenVersion: 8,
    })).resolves.toBe(false);
    expect(readDisk()).toHaveProperty("accessToken", "current-token");

    await expect(session.invalidateAccessToken(lease!)).resolves.toBe(true);
    expect(readDisk()).not.toHaveProperty("accessToken");
    expect(readDisk().accessTokenVersion).toBe(10);
    await expect(session.invalidateAccessToken(lease!)).resolves.toBe(false);
  });

  it.each([
    ["accessor", Object.defineProperty({}, "credentialGeneration", {
      enumerable: true,
      get() { throw new Error("raw-secret"); },
    })],
    ["proxy", new Proxy({}, {
      ownKeys() { throw new Error("raw-secret"); },
    })],
  ])("rejects an unsafe invalidation expectation (%s) without touching the token", async (_label, unsafe) => {
    const now = 1_800_000_000_000;
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, readDisk } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 3,
      accessToken: "current-token",
      accessTokenExpiry: now + 60 * 60_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 9,
    }));
    const session = new CredentialSession(repository, { now: () => now });

    const caught = await session.invalidateAccessToken(unsafe as never).catch((error) => error);

    expect(caught).toMatchObject({ code: "PROTOCOL", scope: "auth" });
    expect(JSON.stringify(caught)).not.toContain("raw-secret");
    expect(readDisk()).toHaveProperty("accessToken", "current-token");
  });

  it("rejects a revoked invalidation proxy without leaking a native TypeError", async () => {
    const now = 1_800_000_000_000;
    const fingerprint = expectedFingerprint("key", "secret");
    const { repository, readDisk } = makeRepository(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 3,
      accessToken: "current-token",
      accessTokenExpiry: now + 60 * 60_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 9,
    }));
    const session = new CredentialSession(repository, { now: () => now });
    const revoked = Proxy.revocable({
      credentialGeneration: 3,
      credentialFingerprint: fingerprint,
      tokenVersion: 9,
    }, {});
    revoked.revoke();

    const caught = await session.invalidateAccessToken(revoked.proxy).catch((error) => error);

    expect(caught).toMatchObject({ code: "PROTOCOL", scope: "auth" });
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(JSON.stringify(caught)).not.toContain("revoked");
    expect(readDisk()).toHaveProperty("accessToken", "current-token");
  });

  it("does not write unknown settings and never leaks a rejected credential secret", async () => {
    const persistence: SettingsPersistence = {
      getGlobalSettings: vi.fn(async () => {
        throw new Error("disk unavailable with secret-do-not-leak");
      }),
      setGlobalSettings: vi.fn(async () => {}),
    };
    const repository = new SettingsRepository(persistence, { sleep: async () => {} });
    const session = new CredentialSession(repository);

    const caught = await session.saveCredentials("key", "secret-do-not-leak").catch((error) => error);

    expect(caught).toMatchObject({ code: "SETTINGS", scope: "settings" });
    expect(JSON.stringify(caught)).not.toContain("secret-do-not-leak");
    expect(persistence.setGlobalSettings).not.toHaveBeenCalled();
  });

  it("reports an unconfigured identity without creating authentication state", async () => {
    const { repository } = makeRepository({});
    const session = new CredentialSession(repository);

    await expect(session.initialize()).resolves.toEqual({
      configured: false,
      credentialGeneration: 0,
    });
  });
});
