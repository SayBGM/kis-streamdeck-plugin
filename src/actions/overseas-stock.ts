import {
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
} from "@elgato/streamdeck";
import { kisWebSocket, type DataCallback, type SubscribeSuccessCallback } from "../kis/websocket-manager.js";
import { parseOverseasData } from "../kis/overseas-parser.js";
import { fetchOverseasPrice } from "../kis/rest-price.js";
import {
  renderStockCard,
  renderWaitingCard,
  renderConnectedCard,
  renderSetupCard,
  svgToDataUri,
} from "../renderer/stock-card.js";
import {
  TR_ID_OVERSEAS,
  OVERSEAS_NIGHT_PREFIX,
  OVERSEAS_DAY_PREFIX,
  isOverseasDayTrading,
  type OverseasStockSettings,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

const INITIAL_PRICE_RETRY_DELAY_MS = 4000;

export class OverseasStockAction extends SingletonAction<OverseasStockSettings> {
  override readonly manifestId = "com.kis.streamdeck.overseas-stock";

  private callbackMap = new Map<
    string,
    { trKey: string; callback: DataCallback }
  >();
  private hasInitialPrice = new Set<string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshInFlight = new Set<string>();

  /**
   * 현재 시간 기반으로 주간/야간 자동 판별하여 tr_key 생성
   *
   * 야간거래: D + NYS/NAS/AMS + 종목코드 (예: DNASAAPL)
   * 주간거래: R + BAY/BAQ/BAA + 종목코드 (예: RBAQAAPL)
   */
  private makeTrKey(settings: OverseasStockSettings): string {
    const isDayTrading = isOverseasDayTrading();
    const prefixMap = isDayTrading ? OVERSEAS_DAY_PREFIX : OVERSEAS_NIGHT_PREFIX;
    const prefix = prefixMap[settings.exchange] || (isDayTrading ? "RBAQ" : "DNAS");
    const trKey = `${prefix}${settings.ticker.toUpperCase()}`;

    logger.info(`[미국] tr_key 생성: ${trKey} (${isDayTrading ? "주간거래" : "야간거래"})`);
    return trKey;
  }

  override async onWillAppear(
    ev: WillAppearEvent<OverseasStockSettings>
  ): Promise<void> {
    const settings = ev.payload.settings;
    const ticker = settings.ticker?.trim().toUpperCase();
    const stockName = settings.stockName?.trim() || ticker || "";

    logger.info(`[미국] onWillAppear: ticker=${ticker}, name=${stockName}, exchange=${settings.exchange}`);

    if (!ticker) {
      await ev.action.setImage(svgToDataUri(renderSetupCard("티커를 설정하세요")));
      return;
    }

    await ev.action.setImage(svgToDataUri(renderWaitingCard(stockName, "overseas")));

    // 마지막 체결가를 먼저 표시한 뒤 WebSocket 구독
    const hasSnapshot = await this.fetchAndShowPrice(ev, settings, stockName);
    if (hasSnapshot) {
      this.hasInitialPrice.add(ev.action.id);
    } else {
      this.hasInitialPrice.delete(ev.action.id);
      this.scheduleInitialPriceRetry(ev, settings, stockName);
    }

    // WebSocket 구독
    const trKey = this.makeTrKey(settings);

    const callback: DataCallback = (_trId, _trKey, fields) => {
      const data = parseOverseasData(fields, stockName);
      const svg = renderStockCard(data, "overseas");
      ev.action.setImage(svgToDataUri(svg));
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[미국] 구독 성공: ${trKey}`);
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(svgToDataUri(renderConnectedCard(stockName, "overseas")));
      }
    };

    this.callbackMap.set(ev.action.id, { trKey, callback });

    try {
      await kisWebSocket.subscribe(TR_ID_OVERSEAS, trKey, callback, onSuccess);
      logger.info(`[미국] 구독 요청 완료: ${trKey}`);
    } catch (err) {
      logger.error(`[미국] 구독 실패: ${trKey}`, err);
    }
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<OverseasStockSettings>
  ): Promise<void> {
    const entry = this.callbackMap.get(ev.action.id);
    if (entry) {
      kisWebSocket.unsubscribe(TR_ID_OVERSEAS, entry.trKey, entry.callback);
      this.callbackMap.delete(ev.action.id);
      this.hasInitialPrice.delete(ev.action.id);
      this.clearRetryTimer(ev.action.id);
      logger.info(`[미국] 구독 해제: ${entry.trKey}`);
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<OverseasStockSettings>
  ): Promise<void> {
    const oldEntry = this.callbackMap.get(ev.action.id);
    if (oldEntry) {
      kisWebSocket.unsubscribe(TR_ID_OVERSEAS, oldEntry.trKey, oldEntry.callback);
      this.callbackMap.delete(ev.action.id);
    }
    this.clearRetryTimer(ev.action.id);
    this.hasInitialPrice.delete(ev.action.id);

    const settings = ev.payload.settings;
    const ticker = settings.ticker?.trim().toUpperCase();
    const stockName = settings.stockName?.trim() || ticker || "";

    logger.info(`[미국] onDidReceiveSettings: ticker=${ticker}, name=${stockName}`);

    if (!ticker) {
      await ev.action.setImage(svgToDataUri(renderSetupCard("티커를 설정하세요")));
      return;
    }

    await ev.action.setImage(svgToDataUri(renderWaitingCard(stockName, "overseas")));

    // 마지막 체결가를 먼저 표시한 뒤 WebSocket 재구독
    const hasSnapshot = await this.fetchAndShowPrice(ev, settings, stockName);
    if (hasSnapshot) {
      this.hasInitialPrice.add(ev.action.id);
    } else {
      this.hasInitialPrice.delete(ev.action.id);
      this.scheduleInitialPriceRetry(ev, settings, stockName);
    }

    const trKey = this.makeTrKey(settings);

    const callback: DataCallback = (_trId, _trKey, fields) => {
      const data = parseOverseasData(fields, stockName);
      const svg = renderStockCard(data, "overseas");
      ev.action.setImage(svgToDataUri(svg));
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[미국] 재구독 성공: ${trKey}`);
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(svgToDataUri(renderConnectedCard(stockName, "overseas")));
      }
    };

    this.callbackMap.set(ev.action.id, { trKey, callback });

    try {
      await kisWebSocket.subscribe(TR_ID_OVERSEAS, trKey, callback, onSuccess);
    } catch (err) {
      logger.error(`[미국] 재구독 실패: ${trKey}`, err);
    }
  }

  override async onKeyDown(
    ev: KeyDownEvent<OverseasStockSettings>
  ): Promise<void> {
    const actionId = ev.action.id;
    if (this.refreshInFlight.has(actionId)) {
      logger.debug(`[미국] 수동 새로고침 중복 요청 무시: action=${actionId}`);
      return;
    }

    const settings = ev.payload.settings;
    const ticker = settings.ticker?.trim().toUpperCase();
    const stockName = settings.stockName?.trim() || ticker || "";

    if (!ticker) {
      await ev.action.setImage(svgToDataUri(renderSetupCard("티커를 설정하세요")));
      return;
    }

    this.refreshInFlight.add(actionId);
    try {
      const ok = await this.fetchAndShowPrice(ev, settings, stockName);
      if (ok) {
        this.hasInitialPrice.add(actionId);
        logger.info(`[미국] 수동 새로고침 성공: ${ticker}`);
      } else {
        logger.info(`[미국] 수동 새로고침 결과 없음: ${ticker}`);
      }
    } catch (err) {
      logger.debug(`[미국] 수동 새로고침 실패: ${ticker} / ${err}`);
    } finally {
      this.refreshInFlight.delete(actionId);
    }
  }

  /**
   * REST API로 현재가/종가를 조회하여 화면에 표시
   */
  private async fetchAndShowPrice(
    ev: { action: { setImage(image: string): Promise<void> | void } },
    settings: OverseasStockSettings,
    stockName: string
  ): Promise<boolean> {
    try {
      const data = await fetchOverseasPrice(settings.exchange, settings.ticker, stockName);
      if (data) {
        const svg = renderStockCard(data, "overseas");
        await ev.action.setImage(svgToDataUri(svg));
        logger.info(`[미국] REST 현재가 표시: ${settings.ticker} = ${data.price}`);
        return true;
      }
    } catch (err) {
      logger.debug(`[미국] REST 현재가 조회 실패 (WebSocket 대기): ${err}`);
    }
    return false;
  }

  private scheduleInitialPriceRetry(
    ev: WillAppearEvent<OverseasStockSettings> | DidReceiveSettingsEvent<OverseasStockSettings>,
    settings: OverseasStockSettings,
    stockName: string
  ): void {
    const actionId = ev.action.id;
    this.clearRetryTimer(actionId);

    const timer = setTimeout(() => {
      this.retryTimers.delete(actionId);

      if (!this.callbackMap.has(actionId) || this.hasInitialPrice.has(actionId)) {
        return;
      }

      logger.info(`[미국] REST 현재가 재시도: ${settings.ticker}`);
      this.fetchAndShowPrice(ev, settings, stockName)
        .then((ok) => {
          if (ok) {
            this.hasInitialPrice.add(actionId);
            logger.info(`[미국] REST 현재가 재시도 성공: ${settings.ticker}`);
          }
        })
        .catch((err) => {
          logger.debug(`[미국] REST 현재가 재시도 실패: ${settings.ticker} / ${err}`);
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
