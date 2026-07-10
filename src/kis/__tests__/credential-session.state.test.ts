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
    persistence,
  };
}

describe("CredentialSession credential state", () => {
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

  it("uses a length-delimited SHA-256 fingerprint of normalized credentials", () => {
    expect(fingerprintCredentials(" key ", " secret ")).toBe(
      expectedFingerprint("key", "secret"),
    );
    expect(fingerprintCredentials("ab", "c")).not.toBe(
      fingerprintCredentials("a", "bc"),
    );
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
