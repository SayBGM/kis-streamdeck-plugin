import {
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
} from "@elgato/streamdeck";
import {
  kisWebSocket,
  type DataCallback,
  type SubscribeSuccessCallback,
  type ConnectionStateCallback,
} from "../kis/websocket-manager.js";
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
  type StockData,
  type StreamConnectionState,
  type OverseasStockSettings,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

const INITIAL_PRICE_RETRY_DELAY_MS = 4000;
const OVERSEAS_STALE_AFTER_MS = 20_000;
const CONNECTION_STATE_MIN_HOLD_MS = 1_500;
const PRICE_PRECISION_DIGITS = 2;
const CHANGE_PRECISION_DIGITS = 2;
const CHANGE_RATE_PRECISION_DIGITS = 2;

type DataSource = "live" | "backup";

export class OverseasStockAction extends SingletonAction<OverseasStockSettings> {
  override readonly manifestId = "com.kis.streamdeck.overseas-stock";

  private callbackMap = new Map<
    string,
    {
      trKey: string;
      callback: DataCallback;
      onSuccess?: SubscribeSuccessCallback;
      onConnectionState?: ConnectionStateCallback;
    }
  >();
  private hasInitialPrice = new Set<string>();
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private refreshInFlight = new Set<string>();
  private staleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stateTransitionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private actionRefMap = new Map<
    string,
    { setImage(image: string): Promise<void> | void }
  >();
  private lastRenderKeyByAction = new Map<string, string>();
  private lastDataByAction = new Map<string, StockData>();
  private lastDataAtByAction = new Map<string, number>();
  private connectionStateByAction = new Map<string, StreamConnectionState>();
  private connectionStateChangedAtByAction = new Map<string, number>();

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
    this.actionRefMap.set(ev.action.id, ev.action);
    const settings = ev.payload.settings;
    const ticker = settings.ticker?.trim().toUpperCase();
    const stockName = settings.stockName?.trim() || ticker || "";

    logger.info(`[미국] onWillAppear: ticker=${ticker}, name=${stockName}, exchange=${settings.exchange}`);

    if (!ticker) {
      this.resetActionRuntime(ev.action.id);
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
      this.applyConnectionState(ev.action.id, "LIVE");
      this.renderStockData(ev.action.id, ev.action, data, { source: "live" });
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[미국] 구독 성공: ${trKey}`);
      this.applyConnectionState(ev.action.id, "LIVE");
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(svgToDataUri(renderConnectedCard(stockName, "overseas")));
      }
    };

    const onConnectionState: ConnectionStateCallback = (
      _trId,
      _trKey,
      state
    ) => {
      this.applyConnectionState(ev.action.id, state);
      this.renderLastDataIfPossible(ev.action.id);
    };

    this.callbackMap.set(ev.action.id, {
      trKey,
      callback,
      onSuccess,
      onConnectionState,
    });

    try {
      await kisWebSocket.subscribe(
        TR_ID_OVERSEAS,
        trKey,
        callback,
        onSuccess,
        onConnectionState
      );
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
      kisWebSocket.unsubscribe(
        TR_ID_OVERSEAS,
        entry.trKey,
        entry.callback,
        entry.onSuccess,
        entry.onConnectionState
      );
      this.resetActionRuntime(ev.action.id);
      logger.info(`[미국] 구독 해제: ${entry.trKey}`);
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<OverseasStockSettings>
  ): Promise<void> {
    const oldEntry = this.callbackMap.get(ev.action.id);
    if (oldEntry) {
      kisWebSocket.unsubscribe(
        TR_ID_OVERSEAS,
        oldEntry.trKey,
        oldEntry.callback,
        oldEntry.onSuccess,
        oldEntry.onConnectionState
      );
    }
    this.resetActionRuntime(ev.action.id);
    this.actionRefMap.set(ev.action.id, ev.action);

    const settings = ev.payload.settings;
    const ticker = settings.ticker?.trim().toUpperCase();
    const stockName = settings.stockName?.trim() || ticker || "";

    logger.info(`[미국] onDidReceiveSettings: ticker=${ticker}, name=${stockName}`);

    if (!ticker) {
      this.resetActionRuntime(ev.action.id);
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
      this.applyConnectionState(ev.action.id, "LIVE");
      this.renderStockData(ev.action.id, ev.action, data, { source: "live" });
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[미국] 재구독 성공: ${trKey}`);
      this.applyConnectionState(ev.action.id, "LIVE");
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(svgToDataUri(renderConnectedCard(stockName, "overseas")));
      }
    };

    const onConnectionState: ConnectionStateCallback = (
      _trId,
      _trKey,
      state
    ) => {
      this.applyConnectionState(ev.action.id, state);
      this.renderLastDataIfPossible(ev.action.id);
    };

    this.callbackMap.set(ev.action.id, {
      trKey,
      callback,
      onSuccess,
      onConnectionState,
    });

    try {
      await kisWebSocket.subscribe(
        TR_ID_OVERSEAS,
        trKey,
        callback,
        onSuccess,
        onConnectionState
      );
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
      this.resetActionRuntime(actionId);
      await ev.action.setImage(svgToDataUri(renderSetupCard("티커를 설정하세요")));
      return;
    }

    this.refreshInFlight.add(actionId);
    try {
      const ok = await this.fetchAndShowPrice(ev, settings, stockName, true);
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
    ev: { action: { setImage(image: string): Promise<void> | void; id?: string } },
    settings: OverseasStockSettings,
    stockName: string,
    force = false
  ): Promise<boolean> {
    try {
      const data = await fetchOverseasPrice(settings.exchange, settings.ticker, stockName);
      if (data) {
        const actionId = ev.action.id;
        if (actionId) {
          await this.renderStockData(actionId, ev.action, data, {
            source: "backup",
            force,
          });
        } else {
          const svg = renderStockCard(data, "overseas");
          await ev.action.setImage(svgToDataUri(svg));
        }
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

  private clearStaleTimer(actionId: string): void {
    const timer = this.staleTimers.get(actionId);
    if (!timer) return;
    clearTimeout(timer);
    this.staleTimers.delete(actionId);
  }

  private clearStateTransitionTimer(actionId: string): void {
    const timer = this.stateTransitionTimers.get(actionId);
    if (!timer) return;
    clearTimeout(timer);
    this.stateTransitionTimers.delete(actionId);
  }

  private resetActionRuntime(actionId: string): void {
    this.callbackMap.delete(actionId);
    this.hasInitialPrice.delete(actionId);
    this.refreshInFlight.delete(actionId);
    this.actionRefMap.delete(actionId);
    this.lastRenderKeyByAction.delete(actionId);
    this.lastDataByAction.delete(actionId);
    this.lastDataAtByAction.delete(actionId);
    this.connectionStateByAction.delete(actionId);
    this.connectionStateChangedAtByAction.delete(actionId);
    this.clearRetryTimer(actionId);
    this.clearStaleTimer(actionId);
    this.clearStateTransitionTimer(actionId);
  }

  private applyConnectionState(
    actionId: string,
    nextState: StreamConnectionState
  ): void {
    const currentState = this.connectionStateByAction.get(actionId);
    if (currentState === nextState) return;

    const now = Date.now();
    const lastChangedAt = this.connectionStateChangedAtByAction.get(actionId) ?? 0;
    const elapsed = now - lastChangedAt;

    if (!currentState || elapsed >= CONNECTION_STATE_MIN_HOLD_MS) {
      this.connectionStateByAction.set(actionId, nextState);
      this.connectionStateChangedAtByAction.set(actionId, now);
      this.clearStateTransitionTimer(actionId);
      return;
    }

    this.clearStateTransitionTimer(actionId);
    const timer = setTimeout(() => {
      this.connectionStateByAction.set(actionId, nextState);
      this.connectionStateChangedAtByAction.set(actionId, Date.now());
      this.stateTransitionTimers.delete(actionId);
      this.renderLastDataIfPossible(actionId);
    }, CONNECTION_STATE_MIN_HOLD_MS - elapsed);
    this.stateTransitionTimers.set(actionId, timer);
  }

  private getRenderConnectionState(
    actionId: string,
    source: DataSource
  ): StreamConnectionState | null {
    const current = this.connectionStateByAction.get(actionId) ?? null;
    if (source === "live") return "LIVE";
    if (current === "LIVE") return "LIVE";
    if (current === "BROKEN") return "BACKUP";
    return "BACKUP";
  }

  private isStale(actionId: string): boolean {
    const lastAt = this.lastDataAtByAction.get(actionId);
    if (!lastAt) return false;
    return Date.now() - lastAt >= OVERSEAS_STALE_AFTER_MS;
  }

  private scheduleStaleRender(
    actionId: string,
    action: { setImage(image: string): Promise<void> | void }
  ): void {
    this.clearStaleTimer(actionId);
    const lastAt = this.lastDataAtByAction.get(actionId);
    if (!lastAt) return;
    const remaining = OVERSEAS_STALE_AFTER_MS - (Date.now() - lastAt);
    if (remaining <= 0) {
      this.renderLastDataIfPossible(actionId);
      return;
    }
    const timer = setTimeout(() => {
      this.staleTimers.delete(actionId);
      this.renderLastDataIfPossible(actionId);
    }, remaining);
    this.staleTimers.set(actionId, timer);
    this.actionRefMap.set(actionId, action);
  }

  private renderLastDataIfPossible(actionId: string): void {
    const data = this.lastDataByAction.get(actionId);
    const action = this.actionRefMap.get(actionId);
    if (!data || !action) return;
    const source =
      this.connectionStateByAction.get(actionId) === "LIVE" ? "live" : "backup";
    this.renderStockData(actionId, action, data, { source }).catch((err) => {
      logger.debug(`[미국] 마지막 데이터 재렌더 실패: ${err}`);
    });
  }

  private makeRenderKey(
    data: StockData,
    connectionState: StreamConnectionState | null,
    isStale: boolean
  ): string {
    const normalizedPrice = data.price.toFixed(PRICE_PRECISION_DIGITS);
    const normalizedChange = data.change.toFixed(CHANGE_PRECISION_DIGITS);
    const normalizedRate = data.changeRate.toFixed(CHANGE_RATE_PRECISION_DIGITS);
    return `${data.ticker}|${data.name}|${normalizedPrice}|${normalizedChange}|${normalizedRate}|${data.sign}|${connectionState ?? "NONE"}|${isStale ? "STALE" : "FRESH"}`;
  }

  private async renderStockData(
    actionId: string,
    action: { setImage(image: string): Promise<void> | void },
    data: StockData,
    options: { source: DataSource; force?: boolean }
  ): Promise<void> {
    this.lastDataByAction.set(actionId, data);
    this.lastDataAtByAction.set(actionId, Date.now());

    const targetState = this.getRenderConnectionState(actionId, options.source);
    if (targetState) {
      this.applyConnectionState(actionId, targetState);
    }
    const connectionState = this.connectionStateByAction.get(actionId) ?? null;
    const stale = this.isStale(actionId);
    const renderKey = this.makeRenderKey(data, connectionState, stale);

    if (!options.force && this.lastRenderKeyByAction.get(actionId) === renderKey) {
      this.scheduleStaleRender(actionId, action);
      return;
    }

    this.lastRenderKeyByAction.set(actionId, renderKey);
    const svg = renderStockCard(data, "overseas", {
      isStale: stale,
      connectionState,
    });
    await action.setImage(svgToDataUri(svg));
    this.scheduleStaleRender(actionId, action);
  }
}
