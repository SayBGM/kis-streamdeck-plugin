import {
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
} from "@elgato/streamdeck";
import { kisWebSocket, type DataCallback, type SubscribeSuccessCallback } from "../kis/websocket-manager.js";
import { parseDomesticData } from "../kis/domestic-parser.js";
import { fetchDomesticPrice } from "../kis/rest-price.js";
import {
  renderStockCard,
  renderWaitingCard,
  renderConnectedCard,
  renderSetupCard,
  svgToDataUri,
} from "../renderer/stock-card.js";
import {
  TR_ID_DOMESTIC,
  type DomesticStockSettings,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

const INITIAL_PRICE_RETRY_DELAY_MS = 4000;

export class DomesticStockAction extends SingletonAction<DomesticStockSettings> {
  override readonly manifestId = "com.kis.streamdeck.domestic-stock";

  private callbackMap = new Map<
    string,
    { trKey: string; callback: DataCallback }
  >();
  private hasInitialPrice = new Set<string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshInFlight = new Set<string>();

  override async onWillAppear(
    ev: WillAppearEvent<DomesticStockSettings>
  ): Promise<void> {
    const settings = ev.payload.settings;
    const stockCode = settings.stockCode?.trim();
    const stockName = settings.stockName?.trim() || stockCode || "";

    logger.info(`[국내] onWillAppear: code=${stockCode}, name=${stockName}`);

    if (!stockCode) {
      await ev.action.setImage(svgToDataUri(renderSetupCard("종목코드를 설정하세요")));
      return;
    }

    await ev.action.setImage(svgToDataUri(renderWaitingCard(stockName, "domestic")));

    // 마지막 체결가를 먼저 표시한 뒤 WebSocket 구독
    const hasSnapshot = await this.fetchAndShowPrice(ev, stockCode, stockName);
    if (hasSnapshot) {
      this.hasInitialPrice.add(ev.action.id);
    } else {
      this.hasInitialPrice.delete(ev.action.id);
      this.scheduleInitialPriceRetry(ev, stockCode, stockName);
    }

    // WebSocket 구독
    const callback: DataCallback = (_trId, _trKey, fields) => {
      const data = parseDomesticData(fields, stockName);
      const svg = renderStockCard(data, "domestic");
      ev.action.setImage(svgToDataUri(svg));
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[국내] 구독 성공: ${stockCode}`);
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(svgToDataUri(renderConnectedCard(stockName, "domestic")));
      }
    };

    this.callbackMap.set(ev.action.id, { trKey: stockCode, callback });

    try {
      await kisWebSocket.subscribe(TR_ID_DOMESTIC, stockCode, callback, onSuccess);
      logger.info(`[국내] 구독 요청 완료: ${stockCode}`);
    } catch (err) {
      logger.error(`[국내] 구독 실패: ${stockCode}`, err);
    }
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<DomesticStockSettings>
  ): Promise<void> {
    const entry = this.callbackMap.get(ev.action.id);
    if (entry) {
      kisWebSocket.unsubscribe(TR_ID_DOMESTIC, entry.trKey, entry.callback);
      this.callbackMap.delete(ev.action.id);
      this.hasInitialPrice.delete(ev.action.id);
      this.clearRetryTimer(ev.action.id);
      logger.info(`[국내] 구독 해제: ${entry.trKey}`);
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<DomesticStockSettings>
  ): Promise<void> {
    const oldEntry = this.callbackMap.get(ev.action.id);
    if (oldEntry) {
      kisWebSocket.unsubscribe(TR_ID_DOMESTIC, oldEntry.trKey, oldEntry.callback);
      this.callbackMap.delete(ev.action.id);
    }
    this.clearRetryTimer(ev.action.id);
    this.hasInitialPrice.delete(ev.action.id);

    const settings = ev.payload.settings;
    const stockCode = settings.stockCode?.trim();
    const stockName = settings.stockName?.trim() || stockCode || "";

    logger.info(`[국내] onDidReceiveSettings: code=${stockCode}, name=${stockName}`);

    if (!stockCode) {
      await ev.action.setImage(svgToDataUri(renderSetupCard("종목코드를 설정하세요")));
      return;
    }

    await ev.action.setImage(svgToDataUri(renderWaitingCard(stockName, "domestic")));

    // 마지막 체결가를 먼저 표시한 뒤 WebSocket 재구독
    const hasSnapshot = await this.fetchAndShowPrice(ev, stockCode, stockName);
    if (hasSnapshot) {
      this.hasInitialPrice.add(ev.action.id);
    } else {
      this.hasInitialPrice.delete(ev.action.id);
      this.scheduleInitialPriceRetry(ev, stockCode, stockName);
    }

    const callback: DataCallback = (_trId, _trKey, fields) => {
      const data = parseDomesticData(fields, stockName);
      const svg = renderStockCard(data, "domestic");
      ev.action.setImage(svgToDataUri(svg));
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[국내] 재구독 성공: ${stockCode}`);
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(svgToDataUri(renderConnectedCard(stockName, "domestic")));
      }
    };

    this.callbackMap.set(ev.action.id, { trKey: stockCode, callback });

    try {
      await kisWebSocket.subscribe(TR_ID_DOMESTIC, stockCode, callback, onSuccess);
    } catch (err) {
      logger.error(`[국내] 재구독 실패: ${stockCode}`, err);
    }
  }

  override async onKeyDown(
    ev: KeyDownEvent<DomesticStockSettings>
  ): Promise<void> {
    const actionId = ev.action.id;
    if (this.refreshInFlight.has(actionId)) {
      logger.debug(`[국내] 수동 새로고침 중복 요청 무시: action=${actionId}`);
      return;
    }

    const settings = ev.payload.settings;
    const stockCode = settings.stockCode?.trim();
    const stockName = settings.stockName?.trim() || stockCode || "";

    if (!stockCode) {
      await ev.action.setImage(svgToDataUri(renderSetupCard("종목코드를 설정하세요")));
      return;
    }

    this.refreshInFlight.add(actionId);
    try {
      const ok = await this.fetchAndShowPrice(ev, stockCode, stockName);
      if (ok) {
        this.hasInitialPrice.add(actionId);
        logger.info(`[국내] 수동 새로고침 성공: ${stockCode}`);
      } else {
        logger.info(`[국내] 수동 새로고침 결과 없음: ${stockCode}`);
      }
    } catch (err) {
      logger.debug(`[국내] 수동 새로고침 실패: ${stockCode} / ${err}`);
    } finally {
      this.refreshInFlight.delete(actionId);
    }
  }

  /**
   * REST API로 현재가/종가를 조회하여 화면에 표시
   */
  private async fetchAndShowPrice(
    ev: { action: { setImage(image: string): Promise<void> | void } },
    stockCode: string,
    stockName: string
  ): Promise<boolean> {
    try {
      const data = await fetchDomesticPrice(stockCode, stockName);
      if (data) {
        const svg = renderStockCard(data, "domestic");
        await ev.action.setImage(svgToDataUri(svg));
        logger.info(`[국내] REST 현재가 표시: ${stockCode} = ${data.price}`);
        return true;
      }
    } catch (err) {
      logger.debug(`[국내] REST 현재가 조회 실패 (WebSocket 대기): ${err}`);
    }
    return false;
  }

  private scheduleInitialPriceRetry(
    ev: WillAppearEvent<DomesticStockSettings> | DidReceiveSettingsEvent<DomesticStockSettings>,
    stockCode: string,
    stockName: string
  ): void {
    const actionId = ev.action.id;
    this.clearRetryTimer(actionId);

    const timer = setTimeout(() => {
      this.retryTimers.delete(actionId);

      if (!this.callbackMap.has(actionId) || this.hasInitialPrice.has(actionId)) {
        return;
      }

      logger.info(`[국내] REST 현재가 재시도: ${stockCode}`);
      this.fetchAndShowPrice(ev, stockCode, stockName)
        .then((ok) => {
          if (ok) {
            this.hasInitialPrice.add(actionId);
            logger.info(`[국내] REST 현재가 재시도 성공: ${stockCode}`);
          }
        })
        .catch((err) => {
          logger.debug(`[국내] REST 현재가 재시도 실패: ${stockCode} / ${err}`);
        });
    }, INITIAL_PRICE_RETRY_DELAY_MS);

    this.retryTimers.set(actionId, timer);
  }

  private clearRetryTimer(actionId: string): void {
    const timer = this.retryTimers.get(actionId);
    if (!timer) return;
    clearTimeout(timer);
    this.retryTimers.delete(actionId);
  }
}
