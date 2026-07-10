import { describe, expect, it, vi } from "vitest";
import { migrateGlobalSettings, type GlobalSettingsV2 } from "../../settings/schema.js";
import {
  SettingsRepository,
  type SettingsPersistence,
} from "../../settings/settings-repository.js";
import {
  CredentialSession,
  fingerprintCredentials,
  type AuthFetch,
} from "../credential-session.js";

function makeRepository(initial: unknown, write?: (settings: GlobalSettingsV2) => Promise<void>): {
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
      await write?.(settings);
      disk = structuredClone(settings);
    }),
  };
  return {
    repository: new SettingsRepository(persistence, { sleep: async () => {} }),
    readDisk: () => structuredClone(disk),
    persistence,
  };
}

function configured(generation = 1, tokenVersion = 0): GlobalSettingsV2 {
  const credentialFingerprint = fingerprintCredentials("key", "secret");
  return migrateGlobalSettings({
    appKey: "key",
    appSecret: "secret",
    credentialFingerprint,
    credentialGeneration: generation,
    accessTokenVersion: tokenVersion,
  });
}

function response(ok: boolean, status: number, payload: unknown): unknown {
  return { ok, status, json: async () => payload };
}

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mock.mock.calls).toHaveLength(count);
}

describe("CredentialSession HTTP issuance", () => {
  it("fails without making an HTTP request when credentials are missing", async () => {
    const { repository } = makeRepository(migrateGlobalSettings({}));
    const fetch = vi.fn<AuthFetch>();
    const session = new CredentialSession(repository, { fetch });

    await expect(session.getAccessToken()).rejects.toMatchObject({
      code: "NO_CREDENTIALS",
      scope: "auth",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("singleflights access-token issuance per credential generation and persists one lease", async () => {
    const now = 1_800_000_000_000;
    const { repository, readDisk } = makeRepository(configured(4, 7));
    let resolveFetch!: (value: unknown) => void;
    const fetch = vi.fn<AuthFetch>(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const session = new CredentialSession(repository, { fetch, now: () => now });

    const first = session.getAccessToken();
    const second = session.getAccessToken();
    await waitForCalls(fetch, 1);
    resolveFetch(response(true, 200, { access_token: "issued-token", expires_in: 3600 }));

    const [firstLease, secondLease] = await Promise.all([first, second]);
    expect(firstLease).toEqual(secondLease);
    expect(firstLease).toEqual({
      token: "issued-token",
      expiresAt: now + 3_600_000,
      credentialGeneration: 4,
      credentialFingerprint: fingerprintCredentials("key", "secret"),
      tokenVersion: 8,
    });
    expect(readDisk()).toMatchObject({
      accessToken: "issued-token",
      accessTokenVersion: 8,
      accessTokenFingerprint: fingerprintCredentials("key", "secret"),
    });
  });

  it("separates generations and discards an old token issued after credentials change", async () => {
    const { repository, readDisk } = makeRepository(configured());
    const resolveFetch: Array<(value: unknown) => void> = [];
    const fetch = vi.fn<AuthFetch>(() => new Promise((resolve) => {
      resolveFetch.push(resolve);
    }));
    const session = new CredentialSession(repository, { fetch });

    const oldPending = session.getAccessToken();
    await waitForCalls(fetch, 1);
    await session.saveCredentials("new-key", "new-secret");
    const newPending = session.getAccessToken();
    await waitForCalls(fetch, 2);
    resolveFetch[1](response(true, 200, { access_token: "current-token", expires_in: 3600 }));
    await expect(newPending).resolves.toMatchObject({
      token: "current-token",
      credentialGeneration: 2,
    });
    resolveFetch[0](response(true, 200, { access_token: "stale-issued-token", expires_in: 3600 }));

    await expect(oldPending).rejects.toMatchObject({
      code: "AUTH_REJECTED",
      scope: "auth",
      retryable: true,
    });
    expect(readDisk()).toMatchObject({
      appKey: "new-key",
      appSecret: "new-secret",
      accessToken: "current-token",
      credentialGeneration: 2,
    });
  });

  it("ends an attempt at 10 seconds and clears its timer even when fetch ignores abort", async () => {
    const { repository } = makeRepository(configured());
    let timeoutCallback!: () => void;
    let capturedSignal: AbortSignal | undefined;
    const fetch = vi.fn<AuthFetch>((_url, init) => {
      capturedSignal = init.signal;
      return new Promise(() => {});
    });
    const setTimeout = vi.fn((callback: () => void, milliseconds: number): unknown => {
      timeoutCallback = callback;
      return { milliseconds };
    });
    const clearTimeout = vi.fn((_handle: unknown) => {});
    const session = new CredentialSession(repository, { fetch, setTimeout, clearTimeout });

    const pending = session.getAccessToken();
    await waitForCalls(fetch, 1);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 10_000);
    timeoutCallback();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", scope: "auth" });
    expect(capturedSignal?.aborted).toBe(true);
    expect(clearTimeout).toHaveBeenCalledOnce();
  });

  it("applies the same 10-second hard timeout while the response body stalls", async () => {
    const { repository } = makeRepository(configured());
    let timeoutCallback!: () => void;
    const fetch = vi.fn<AuthFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => new Promise(() => {}),
    });
    const setTimeout = vi.fn((callback: () => void): unknown => {
      timeoutCallback = callback;
      return 1;
    });
    const clearTimeout = vi.fn((_handle: unknown) => {});
    const session = new CredentialSession(repository, { fetch, setTimeout, clearTimeout });

    const pending = session.getAccessToken();
    await waitForCalls(fetch, 1);
    timeoutCallback();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", scope: "auth" });
    expect(clearTimeout).toHaveBeenCalledOnce();
  });

  it("waits exactly 60 seconds and retries EGW00133 only once", async () => {
    const { repository } = makeRepository(configured());
    const fetch = vi.fn<AuthFetch>()
      .mockResolvedValueOnce(response(false, 403, { error_code: "EGW00133" }))
      .mockResolvedValueOnce(response(false, 403, { error_code: "EGW00133" }));
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const session = new CredentialSession(repository, { fetch, sleep });

    await expect(session.getAccessToken()).rejects.toMatchObject({
      code: "AUTH_RATE_LIMITED",
      scope: "auth",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("returns a second-attempt token after one EGW00133 delay", async () => {
    const { repository } = makeRepository(configured());
    const fetch = vi.fn<AuthFetch>()
      .mockResolvedValueOnce(response(false, 403, { error_code: "EGW00133" }))
      .mockResolvedValueOnce(response(true, 200, { access_token: "retried-token", expires_in: 60 }));
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const session = new CredentialSession(repository, { fetch, sleep, now: () => 1_000 });

    await expect(session.getAccessToken()).resolves.toMatchObject({ token: "retried-token" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("singleflights approval keys per generation without persisting them or retrying rate limits", async () => {
    const { repository, readDisk, persistence } = makeRepository(configured(2));
    let resolveFetch!: (value: unknown) => void;
    const fetch = vi.fn<AuthFetch>(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const session = new CredentialSession(repository, { fetch });

    const first = session.getApprovalKey();
    const second = session.getApprovalKey();
    await waitForCalls(fetch, 1);
    resolveFetch(response(true, 200, { approval_key: "approval" }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ approvalKey: "approval", credentialGeneration: 2 }),
      expect.objectContaining({ approvalKey: "approval", credentialGeneration: 2 }),
    ]);
    expect(readDisk()).not.toHaveProperty("approvalKey");
    const writesBeforeRateLimit = persistence.setGlobalSettings.mock.calls.length;

    const rateFetch = vi.fn<AuthFetch>().mockResolvedValue(
      response(false, 403, { error_code: "EGW00133" }),
    );
    const rateSleep = vi.fn(async () => {});
    const rateSession = new CredentialSession(repository, { fetch: rateFetch, sleep: rateSleep });
    await expect(rateSession.getApprovalKey()).rejects.toMatchObject({ code: "AUTH_RATE_LIMITED" });
    expect(rateFetch).toHaveBeenCalledOnce();
    expect(rateSleep).not.toHaveBeenCalled();
    expect(persistence.setGlobalSettings.mock.calls.length).toBe(writesBeforeRateLimit);
  });

  it("discards an approval key when credentials change during issuance", async () => {
    const { repository, readDisk } = makeRepository(configured());
    let resolveFetch!: (value: unknown) => void;
    const fetch = vi.fn<AuthFetch>(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const session = new CredentialSession(repository, { fetch });

    const pending = session.getApprovalKey();
    await waitForCalls(fetch, 1);
    await session.clearCredentials();
    resolveFetch(response(true, 200, { approval_key: "stale-approval" }));

    await expect(pending).rejects.toMatchObject({
      code: "AUTH_REJECTED",
      scope: "auth",
      retryable: true,
    });
    expect(readDisk()).not.toHaveProperty("approvalKey");
  });

  it.each([
    ["network", vi.fn<AuthFetch>(async () => { throw new Error("raw-secret raw-token"); }), "NETWORK"],
    ["http", vi.fn<AuthFetch>(async () => response(false, 401, { detail: "raw-secret raw-token" })), "AUTH_REJECTED"],
    ["protocol", vi.fn<AuthFetch>(async () => ({
      get ok() { throw new Error("raw-secret raw-token"); },
    })), "PROTOCOL"],
  ] as const)("maps %s failures without leaking raw values", async (_label, fetch, code) => {
    const { repository } = makeRepository(configured());
    const session = new CredentialSession(repository, { fetch });

    const caught = await session.getAccessToken().catch((error) => error);

    expect(caught).toMatchObject({ code, scope: "auth" });
    expect(JSON.stringify(caught)).not.toContain("raw-secret");
    expect(JSON.stringify(caught)).not.toContain("raw-token");
  });

  it.each([
    [true, 500],
    [false, 200],
  ] as const)(
    "rejects contradictory HTTP semantics ok=%s status=%d without persisting a token",
    async (ok, status) => {
      const { repository, readDisk } = makeRepository(configured());
      const fetch = vi.fn<AuthFetch>().mockResolvedValue(
        response(ok, status, { access_token: "must-not-be-stored", expires_in: 3600 }),
      );
      const session = new CredentialSession(repository, { fetch });

      await expect(session.getAccessToken()).rejects.toMatchObject({
        code: "PROTOCOL",
        scope: "auth",
        retryable: false,
      });
      expect(readDisk()).not.toHaveProperty("accessToken");
    },
  );

  it("rejects accessor payloads without invoking secret-bearing fields", async () => {
    const { repository } = makeRepository(configured());
    const tokenGetter = vi.fn(() => {
      throw new Error("raw-secret raw-token");
    });
    const payload = Object.defineProperty({ expires_in: 3600 }, "access_token", {
      enumerable: true,
      get: tokenGetter,
    });
    const fetch = vi.fn<AuthFetch>().mockResolvedValue(response(true, 200, payload));
    const session = new CredentialSession(repository, { fetch });

    const caught = await session.getAccessToken().catch((error) => error);

    expect(caught).toMatchObject({ code: "PROTOCOL", scope: "auth" });
    expect(tokenGetter).not.toHaveBeenCalled();
    expect(JSON.stringify(caught)).not.toContain("raw-secret");
  });

  it("does not return an issued token when its settings write fails", async () => {
    const { repository } = makeRepository(configured(), async () => {
      throw new Error("write failed with issued-token");
    });
    const fetch = vi.fn<AuthFetch>().mockResolvedValue(
      response(true, 200, { access_token: "issued-token", expires_in: 3600 }),
    );
    const session = new CredentialSession(repository, { fetch });

    const caught = await session.getAccessToken().catch((error) => error);

    expect(caught).toMatchObject({ code: "SETTINGS", scope: "settings" });
    expect(JSON.stringify(caught)).not.toContain("issued-token");
  });
});
