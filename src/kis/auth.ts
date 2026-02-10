import { KIS_REST_BASE, type GlobalSettings } from "../types/index.js";
import { logger } from "../utils/logger.js";

const APPROVAL_URL = `${KIS_REST_BASE}/oauth2/Approval`;
const TOKEN_URL = `${KIS_REST_BASE}/oauth2/tokenP`;

const TOKEN_REFRESH_SAFETY_MS = 5 * 60_000; // 가능한 오래 재사용하되, 만료 직전 레이스를 피하기 위한 여유

// ─── Access Token 캐시 ───
let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0;
let cachedSettings: { appKey: string; appSecret: string } | null = null;

// 동시 토큰 발급 요청을 1개로 합쳐 1분당 1회 제한(EGW00133)을 피합니다.
let accessTokenInFlight: Promise<string> | null = null;
let accessTokenInFlightKey: string | null = null;

type TokenPersistPayload = {
  token: string;
  expiryEpochMs: number;
  settings: { appKey: string; appSecret: string };
};

const persistListeners = new Set<(p: TokenPersistPayload) => void | Promise<void>>();

function requireCredentials(
  settings: GlobalSettings
): asserts settings is GlobalSettings & { appKey: string; appSecret: string } {
  if (!settings.appKey?.trim() || !settings.appSecret?.trim()) {
    throw new Error("appKey/appSecret이 없습니다");
  }
}

function normalizedCredentials(settings: GlobalSettings): { appKey: string; appSecret: string } {
  requireCredentials(settings);
  return { appKey: settings.appKey.trim(), appSecret: settings.appSecret.trim() };
}

function settingsKey(settings: GlobalSettings): string {
  // 키/시크릿 조합이 바뀌면 토큰도 새로 받아야 합니다.
  const { appKey, appSecret } = normalizedCredentials(settings);
  return `${appKey}\n${appSecret}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function onAccessTokenUpdated(
  listener: (p: TokenPersistPayload) => void | Promise<void>
): () => void {
  persistListeners.add(listener);
  return () => persistListeners.delete(listener);
}

function notifyAccessTokenUpdated(p: TokenPersistPayload): void {
  for (const l of persistListeners) {
    // 저장 실패는 토큰 발급/사용 자체를 막을 이유가 없으므로 fire-and-forget
    Promise.resolve()
      .then(() => l(p))
      .catch((e) => logger.debug("[Auth] access_token 저장 콜백 실패(무시):", e));
  }
}

export function hydrateAccessTokenFromGlobalSettings(settings: GlobalSettings): void {
  const token = typeof settings.accessToken === "string" ? settings.accessToken : null;
  const expiry =
    typeof settings.accessTokenExpiry === "number" ? settings.accessTokenExpiry : 0;

  if (!token || !expiry) return;
  if (!settings.appKey?.trim() || !settings.appSecret?.trim()) return;

  const now = Date.now();
  // 만료가 임박했거나 이미 만료면 사용하지 않습니다.
  if (expiry <= now + TOKEN_REFRESH_SAFETY_MS) return;

  const { appKey, appSecret } = normalizedCredentials(settings);
  cachedAccessToken = token;
  cachedTokenExpiry = expiry;
  cachedSettings = { appKey, appSecret };
}

export function clearAccessTokenCache(): void {
  cachedAccessToken = null;
  cachedTokenExpiry = 0;
  cachedSettings = null;
  accessTokenInFlight = null;
  accessTokenInFlightKey = null;
}

/**
 * WebSocket 접속을 위한 approval_key 발급
 */
export async function getApprovalKey(
  settings: GlobalSettings
): Promise<string> {
  const { appKey, appSecret } = normalizedCredentials(settings);
  logger.info("[Auth] approval_key 발급 요청 시작");

  const response = await fetch(APPROVAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: appKey,
      secretkey: appSecret,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`approval_key 발급 실패 (${response.status}): ${text}`);
  }

  const data = (await response.json()) as { approval_key: string };
  if (!data.approval_key) {
    throw new Error("응답에 approval_key가 없습니다");
  }

  logger.info("[Auth] approval_key 발급 성공");
  return data.approval_key;
}

/**
 * REST API 호출을 위한 접근토큰(access_token) 발급
 *
 * 토큰은 24시간 유효하며, 캐싱하여 재사용합니다.
 * 만료 1시간 전에 자동 갱신합니다.
 * 
 * 1분당 1회 제한(EGW00133) 에러 발생 시 1분 후 자동 재시도합니다.
 */
export async function getAccessToken(
  settings: GlobalSettings
): Promise<string> {
  const now = Date.now();
  const { appKey, appSecret } = normalizedCredentials(settings);
  const key = `${appKey}\n${appSecret}`;

  // 캐시된 토큰이 유효하면 재사용 (만료 1시간 전까지)
  if (
    cachedAccessToken &&
    cachedTokenExpiry > now + TOKEN_REFRESH_SAFETY_MS &&
    cachedSettings?.appKey === appKey &&
    cachedSettings?.appSecret === appSecret
  ) {
    return cachedAccessToken;
  }

  if (accessTokenInFlight && accessTokenInFlightKey === key) {
    return accessTokenInFlight;
  }

  const p = (async () => {
    logger.info("[Auth] access_token 발급 요청 시작");

    while (true) {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: appKey,
          appsecret: appSecret,
        }),
      });

      if (!response.ok) {
        const text = await response.text();

        // 1분당 1회 제한 에러 감지
        try {
          const errorData = JSON.parse(text) as {
            error_code?: string;
            error_description?: string;
          };

          if (errorData.error_code === "EGW00133") {
            logger.warn(
              "[Auth] access_token 발급 제한 (1분당 1회), 1분 후 재시도 예정"
            );
            await sleep(60_000);
            continue;
          }
        } catch {
          // JSON 파싱 실패 시 원래 에러 그대로 throw
        }

        throw new Error(`access_token 발급 실패 (${response.status}): ${text}`);
      }

      const data = (await response.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
      };

      if (!data.access_token) {
        throw new Error("응답에 access_token이 없습니다");
      }

      // 캐시 저장 (응답 시각 기준)
      const issuedAt = Date.now();
      cachedAccessToken = data.access_token;
      cachedTokenExpiry = issuedAt + data.expires_in * 1000;
      cachedSettings = { appKey, appSecret };

      notifyAccessTokenUpdated({
        token: cachedAccessToken,
        expiryEpochMs: cachedTokenExpiry,
        settings: cachedSettings,
      });

      logger.info(
        `[Auth] access_token 발급 성공 (만료: ${Math.round(data.expires_in / 3600)}시간)`
      );
      return data.access_token;
    }
  })();

  accessTokenInFlight = p;
  accessTokenInFlightKey = key;
  p.finally(() => {
    if (accessTokenInFlight === p) {
      accessTokenInFlight = null;
      accessTokenInFlightKey = null;
    }
  });

  return p;
}
