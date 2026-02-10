import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { kisWebSocket } from "./kis/websocket-manager.js";
import { kisGlobalSettings } from "./kis/settings-store.js";
import { DomesticStockAction } from "./actions/domestic-stock.js";
import { OverseasStockAction } from "./actions/overseas-stock.js";
import type { GlobalSettings } from "./types/index.js";
import { logger } from "./utils/logger.js";
import {
  clearAccessTokenCache,
  hydrateAccessTokenFromGlobalSettings,
  onAccessTokenUpdated,
} from "./kis/auth.js";

// 로깅 설정
streamDeck.logger.setLevel(LogLevel.DEBUG);

function hasCredentials(
  settings: GlobalSettings
): settings is GlobalSettings & { appKey: string; appSecret: string } {
  return !!settings.appKey && !!settings.appSecret;
}

function credentialKey(settings: { appKey: string; appSecret: string }): string {
  return `${settings.appKey}\n${settings.appSecret}`;
}

let lastAppliedCredentialKey: string | null = null;
let isInternalGlobalSettingsWrite = false;

/**
 * 전역 설정 적용 (공통)
 */
function applyGlobalSettings(settings: GlobalSettings): void {
  // REST API용 설정 저장소에도 저장
  kisGlobalSettings.set(settings);

  hydrateAccessTokenFromGlobalSettings(settings);

  if (!hasCredentials(settings)) {
    return;
  }

  const credKey = credentialKey(settings);
  if (lastAppliedCredentialKey === credKey) {
    return; // 토큰/기타 필드 업데이트로 인한 이벤트면 WS 업데이트는 스킵
  }

  // 키/시크릿이 바뀌었으면 토큰 캐시도 초기화(다른 계정 토큰 재사용 방지)
  clearAccessTokenCache();
  lastAppliedCredentialKey = credKey;

  kisWebSocket.updateSettings(settings).catch((err) => {
    logger.error("[Plugin] WebSocket 업데이트 실패:", err);
  });
}

// ─── 전역 설정 변경 감지 ───
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  logger.info("[Plugin] onDidReceiveGlobalSettings 호출됨");

  if (isInternalGlobalSettingsWrite) {
    return;
  }

  const rawEv = ev as unknown as Record<string, unknown>;
  const settings: GlobalSettings =
    (rawEv.settings as GlobalSettings) ?? (rawEv as unknown as GlobalSettings);

  logger.info(
    "[Plugin] 전역 설정:",
    settings.appKey ? `appKey=${settings.appKey.substring(0, 6)}...` : "appKey 없음",
    settings.appSecret ? "appSecret 있음" : "appSecret 없음"
  );

  // 키/시크릿이 바뀌는 순간엔 이전 토큰이 붙어있으면 위험(계정 불일치)하므로 제거합니다.
  if (hasCredentials(settings)) {
    const incomingCredKey = credentialKey(settings);
    if (
      lastAppliedCredentialKey &&
      lastAppliedCredentialKey !== incomingCredKey &&
      typeof settings.accessToken === "string"
    ) {
      isInternalGlobalSettingsWrite = true;
      streamDeck.settings
        .setGlobalSettings({
          ...settings,
          accessToken: undefined,
          accessTokenExpiry: undefined,
        })
        .catch((e) => logger.debug("[Plugin] 이전 access_token 제거 실패(무시):", e))
        .finally(() => {
          isInternalGlobalSettingsWrite = false;
        });
    }
  }

  applyGlobalSettings(settings);
});

// ─── 액션 등록 ───
const domesticAction = new DomesticStockAction();
const overseasAction = new OverseasStockAction();

streamDeck.actions.registerAction(domesticAction);
streamDeck.actions.registerAction(overseasAction);

logger.info("[Plugin] 액션 등록 완료");

// ─── 초기화 ───
async function initialize(): Promise<void> {
  logger.info("[Plugin] initialize() 시작");

  // 토큰이 갱신되면 Global Settings에 저장해 재시작 후에도 재사용합니다.
  onAccessTokenUpdated(async (p) => {
    try {
      const current = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
      if (!hasCredentials(current)) return;
      if (credentialKey(current) !== credentialKey(p.settings)) return;

      // 내부 저장으로 인한 전역설정 이벤트에서는 WS 갱신을 건너뛰도록 가드
      isInternalGlobalSettingsWrite = true;
      await streamDeck.settings.setGlobalSettings({
        ...current,
        accessToken: p.token,
        accessTokenExpiry: p.expiryEpochMs,
      });
    } catch (e) {
      logger.debug("[Plugin] access_token 저장 실패(무시):", e);
    } finally {
      isInternalGlobalSettingsWrite = false;
    }
  });

  try {
    const globalSettings =
      await streamDeck.settings.getGlobalSettings<GlobalSettings>();

    logger.info(
      "[Plugin] getGlobalSettings 결과:",
      globalSettings.appKey ? "appKey 있음" : "appKey 없음"
    );

    applyGlobalSettings(globalSettings);
    if (hasCredentials(globalSettings)) {
      logger.info("[Plugin] 초기 설정 완료");
    } else {
      logger.warn("[Plugin] 전역 설정이 비어있습니다");
    }
  } catch (err) {
    logger.error("[Plugin] 초기화 실패:", err);
  }
}

// ─── Stream Deck 연결 ───
streamDeck.connect().then(() => {
  logger.info("[Plugin] Stream Deck 연결 완료");
  initialize();
});
