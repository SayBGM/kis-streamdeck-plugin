import { describe, expect, it, vi } from "vitest";
import { migrateGlobalSettings, type GlobalSettingsV2 } from "../../settings/schema.js";
import { SettingsRepository } from "../../settings/settings-repository.js";
import {
  CredentialSession,
  fingerprintCredentials,
  type AuthFetch,
} from "../credential-session.js";

function makeSession(
  initial: GlobalSettingsV2,
  fetch: AuthFetch,
  now = 1_800_000_000_000,
): { session: CredentialSession; save: (settings: GlobalSettingsV2) => void } {
  let disk = structuredClone(initial);
  const repository = new SettingsRepository({
    getGlobalSettings: vi.fn(async () => structuredClone(disk)),
    setGlobalSettings: vi.fn(async (settings: GlobalSettingsV2) => {
      disk = structuredClone(settings);
    }),
  }, { sleep: async () => {} });
  return {
    session: new CredentialSession(repository, { fetch, now: () => now }),
    save: (settings) => { disk = structuredClone(settings); },
  };
}

describe("CredentialSession REST authorization lease", () => {
  it("returns credentials bound to the exact access-token generation", async () => {
    const fingerprint = fingerprintCredentials("key", "secret");
    const fetch = vi.fn<AuthFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "token", expires_in: 3600 }),
    });
    const { session } = makeSession(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 7,
      accessTokenVersion: 11,
    }), fetch);

    await expect(session.getRestAuthorization()).resolves.toEqual({
      appKey: "key",
      appSecret: "secret",
      token: "token",
      expiresAt: 1_800_003_600_000,
      credentialGeneration: 7,
      credentialFingerprint: fingerprint,
      tokenVersion: 12,
    });
  });

  it("does not return an old token with credentials changed during issuance", async () => {
    const oldFingerprint = fingerprintCredentials("old-key", "old-secret");
    let resolveFetch!: (value: unknown) => void;
    const fetch = vi.fn<AuthFetch>(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const { session } = makeSession(migrateGlobalSettings({
      appKey: "old-key",
      appSecret: "old-secret",
      credentialFingerprint: oldFingerprint,
      credentialGeneration: 2,
      accessTokenVersion: 3,
    }), fetch);

    const pending = session.getRestAuthorization();
    while (fetch.mock.calls.length === 0) await Promise.resolve();
    await session.saveCredentials("new-key", "new-secret");
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "stale-token", expires_in: 3600 }),
    });

    await expect(pending).rejects.toMatchObject({
      code: "AUTH_REJECTED",
      scope: "auth",
    });
  });
});
