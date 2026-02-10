import { KIS_REST_BASE, type GlobalSettings } from "../types/index.js";
import { logger } from "../utils/logger.js";

const APPROVAL_URL = `${KIS_REST_BASE}/oauth2/Approval`;
const TOKEN_URL = `${KIS_REST_BASE}/oauth2/tokenP`;

// ─── Access Token 캐시 ───
let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0;
let cachedSettings: GlobalSettings | null = null;

/**
 * WebSocket 접속을 위한 approval_key 발급
 */
export async function getApprovalKey(
  settings: GlobalSettings
): Promise<string> {
  logger.info("[Auth] approval_key 발급 요청 시작");

  const response = await fetch(APPROVAL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: settings.appKey,
      secretkey: settings.appSecret,
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

  // 캐시된 토큰이 유효하면 재사용 (만료 1시간 전까지)
  if (
    cachedAccessToken &&
    cachedTokenExpiry > now + 3600_000 &&
    cachedSettings?.appKey === settings.appKey
  ) {
    return cachedAccessToken;
  }

  logger.info("[Auth] access_token 발급 요청 시작");

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: settings.appKey,
        appsecret: settings.appSecret,
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
          
          // 1분(60초) 대기 후 재시도
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          
          logger.info("[Auth] access_token 재시도 시작");
          return await getAccessToken(settings);
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

    // 캐시 저장
    cachedAccessToken = data.access_token;
    cachedTokenExpiry = now + data.expires_in * 1000;
    cachedSettings = settings;

    logger.info(
      `[Auth] access_token 발급 성공 (만료: ${Math.round(data.expires_in / 3600)}시간)`
    );
    return data.access_token;
  } catch (err) {
    // 재시도 중 발생한 에러는 그대로 throw
    throw err;
  }
}
