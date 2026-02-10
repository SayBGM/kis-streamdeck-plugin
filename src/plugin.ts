import streamDeck, { LogLevel } from "@elgato/streamdeck";
import { kisWebSocket } from "./kis/websocket-manager.js";
import { kisGlobalSettings } from "./kis/settings-store.js";
import { DomesticStockAction } from "./actions/domestic-stock.js";
import { OverseasStockAction } from "./actions/overseas-stock.js";
import type { GlobalSettings } from "./types/index.js";
import { logger } from "./utils/logger.js";

// 로깅 설정
streamDeck.logger.setLevel(LogLevel.DEBUG);

/**
 * 전역 설정 적용 (공통)
 */
function applyGlobalSettings(settings: GlobalSettings): void {
  // REST API용 설정 저장소에도 저장
  kisGlobalSettings.set(settings);

  // WebSocket 설정 업데이트
  kisWebSocket.updateSettings(settings).catch((err) => {
    logger.error("[Plugin] WebSocket 업데이트 실패:", err);
  });
}

// ─── 전역 설정 변경 감지 ───
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  logger.info("[Plugin] onDidReceiveGlobalSettings 호출됨");

  const rawEv = ev as unknown as Record<string, unknown>;
  const settings: GlobalSettings =
    (rawEv.settings as GlobalSettings) ?? (rawEv as unknown as GlobalSettings);

  logger.info(
    "[Plugin] 전역 설정:",
    settings.appKey ? `appKey=${settings.appKey.substring(0, 6)}...` : "appKey 없음",
    settings.appSecret ? "appSecret 있음" : "appSecret 없음"
  );

  if (settings.appKey && settings.appSecret) {
    applyGlobalSettings(settings);
  } else {
    logger.warn("[Plugin] App Key 또는 App Secret 비어있음");
  }
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

  try {
    const globalSettings =
      await streamDeck.settings.getGlobalSettings<GlobalSettings>();

    logger.info(
      "[Plugin] getGlobalSettings 결과:",
      globalSettings.appKey ? "appKey 있음" : "appKey 없음"
    );

    if (globalSettings.appKey && globalSettings.appSecret) {
      applyGlobalSettings(globalSettings);
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
