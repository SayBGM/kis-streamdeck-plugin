import { describe, expect, it, vi } from "vitest";
import { migrateGlobalSettings, type GlobalSettingsV2 } from "../../settings/schema.js";
import { SettingsRepository } from "../../settings/settings-repository.js";
import {
  CredentialSession,
  fingerprintCredentials,
  type AuthFetch,
  type CredentialSettingsPort,
  type PreparedRestFetch,
} from "../credential-session.js";

function makeSession(
  initial: GlobalSettingsV2,
  fetch: AuthFetch,
  now = 1_800_000_000_000,
  restFetch?: PreparedRestFetch,
): { session: CredentialSession; save: (settings: GlobalSettingsV2) => void } {
  let disk = structuredClone(initial);
  const repository = new SettingsRepository({
    getGlobalSettings: vi.fn(async () => structuredClone(disk)),
    setGlobalSettings: vi.fn(async (settings: GlobalSettingsV2) => {
      disk = structuredClone(settings);
    }),
  }, { sleep: async () => {} });
  return {
    session: new CredentialSession(repository, { fetch, now: () => now, restFetch }),
    save: (settings) => { disk = structuredClone(settings); },
  };
}

describe("CredentialSession REST authorization lease", () => {
  it("scopes REST secrets to the capability's one-shot transport", async () => {
    const fingerprint = fingerprintCredentials("key", "secret");
    const restFetch = vi.fn<PreparedRestFetch>(async () => ({ ok: true }));
    const { session } = makeSession(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 1,
      accessToken: "token",
      accessTokenExpiry: 1_900_000_000_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 2,
    }), vi.fn<AuthFetch>(), 1_800_000_000_000, restFetch);

    const capability = await session.prepareRestAuthorization();
    await expect(capability.execute({
      url: "https://openapi.koreainvestment.com:9443/uapi/test",
      trId: "TEST0001",
      signal: new AbortController().signal,
    })).resolves.toEqual({ ok: true });
    expect(restFetch.mock.calls[0][1].headers).toMatchObject({
      authorization: "Bearer token",
      appkey: "key",
      appsecret: "secret",
    });

    const secondCapability = await session.prepareRestAuthorization();
    const maliciousTransport = vi.fn<PreparedRestFetch>();
    await expect((secondCapability.execute as unknown as (
      request: Parameters<typeof secondCapability.execute>[0],
      transport: PreparedRestFetch,
    ) => Promise<unknown>)({
      url: "https://openapi.koreainvestment.com:9443/uapi/test",
      trId: "TEST0001",
      signal: new AbortController().signal,
    }, maliciousTransport)).resolves.toEqual({ ok: true });
    expect(maliciousTransport).not.toHaveBeenCalled();
    expect(restFetch).toHaveBeenCalledTimes(2);
  });

  it("prepares an opaque one-shot capability with no secret-bearing data properties", async () => {
    const fingerprint = fingerprintCredentials("key", "secret");
    const { session } = makeSession(migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 1,
      accessToken: "token",
      accessTokenExpiry: 1_900_000_000_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 2,
    }), vi.fn<AuthFetch>());

    const capability = await session.prepareRestAuthorization();
    const serialized = JSON.stringify(capability);
    const descriptors = Object.getOwnPropertyDescriptors(capability);
    expect(Object.keys(descriptors).sort()).toEqual(["execute", "expectation", "isCurrent"]);
    expect(serialized).not.toContain("key");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain('"token":"token"');
    expect(Object.isFrozen(capability)).toBe(true);
  });

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

    const capability = await session.prepareRestAuthorization();
    expect(capability.expectation).toEqual({
      credentialGeneration: 7,
      credentialFingerprint: fingerprint,
      tokenVersion: 12,
    });
    expect(capability.isCurrent()).toBe(true);
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

    const pending = session.prepareRestAuthorization();
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

  it("rejects a persisted lease invalidated between token lookup and authorization binding", async () => {
    const fingerprint = fingerprintCredentials("key", "secret");
    const valid = migrateGlobalSettings({
      appKey: "key",
      appSecret: "secret",
      credentialFingerprint: fingerprint,
      credentialGeneration: 4,
      accessToken: "token",
      accessTokenExpiry: 1_900_000_000_000,
      accessTokenFingerprint: fingerprint,
      accessTokenVersion: 9,
    });
    const invalidated = structuredClone(valid);
    delete invalidated.accessToken;
    delete invalidated.accessTokenExpiry;
    delete invalidated.accessTokenFingerprint;
    invalidated.accessTokenVersion = 10;
    let reads = 0;
    const snapshot = (settings: GlobalSettingsV2) => Object.freeze({
      settings,
      status: Object.freeze({ baseKnown: true, persistenceDegraded: false }),
    });
    const port: CredentialSettingsPort = {
      whenReady: vi.fn(async () => snapshot(valid)),
      getSnapshot: vi.fn(() => snapshot(++reads < 4 ? valid : invalidated)),
      update: vi.fn(async () => snapshot(valid)),
    };
    const session = new CredentialSession(port, { now: () => 1_800_000_000_000 });

    await expect(session.prepareRestAuthorization()).rejects.toMatchObject({
      code: "AUTH_REJECTED",
      scope: "auth",
    });
  });
});
