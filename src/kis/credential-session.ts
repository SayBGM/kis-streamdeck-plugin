import { createHash } from "node:crypto";
import { KisError } from "../core/errors.js";
import type { SettingsSnapshot } from "../settings/settings-repository.js";
import type { GlobalSettingsV2 } from "../settings/schema.js";
import { KIS_REST_BASE } from "../types/index.js";

const TOKEN_REFRESH_SAFETY_MS = 5 * 60_000;
const AUTH_ATTEMPT_TIMEOUT_MS = 10_000;
const TOKEN_RATE_LIMIT_DELAY_MS = 60_000;
const APPROVAL_URL = `${KIS_REST_BASE}/oauth2/Approval`;
const TOKEN_URL = `${KIS_REST_BASE}/oauth2/tokenP`;

export interface AuthRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type AuthFetch = (url: string, init: AuthRequestInit) => Promise<unknown>;
export type AuthTimeoutHandle = unknown;

export interface CredentialSettingsPort {
  whenReady(): Promise<SettingsSnapshot>;
  getSnapshot(): SettingsSnapshot;
  update(updater: (draft: GlobalSettingsV2) => void): Promise<SettingsSnapshot>;
}

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

/**
 * REST 전송 계층만 사용하는 내부 lease입니다. 진단/PI 경계에는 이 값을
 * 전달하지 않고, 세대와 fingerprint로 응답 수명을 검증합니다.
 */
export interface RestAuthorizationLease extends AccessTokenLease {
  readonly appKey: string;
  readonly appSecret: string;
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
  readonly fetch?: AuthFetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly setTimeout?: (
    callback: () => void,
    milliseconds: number,
  ) => AuthTimeoutHandle;
  readonly clearTimeout?: (handle: AuthTimeoutHandle) => void;
}

interface NormalizedCredentials {
  readonly appKey: string;
  readonly appSecret: string;
  readonly fingerprint: string;
  readonly generation: number;
}

interface AuthResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

interface IssuedAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

const TIMEOUT_SENTINEL = Object.freeze({ timeout: true });
const NETWORK_SENTINEL = Object.freeze({ network: true });

function defaultFetch(url: string, init: AuthRequestInit): Promise<unknown> {
  return fetch(url, init);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultSetTimeout(
  callback: () => void,
  milliseconds: number,
): AuthTimeoutHandle {
  return setTimeout(callback, milliseconds);
}

function defaultClearTimeout(handle: AuthTimeoutHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function authBoundaryError(
  code: "NO_CREDENTIALS" | "AUTH_REJECTED" | "AUTH_RATE_LIMITED" | "NETWORK" | "TIMEOUT" | "PROTOCOL",
  retryable: boolean,
  safeMessage: string,
  httpStatus?: number,
): KisError {
  return Object.freeze(new KisError({
    code,
    scope: "auth",
    retryable,
    safeMessage,
    ...(httpStatus === undefined ? {} : { metadata: { httpStatus } }),
  }));
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
  return authBoundaryError(
    "NO_CREDENTIALS",
    false,
    "KIS API 자격증명이 비어 있습니다.",
  );
}

function invalidAuthInputError(): KisError {
  return authBoundaryError(
    "PROTOCOL",
    false,
    "인증 요청 입력 형식이 올바르지 않습니다.",
  );
}

function settingsReadinessError(): KisError {
  return Object.freeze(new KisError({
    code: "SETTINGS",
    scope: "settings",
    retryable: true,
    safeMessage: "인증 설정을 안전하게 불러오지 못했습니다.",
  }));
}

function incrementCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw settingsCounterError();
  }
  return value + 1;
}

function normalizedPair(appKey: unknown, appSecret: unknown): {
  appKey: string;
  appSecret: string;
} {
  if (typeof appKey !== "string" || typeof appSecret !== "string") {
    throw noCredentialsError();
  }
  return { appKey: appKey.trim(), appSecret: appSecret.trim() };
}

export function fingerprintCredentials(appKey: unknown, appSecret: unknown): string {
  const normalized = normalizedPair(appKey, appSecret);
  if (!normalized.appKey || !normalized.appSecret) {
    throw noCredentialsError();
  }
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

function hasAuthenticationArtifacts(settings: Readonly<GlobalSettingsV2>): boolean {
  return settings.appKey !== undefined ||
    settings.appSecret !== undefined ||
    settings.credentialFingerprint !== undefined ||
    settings.accessToken !== undefined ||
    settings.accessTokenExpiry !== undefined ||
    settings.accessTokenFingerprint !== undefined;
}

function hasInvalidTokenArtifacts(
  settings: Readonly<GlobalSettingsV2>,
  credentialFingerprint: string,
): boolean {
  const hasAnyTokenArtifact = settings.accessToken !== undefined ||
    settings.accessTokenExpiry !== undefined ||
    settings.accessTokenFingerprint !== undefined;
  if (!hasAnyTokenArtifact) return false;
  return typeof settings.accessToken !== "string" ||
    settings.accessToken.length === 0 ||
    typeof settings.accessTokenExpiry !== "number" ||
    !Number.isFinite(settings.accessTokenExpiry) ||
    settings.accessTokenFingerprint !== credentialFingerprint;
}

function credentialBootstrapNeeded(settings: Readonly<GlobalSettingsV2>): boolean {
  const appKey = typeof settings.appKey === "string" ? settings.appKey.trim() : "";
  const appSecret = typeof settings.appSecret === "string" ? settings.appSecret.trim() : "";
  if (!appKey || !appSecret) return hasAuthenticationArtifacts(settings);

  const fingerprint = fingerprintCredentials(appKey, appSecret);
  return settings.appKey !== appKey ||
    settings.appSecret !== appSecret ||
    settings.credentialFingerprint !== fingerprint ||
    hasInvalidTokenArtifacts(settings, fingerprint);
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

function safePayload(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const payload = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
      payload[key] = descriptor.value;
    }
    return payload;
  } catch {
    return undefined;
  }
}

function credentialsMatch(
  draft: Readonly<GlobalSettingsV2>,
  expected: NormalizedCredentials,
): boolean {
  return draft.credentialGeneration === expected.generation &&
    draft.credentialFingerprint === expected.fingerprint &&
    draft.appKey?.trim() === expected.appKey &&
    draft.appSecret?.trim() === expected.appSecret;
}

function credentialFlightKey(credentials: NormalizedCredentials): string {
  return `${credentials.generation}:${credentials.fingerprint}`;
}

function parseAccessTokenExpectation(value: unknown): AccessTokenExpectation {
  if (typeof value !== "object" || value === null) {
    throw invalidAuthInputError();
  }

  let prototype: object | null;
  let symbols: symbol[];
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    if (Array.isArray(value)) throw invalidAuthInputError();
    prototype = Object.getPrototypeOf(value) as object | null;
    symbols = Object.getOwnPropertySymbols(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalidAuthInputError();
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length > 0 ||
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    )
  ) {
    throw invalidAuthInputError();
  }

  const generation = descriptors.credentialGeneration?.value;
  const fingerprint = descriptors.credentialFingerprint?.value;
  const tokenVersion = descriptors.tokenVersion?.value;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof fingerprint !== "string" ||
    fingerprint.trim().length === 0 ||
    typeof tokenVersion !== "number" ||
    !Number.isSafeInteger(tokenVersion) ||
    tokenVersion < 0
  ) {
    throw invalidAuthInputError();
  }
  return {
    credentialGeneration: generation,
    credentialFingerprint: fingerprint,
    tokenVersion,
  };
}

export class CredentialSession {
  private readonly repository: CredentialSettingsPort;
  private readonly now: () => number;
  private readonly fetch: AuthFetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly setTimeout: CredentialSessionOptions["setTimeout"];
  private readonly clearTimeout: CredentialSessionOptions["clearTimeout"];
  private readonly accessTokenFlights = new Map<string, Promise<AccessTokenLease>>();
  private readonly approvalKeyFlights = new Map<string, Promise<ApprovalKeyLease>>();
  private initialization?: Promise<void>;

  constructor(repository: CredentialSettingsPort, options: CredentialSessionOptions = {}) {
    this.repository = repository;
    this.now = options.now ?? Date.now;
    this.fetch = options.fetch ?? defaultFetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.setTimeout = options.setTimeout ?? defaultSetTimeout;
    this.clearTimeout = options.clearTimeout ?? defaultClearTimeout;
  }

  async initialize(): Promise<CredentialIdentity> {
    await this.ensureInitialized();
    return identityFromSnapshot(this.repository.getSnapshot());
  }

  private ensureInitialized(): Promise<void> {
    if (this.initialization) return this.initialization;

    const initialization = this.bootstrap().catch((error: unknown) => {
      if (this.initialization === initialization) {
        this.initialization = undefined;
      }
      throw error;
    });
    this.initialization = initialization;
    return initialization;
  }

  private async bootstrap(): Promise<void> {
    await this.repository.whenReady();
    const current = this.repository.getSnapshot();
    if (
      current.status.baseKnown &&
      !current.status.persistenceDegraded &&
      !credentialBootstrapNeeded(current.settings)
    ) {
      return;
    }

    const snapshot = await this.repository.update((draft) => {
      const appKey = typeof draft.appKey === "string" ? draft.appKey.trim() : "";
      const appSecret = typeof draft.appSecret === "string" ? draft.appSecret.trim() : "";
      if (!appKey || !appSecret) {
        if (!hasAuthenticationArtifacts(draft)) return;

        delete draft.appKey;
        delete draft.appSecret;
        delete draft.credentialFingerprint;
        clearPersistedToken(draft);
        draft.credentialGeneration = incrementCounter(draft.credentialGeneration);
        draft.accessTokenVersion = incrementCounter(draft.accessTokenVersion);
        return;
      }

      const fingerprint = fingerprintCredentials(appKey, appSecret);
      draft.appKey = appKey;
      draft.appSecret = appSecret;
      if (draft.credentialFingerprint === fingerprint) {
        if (hasInvalidTokenArtifacts(draft, fingerprint)) {
          clearPersistedToken(draft);
          draft.accessTokenVersion = incrementCounter(draft.accessTokenVersion);
        }
        return;
      }

      draft.credentialFingerprint = fingerprint;
      draft.credentialGeneration = incrementCounter(draft.credentialGeneration);
      draft.accessTokenVersion = incrementCounter(draft.accessTokenVersion);
      clearPersistedToken(draft);
    });
    if (!snapshot.status.baseKnown || snapshot.status.persistenceDegraded) {
      throw settingsReadinessError();
    }
  }

  async saveCredentials(appKey: unknown, appSecret: unknown): Promise<CredentialIdentity> {
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

  async invalidateAccessToken(expectedInput: unknown): Promise<boolean> {
    const expected = parseAccessTokenExpectation(expectedInput);
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

  async getAccessToken(): Promise<AccessTokenLease> {
    const persisted = await this.getPersistedAccessToken();
    if (persisted) return persisted;

    const credentials = await this.currentCredentials();
    const key = credentialFlightKey(credentials);
    const existing = this.accessTokenFlights.get(key);
    if (existing) return existing;

    const flight = this.issueAndPersistAccessToken(credentials);
    this.accessTokenFlights.set(key, flight);
    void flight.then(
      () => this.deleteFlight(this.accessTokenFlights, key, flight),
      () => this.deleteFlight(this.accessTokenFlights, key, flight),
    );
    return flight;
  }

  async withRestAuthorization<T>(
    operation: (authorization: RestAuthorizationLease) => Promise<T>,
  ): Promise<T> {
    if (typeof operation !== "function") throw invalidAuthInputError();
    const authorization = await this.createRestAuthorization();
    return operation(authorization);
  }

  private async createRestAuthorization(): Promise<RestAuthorizationLease> {
    const token = await this.getAccessToken();
    const settings = this.repository.getSnapshot().settings;
    const credentials = credentialsFromSettings(settings);
    if (
      !credentials ||
      token.credentialGeneration !== credentials.generation ||
      token.credentialFingerprint !== credentials.fingerprint ||
      settings.credentialFingerprint !== credentials.fingerprint ||
      settings.accessToken !== token.token ||
      settings.accessTokenExpiry !== token.expiresAt ||
      settings.accessTokenFingerprint !== token.credentialFingerprint ||
      settings.accessTokenVersion !== token.tokenVersion
    ) {
      throw authBoundaryError(
        "AUTH_REJECTED",
        true,
        "자격증명이 변경되어 이전 인증 결과를 폐기했습니다.",
      );
    }
    return Object.freeze({
      appKey: credentials.appKey,
      appSecret: credentials.appSecret,
      ...token,
    });
  }

  async getApprovalKey(): Promise<ApprovalKeyLease> {
    const credentials = await this.currentCredentials();
    const key = credentialFlightKey(credentials);
    const existing = this.approvalKeyFlights.get(key);
    if (existing) return existing;

    const flight = this.issueApprovalKey(credentials);
    this.approvalKeyFlights.set(key, flight);
    void flight.then(
      () => this.deleteFlight(this.approvalKeyFlights, key, flight),
      () => this.deleteFlight(this.approvalKeyFlights, key, flight),
    );
    return flight;
  }

  private deleteFlight<T>(
    flights: Map<string, Promise<T>>,
    key: string,
    flight: Promise<T>,
  ): void {
    if (flights.get(key) === flight) flights.delete(key);
  }

  private async currentCredentials(): Promise<NormalizedCredentials> {
    await this.initialize();
    const credentials = credentialsFromSettings(this.repository.getSnapshot().settings);
    if (!credentials) throw noCredentialsError();
    return credentials;
  }

  private async refreshAndCheckCredentials(
    expected: NormalizedCredentials,
  ): Promise<void> {
    await this.repository.whenReady();
    const snapshot = await this.repository.update(() => {});
    if (!credentialsMatch(snapshot.settings, expected)) {
      throw authBoundaryError(
        "AUTH_REJECTED",
        true,
        "자격증명이 변경되어 이전 인증 결과를 폐기했습니다.",
      );
    }
  }

  private async issueAndPersistAccessToken(
    credentials: NormalizedCredentials,
  ): Promise<AccessTokenLease> {
    const issued = await this.issueWithRateLimitRetry(
      credentials,
      () => this.issueAccessTokenAttempt(credentials),
    );

    const issuedAt = this.now();
    const expiresAt = issuedAt + issued.expiresInSeconds * 1_000;
    if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
      throw authBoundaryError("PROTOCOL", false, "접근 토큰 만료 형식이 올바르지 않습니다.");
    }

    let accepted = false;
    let tokenVersion = 0;
    await this.repository.update((draft) => {
      if (!credentialsMatch(draft, credentials)) return;
      tokenVersion = incrementCounter(draft.accessTokenVersion);
      draft.accessToken = issued.token;
      draft.accessTokenExpiry = expiresAt;
      draft.accessTokenFingerprint = credentials.fingerprint;
      draft.accessTokenVersion = tokenVersion;
      accepted = true;
    });
    if (!accepted) {
      throw authBoundaryError(
        "AUTH_REJECTED",
        true,
        "자격증명이 변경되어 이전 인증 결과를 폐기했습니다.",
      );
    }

    return Object.freeze({
      token: issued.token,
      expiresAt,
      credentialGeneration: credentials.generation,
      credentialFingerprint: credentials.fingerprint,
      tokenVersion,
    });
  }

  private async issueWithRateLimitRetry<T>(
    credentials: NormalizedCredentials,
    issue: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await issue();
      } catch (error) {
        if (!(error instanceof KisError) || error.code !== "AUTH_RATE_LIMITED") {
          throw error;
        }
        if (attempt === 1) throw error;
        try {
          await this.sleep(TOKEN_RATE_LIMIT_DELAY_MS);
        } catch {
          throw authBoundaryError(
            "NETWORK",
            true,
            "인증 재시도 대기 중 오류가 발생했습니다.",
          );
        }
        await this.refreshAndCheckCredentials(credentials);
      }
    }
    throw authBoundaryError("PROTOCOL", true, "인증 응답을 처리하지 못했습니다.");
  }

  private async issueAccessTokenAttempt(
    credentials: NormalizedCredentials,
  ): Promise<IssuedAccessToken> {
    const response = await this.postJson(TOKEN_URL, {
      grant_type: "client_credentials",
      appkey: credentials.appKey,
      appsecret: credentials.appSecret,
    });
    this.assertSuccessfulResponse(response);
    const token = response.payload?.access_token;
    const expiresInSeconds = response.payload?.expires_in;
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      typeof expiresInSeconds !== "number" ||
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds <= 0
    ) {
      throw authBoundaryError("PROTOCOL", false, "접근 토큰 응답 형식이 올바르지 않습니다.");
    }
    return { token, expiresInSeconds };
  }

  private async issueApprovalKey(
    credentials: NormalizedCredentials,
  ): Promise<ApprovalKeyLease> {
    const approvalKey = await this.issueWithRateLimitRetry(
      credentials,
      () => this.issueApprovalKeyAttempt(credentials),
    );
    await this.refreshAndCheckCredentials(credentials);
    return Object.freeze({
      approvalKey,
      credentialGeneration: credentials.generation,
      credentialFingerprint: credentials.fingerprint,
    });
  }

  private async issueApprovalKeyAttempt(
    credentials: NormalizedCredentials,
  ): Promise<string> {
    const response = await this.postJson(APPROVAL_URL, {
      grant_type: "client_credentials",
      appkey: credentials.appKey,
      secretkey: credentials.appSecret,
    });
    this.assertSuccessfulResponse(response);
    const approvalKey = response.payload?.approval_key;
    if (typeof approvalKey !== "string" || approvalKey.length === 0) {
      throw authBoundaryError("PROTOCOL", false, "승인 키 응답 형식이 올바르지 않습니다.");
    }
    return approvalKey;
  }

  private assertSuccessfulResponse(response: AuthResponse): void {
    if (response.ok) {
      if (!response.payload) {
        throw authBoundaryError("PROTOCOL", false, "인증 응답 형식이 올바르지 않습니다.");
      }
      return;
    }
    if (response.payload?.error_code === "EGW00133") {
      throw authBoundaryError(
        "AUTH_RATE_LIMITED",
        true,
        "KIS 인증 요청 제한에 도달했습니다.",
        response.status,
      );
    }
    throw authBoundaryError(
      "AUTH_REJECTED",
      response.status === 429 || response.status >= 500,
      "KIS 인증 요청이 거부되었습니다.",
      response.status,
    );
  }

  private async postJson(
    url: string,
    body: Readonly<Record<string, string>>,
  ): Promise<AuthResponse> {
    const controller = new AbortController();
    let handle: AuthTimeoutHandle;
    let rejectTimeout!: (reason: unknown) => void;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    try {
      handle = this.setTimeout!(() => {
        try {
          controller.abort();
        } catch {
          // Timeout still wins even when a host AbortController behaves abnormally.
        }
        rejectTimeout(TIMEOUT_SENTINEL);
      }, AUTH_ATTEMPT_TIMEOUT_MS);
    } catch {
      throw authBoundaryError("NETWORK", true, "인증 요청 타이머를 시작하지 못했습니다.");
    }

    try {
      const request = Promise.resolve().then(async () => {
        let rawResponse: unknown;
        try {
          rawResponse = await this.fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch {
          throw NETWORK_SENTINEL;
        }
        return this.decodeAuthResponse(rawResponse);
      });
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error === TIMEOUT_SENTINEL) {
        throw authBoundaryError("TIMEOUT", true, "KIS 인증 요청 시간이 초과되었습니다.");
      }
      if (error instanceof KisError) throw error;
      throw authBoundaryError("NETWORK", true, "KIS 인증 서버에 연결하지 못했습니다.");
    } finally {
      try {
        this.clearTimeout!(handle!);
      } catch {
        // Timer cleanup errors must not replace the safe boundary result.
      }
    }
  }

  private async decodeAuthResponse(rawResponse: unknown): Promise<AuthResponse> {
    let ok: unknown;
    let status: unknown;
    let json: unknown;
    try {
      if (typeof rawResponse !== "object" || rawResponse === null) {
        throw new TypeError("invalid response");
      }
      const candidate = rawResponse as { ok?: unknown; status?: unknown; json?: unknown };
      ok = candidate.ok;
      status = candidate.status;
      json = candidate.json;
    } catch {
      throw authBoundaryError("PROTOCOL", false, "인증 HTTP 응답 형식이 올바르지 않습니다.");
    }
    if (
      typeof ok !== "boolean" ||
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599
    ) {
      throw authBoundaryError("PROTOCOL", false, "인증 HTTP 응답 형식이 올바르지 않습니다.");
    }
    if (ok !== (status >= 200 && status < 300)) {
      throw authBoundaryError("PROTOCOL", false, "인증 HTTP 상태가 서로 일치하지 않습니다.");
    }

    let payload: Readonly<Record<string, unknown>> | undefined;
    if (typeof json === "function") {
      try {
        payload = safePayload(await Reflect.apply(json, rawResponse, []));
      } catch {
        if (ok) {
          throw authBoundaryError("PROTOCOL", false, "인증 JSON 응답을 읽지 못했습니다.");
        }
      }
    } else if (ok) {
      throw authBoundaryError("PROTOCOL", false, "인증 JSON 응답 형식이 올바르지 않습니다.");
    }
    return { ok, status, ...(payload ? { payload } : {}) };
  }
}
