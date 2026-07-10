import { createHash } from "node:crypto";
import { KisError } from "../core/errors.js";
import type {
  SettingsRepository,
  SettingsSnapshot,
} from "../settings/settings-repository.js";
import type { GlobalSettingsV2 } from "../settings/schema.js";

const TOKEN_REFRESH_SAFETY_MS = 5 * 60_000;

export interface CredentialIdentity {
  readonly configured: boolean;
  readonly credentialGeneration: number;
  readonly credentialFingerprint?: string;
}

export interface AccessTokenLease {
  readonly token: string;
  readonly expiresAt: number;
  readonly credentialGeneration: number;
  readonly credentialFingerprint: string;
  readonly tokenVersion: number;
}

export interface ApprovalKeyLease {
  readonly approvalKey: string;
  readonly credentialGeneration: number;
  readonly credentialFingerprint: string;
}

export interface AccessTokenExpectation {
  readonly credentialGeneration: number;
  readonly credentialFingerprint: string;
  readonly tokenVersion: number;
}

export interface CredentialSessionOptions {
  readonly now?: () => number;
}

interface NormalizedCredentials {
  readonly appKey: string;
  readonly appSecret: string;
  readonly fingerprint: string;
  readonly generation: number;
}

function settingsCounterError(): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: false,
    safeMessage: "인증 설정 세대를 더 이상 증가시킬 수 없습니다.",
  }));
}

function noCredentialsError(): KisError {
  return Object.freeze(new KisError({
    code: "NO_CREDENTIALS",
    scope: "auth",
    retryable: false,
    safeMessage: "KIS API 자격증명이 비어 있습니다.",
  }));
}

function incrementCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw settingsCounterError();
  }
  return value + 1;
}

function normalizedPair(appKey: string, appSecret: string): {
  appKey: string;
  appSecret: string;
} {
  return { appKey: appKey.trim(), appSecret: appSecret.trim() };
}

export function fingerprintCredentials(appKey: string, appSecret: string): string {
  const normalized = normalizedPair(appKey, appSecret);
  return createHash("sha256")
    .update(
      `${normalized.appKey.length}:${normalized.appKey}` +
        `${normalized.appSecret.length}:${normalized.appSecret}`,
      "utf8",
    )
    .digest("hex");
}

function clearPersistedToken(draft: GlobalSettingsV2): void {
  delete draft.accessToken;
  delete draft.accessTokenExpiry;
  delete draft.accessTokenFingerprint;
}

function credentialsFromSettings(
  settings: Readonly<GlobalSettingsV2>,
): NormalizedCredentials | null {
  const appKey = typeof settings.appKey === "string" ? settings.appKey.trim() : "";
  const appSecret = typeof settings.appSecret === "string" ? settings.appSecret.trim() : "";
  if (!appKey || !appSecret) {
    return null;
  }
  return {
    appKey,
    appSecret,
    fingerprint: fingerprintCredentials(appKey, appSecret),
    generation: settings.credentialGeneration,
  };
}

function identityFromSnapshot(snapshot: SettingsSnapshot): CredentialIdentity {
  const settings = snapshot.settings;
  const appKey = typeof settings.appKey === "string" ? settings.appKey.trim() : "";
  const appSecret = typeof settings.appSecret === "string" ? settings.appSecret.trim() : "";
  if (!appKey || !appSecret || !settings.credentialFingerprint) {
    return Object.freeze({
      configured: false,
      credentialGeneration: settings.credentialGeneration,
    });
  }
  return Object.freeze({
    configured: true,
    credentialGeneration: settings.credentialGeneration,
    credentialFingerprint: settings.credentialFingerprint,
  });
}

export class CredentialSession {
  private readonly repository: SettingsRepository;
  private readonly now: () => number;

  constructor(repository: SettingsRepository, options: CredentialSessionOptions = {}) {
    this.repository = repository;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<CredentialIdentity> {
    await this.repository.whenReady();
    const snapshot = await this.repository.update((draft) => {
      const appKey = typeof draft.appKey === "string" ? draft.appKey.trim() : "";
      const appSecret = typeof draft.appSecret === "string" ? draft.appSecret.trim() : "";
      if (!appKey || !appSecret) return;

      const fingerprint = fingerprintCredentials(appKey, appSecret);
      draft.appKey = appKey;
      draft.appSecret = appSecret;
      if (draft.credentialFingerprint === fingerprint) return;

      draft.credentialFingerprint = fingerprint;
      draft.credentialGeneration = incrementCounter(draft.credentialGeneration);
      draft.accessTokenVersion = incrementCounter(draft.accessTokenVersion);
      clearPersistedToken(draft);
    });
    return identityFromSnapshot(snapshot);
  }

  async saveCredentials(appKey: string, appSecret: string): Promise<CredentialIdentity> {
    const normalized = normalizedPair(appKey, appSecret);
    if (!normalized.appKey || !normalized.appSecret) {
      throw noCredentialsError();
    }
    const fingerprint = fingerprintCredentials(normalized.appKey, normalized.appSecret);

    await this.repository.whenReady();
    const snapshot = await this.repository.update((draft) => {
      const sameIdentity = draft.credentialFingerprint === fingerprint &&
        draft.appKey?.trim() === normalized.appKey &&
        draft.appSecret?.trim() === normalized.appSecret;
      draft.appKey = normalized.appKey;
      draft.appSecret = normalized.appSecret;
      if (sameIdentity) return;

      draft.credentialFingerprint = fingerprint;
      draft.credentialGeneration = incrementCounter(draft.credentialGeneration);
      draft.accessTokenVersion = incrementCounter(draft.accessTokenVersion);
      clearPersistedToken(draft);
    });
    return identityFromSnapshot(snapshot);
  }

  async clearCredentials(): Promise<CredentialIdentity> {
    await this.repository.whenReady();
    const snapshot = await this.repository.update((draft) => {
      const hasAuthenticationState = draft.appKey !== undefined ||
        draft.appSecret !== undefined ||
        draft.credentialFingerprint !== undefined ||
        draft.accessToken !== undefined ||
        draft.accessTokenExpiry !== undefined ||
        draft.accessTokenFingerprint !== undefined;
      if (!hasAuthenticationState) return;

      delete draft.appKey;
      delete draft.appSecret;
      delete draft.credentialFingerprint;
      clearPersistedToken(draft);
      draft.credentialGeneration = incrementCounter(draft.credentialGeneration);
      draft.accessTokenVersion = incrementCounter(draft.accessTokenVersion);
    });
    return identityFromSnapshot(snapshot);
  }

  async getPersistedAccessToken(): Promise<AccessTokenLease | null> {
    await this.initialize();
    const settings = this.repository.getSnapshot().settings;
    const credentials = credentialsFromSettings(settings);
    if (!credentials || settings.credentialFingerprint !== credentials.fingerprint) {
      return null;
    }
    if (
      typeof settings.accessToken === "string" &&
      settings.accessToken.length > 0 &&
      typeof settings.accessTokenExpiry === "number" &&
      settings.accessTokenExpiry > this.now() + TOKEN_REFRESH_SAFETY_MS &&
      settings.accessTokenFingerprint === credentials.fingerprint
    ) {
      return Object.freeze({
        token: settings.accessToken,
        expiresAt: settings.accessTokenExpiry,
        credentialGeneration: credentials.generation,
        credentialFingerprint: credentials.fingerprint,
        tokenVersion: settings.accessTokenVersion,
      });
    }

    if (
      typeof settings.accessToken === "string" &&
      settings.accessTokenFingerprint === credentials.fingerprint
    ) {
      await this.invalidateAccessToken({
        credentialGeneration: credentials.generation,
        credentialFingerprint: credentials.fingerprint,
        tokenVersion: settings.accessTokenVersion,
      });
    }
    return null;
  }

  async invalidateAccessToken(expected: AccessTokenExpectation): Promise<boolean> {
    await this.repository.whenReady();
    let invalidated = false;
    await this.repository.update((draft) => {
      const matches = draft.credentialGeneration === expected.credentialGeneration &&
        draft.credentialFingerprint === expected.credentialFingerprint &&
        draft.accessTokenFingerprint === expected.credentialFingerprint &&
        draft.accessTokenVersion === expected.tokenVersion &&
        typeof draft.accessToken === "string";
      if (!matches) return;

      clearPersistedToken(draft);
      draft.accessTokenVersion = incrementCounter(draft.accessTokenVersion);
      invalidated = true;
    });
    return invalidated;
  }
}
