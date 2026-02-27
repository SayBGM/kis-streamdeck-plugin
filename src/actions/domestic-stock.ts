import streamDeck, {
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type SendToPluginEvent,
} from "@elgato/streamdeck";
import {
  kisWebSocket,
  type DataCallback,
  type SubscribeSuccessCallback,
  type ConnectionStateCallback,
} from "../kis/websocket-manager.js";
import { parseDomesticData } from "../kis/domestic-parser.js";
import { fetchDomesticPrice } from "../kis/rest-price.js";
import { getAccessToken } from "../kis/auth.js";
import {
  renderStockCard,
  renderWaitingCard,
  renderConnectedCard,
  renderSetupCard,
  renderErrorCard,
  renderRecoveryCard,
  svgToDataUri,
} from "../renderer/stock-card.js";
import {
  TR_ID_DOMESTIC,
  ErrorType,
  type DomesticStockSettings,
  type StockData,
  type StreamConnectionState,
} from "../types/index.js";
import { kisGlobalSettings } from "../kis/settings-store.js";
import { logger } from "../utils/logger.js";

const INITIAL_PRICE_RETRY_DELAY_MS = 4000;
const DOMESTIC_STALE_AFTER_MS = 20_000;
const CONNECTION_STATE_MIN_HOLD_MS = 1_500;
const PRICE_PRECISION_DIGITS = 2;
const CHANGE_PRECISION_DIGITS = 2;
const CHANGE_RATE_PRECISION_DIGITS = 2;
const DEBOUNCE_RENDER_MS = 50;

// REQ-PERF-001-2.2.4
interface PendingRender {
  action: { setImage(image: string): Promise<void> | void };
  dataUri: string;
  renderKey: string;
}

type DataSource = "live" | "backup";

export class DomesticStockAction extends SingletonAction<DomesticStockSettings> {
  override readonly manifestId = "com.kis.streamdeck.domestic-stock";

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
  private pendingRenderByAction = new Map<string, PendingRender>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  override async onWillAppear(
    ev: WillAppearEvent<DomesticStockSettings>,
  ): Promise<void> {
    this.actionRefMap.set(ev.action.id, ev.action);
    const settings = ev.payload.settings;
    const stockCode = settings.stockCode?.trim();
    const stockName = settings.stockName?.trim() || stockCode || "";

    logger.info(`[국내] onWillAppear: code=${stockCode}, name=${stockName}`);

    // NO_CREDENTIAL 가드: appKey/appSecret 미설정 시 에러 카드 표시
    const globalSettings = kisGlobalSettings.get();
    if (!globalSettings?.appKey || !globalSettings?.appSecret) {
      this.resetActionRuntime(ev.action.id);
      await ev.action.setImage(
        svgToDataUri(renderErrorCard(ErrorType.NO_CREDENTIAL), `error:${ErrorType.NO_CREDENTIAL}`),
      );
      return;
    }

    if (!stockCode) {
      this.resetActionRuntime(ev.action.id);
      await ev.action.setImage(
        svgToDataUri(renderSetupCard("종목코드를 설정하세요"), "setup:no-code"),
      );
      return;
    }

    await ev.action.setImage(
      svgToDataUri(renderWaitingCard(stockName, "domestic"), `waiting:domestic:${stockName}`),
    );

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
      this.applyConnectionState(ev.action.id, "LIVE");
      this.renderStockData(ev.action.id, ev.action, data, {
        source: "live",
      });
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[국내] 구독 성공: ${stockCode}`);
      this.applyConnectionState(ev.action.id, "LIVE");
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(
          svgToDataUri(renderConnectedCard(stockName, "domestic"), `connected:domestic:${stockName}`),
        );
      }
    };

    const onConnectionState: ConnectionStateCallback = (
      _trId,
      _trKey,
      state,
    ) => {
      this.applyConnectionState(ev.action.id, state);
      this.renderLastDataIfPossible(ev.action.id);
    };

    this.callbackMap.set(ev.action.id, {
      trKey: stockCode,
      callback,
      onSuccess,
      onConnectionState,
    });

    try {
      await kisWebSocket.subscribe(
        TR_ID_DOMESTIC,
        stockCode,
        callback,
        onSuccess,
        onConnectionState,
      );
      logger.info(`[국내] 구독 요청 완료: ${stockCode}`);
    } catch (err) {
      logger.error(`[국내] 구독 실패: ${stockCode}`, err);
    }
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<DomesticStockSettings>,
  ): Promise<void> {
    const entry = this.callbackMap.get(ev.action.id);
    if (entry) {
      kisWebSocket.unsubscribe(
        TR_ID_DOMESTIC,
        entry.trKey,
        entry.callback,
        entry.onSuccess,
        entry.onConnectionState,
      );
      this.resetActionRuntime(ev.action.id);
      logger.info(`[국내] 구독 해제: ${entry.trKey}`);
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<DomesticStockSettings>,
  ): Promise<void> {
    const oldEntry = this.callbackMap.get(ev.action.id);
    if (oldEntry) {
      kisWebSocket.unsubscribe(
        TR_ID_DOMESTIC,
        oldEntry.trKey,
        oldEntry.callback,
        oldEntry.onSuccess,
        oldEntry.onConnectionState,
      );
    }
    this.resetActionRuntime(ev.action.id);
    this.actionRefMap.set(ev.action.id, ev.action);

    const settings = ev.payload.settings;
    const stockCode = settings.stockCode?.trim();
    const stockName = settings.stockName?.trim() || stockCode || "";

    logger.info(
      `[국내] onDidReceiveSettings: code=${stockCode}, name=${stockName}`,
    );

    // NO_CREDENTIAL 가드: appKey/appSecret 미설정 시 에러 카드 표시
    const globalSettings = kisGlobalSettings.get();
    if (!globalSettings?.appKey || !globalSettings?.appSecret) {
      this.resetActionRuntime(ev.action.id);
      await ev.action.setImage(
        svgToDataUri(renderErrorCard(ErrorType.NO_CREDENTIAL), `error:${ErrorType.NO_CREDENTIAL}`),
      );
      return;
    }

    if (!stockCode) {
      this.resetActionRuntime(ev.action.id);
      await ev.action.setImage(
        svgToDataUri(renderSetupCard("종목코드를 설정하세요"), "setup:no-code"),
      );
      return;
    }

    await ev.action.setImage(
      svgToDataUri(renderWaitingCard(stockName, "domestic"), `waiting:domestic:${stockName}`),
    );

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
      this.applyConnectionState(ev.action.id, "LIVE");
      this.renderStockData(ev.action.id, ev.action, data, {
        source: "live",
      });
    };

    const onSuccess: SubscribeSuccessCallback = () => {
      logger.info(`[국내] 재구독 성공: ${stockCode}`);
      this.applyConnectionState(ev.action.id, "LIVE");
      if (!this.hasInitialPrice.has(ev.action.id)) {
        ev.action.setImage(
          svgToDataUri(renderConnectedCard(stockName, "domestic"), `connected:domestic:${stockName}`),
        );
      }
    };

    const onConnectionState: ConnectionStateCallback = (
      _trId,
      _trKey,
      state,
    ) => {
      this.applyConnectionState(ev.action.id, state);
      this.renderLastDataIfPossible(ev.action.id);
    };

    this.callbackMap.set(ev.action.id, {
      trKey: stockCode,
      callback,
      onSuccess,
      onConnectionState,
    });

    try {
      await kisWebSocket.subscribe(
        TR_ID_DOMESTIC,
        stockCode,
        callback,
        onSuccess,
        onConnectionState,
      );
    } catch (err) {
      logger.error(`[국내] 재구독 실패: ${stockCode}`, err);
    }
  }

  override async onKeyDown(
    ev: KeyDownEvent<DomesticStockSettings>,
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
      this.resetActionRuntime(actionId);
      await ev.action.setImage(
        svgToDataUri(renderSetupCard("종목코드를 설정하세요"), "setup:no-code"),
      );
      return;
    }

    this.refreshInFlight.add(actionId);
    try {
      const ok = await this.fetchAndShowPrice(ev, stockCode, stockName, true);
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
   *
   * 에러 시 에러 카드를 렌더링합니다 (SPEC-UI-001).
   */
  private async fetchAndShowPrice(
    ev: { action: { setImage(image: string): Promise<void> | void; id?: string } },
    stockCode: string,
    stockName: string,
    force = false,
  ): Promise<boolean> {
    try {
      const data = await fetchDomesticPrice(stockCode, stockName);
      if (data) {
        const actionId = ev.action.id;
        if (actionId) {
          await this.renderStockData(actionId, ev.action, data, {
            source: "backup",
            force,
          });
        } else {
          const svg = renderStockCard(data, "domestic");
          await ev.action.setImage(svgToDataUri(svg, `backup:domestic:${data.ticker}|${data.price}`));
        }
        logger.info(`[국내] REST 현재가 표시: ${stockCode} = ${data.price}`);
        return true;
      }
    } catch (err) {
      // ErrorType enum 값이면 에러 카드를 표시
      if (Object.values(ErrorType).includes(err as ErrorType)) {
        const errorType = err as ErrorType;
        logger.warn(`[국내] REST 현재가 에러 (${errorType}): ${stockCode}`);
        await ev.action.setImage(
          svgToDataUri(renderErrorCard(errorType), `error:${errorType}`),
        );
      } else {
        logger.debug(`[국내] REST 현재가 조회 실패 (WebSocket 대기): ${err}`);
      }
    }
    return false;
  }

  private scheduleInitialPriceRetry(
    ev:
      | WillAppearEvent<DomesticStockSettings>
      | DidReceiveSettingsEvent<DomesticStockSettings>,
    stockCode: string,
    stockName: string,
  ): void {
    const actionId = ev.action.id;
    this.clearRetryTimer(actionId);

    const timer = setTimeout(() => {
      this.retryTimers.delete(actionId);

      if (
        !this.callbackMap.has(actionId) ||
        this.hasInitialPrice.has(actionId)
      ) {
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
    const entry = this.callbackMap.get(actionId);
    if (entry) {
      this.callbackMap.delete(actionId);
    }
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
    this.pendingRenderByAction.delete(actionId);
  }

  private applyConnectionState(
    actionId: string,
    nextState: StreamConnectionState,
  ): void {
    const currentState = this.connectionStateByAction.get(actionId);
    if (currentState === nextState) return;

    // BROKEN/BACKUP → LIVE 전환 감지: 회복 알림 표시
    const isRecovery =
      nextState === "LIVE" &&
      (currentState === "BROKEN" || currentState === "BACKUP");

    const now = Date.now();
    const lastChangedAt = this.connectionStateChangedAtByAction.get(actionId) ?? 0;
    const elapsed = now - lastChangedAt;

    if (!currentState || elapsed >= CONNECTION_STATE_MIN_HOLD_MS) {
      this.connectionStateByAction.set(actionId, nextState);
      this.connectionStateChangedAtByAction.set(actionId, now);
      this.clearStateTransitionTimer(actionId);
      if (isRecovery) {
        this.showRecoveryNotification(actionId);
      }
      return;
    }

    this.clearStateTransitionTimer(actionId);
    const timer = setTimeout(() => {
      this.connectionStateByAction.set(actionId, nextState);
      this.connectionStateChangedAtByAction.set(actionId, Date.now());
      this.stateTransitionTimers.delete(actionId);
      if (isRecovery) {
        this.showRecoveryNotification(actionId);
      } else {
        this.renderLastDataIfPossible(actionId);
      }
    }, CONNECTION_STATE_MIN_HOLD_MS - elapsed);
    this.stateTransitionTimers.set(actionId, timer);
  }

  // @MX:NOTE: [AUTO] SPEC-UI-001 회복 알림: BROKEN/BACKUP→LIVE 전환 시 2초 표시 후 자동 복원
  // @MX:SPEC: SPEC-UI-001 REQ-UI-001-7.1, REQ-UI-001-7.2
  private showRecoveryNotification(actionId: string): void {
    const action = this.actionRefMap.get(actionId);
    if (!action) return;

    const lastData = this.lastDataByAction.get(actionId);
    const name = lastData?.name ?? "";

    // 회복 카드를 직접 setImage (디바운스 큐 우회)
    void Promise.resolve(
      action.setImage(svgToDataUri(renderRecoveryCard(name), `recovery:${actionId}:${Date.now()}`)),
    ).catch((err: unknown) => {
      logger.debug(`[국내] 회복 알림 setImage 실패: ${err}`);
    });

    // 2초 후 일반 카드로 복원
    setTimeout(() => {
      this.renderLastDataIfPossible(actionId);
    }, 2000);
  }

  private getRenderConnectionState(
    actionId: string,
    source: DataSource,
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
    return Date.now() - lastAt >= DOMESTIC_STALE_AFTER_MS;
  }

  private scheduleStaleRender(
    actionId: string,
    action: { setImage(image: string): Promise<void> | void },
  ): void {
    this.clearStaleTimer(actionId);
    const lastAt = this.lastDataAtByAction.get(actionId);
    if (!lastAt) return;
    const remaining = DOMESTIC_STALE_AFTER_MS - (Date.now() - lastAt);
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
      logger.debug(`[국내] 마지막 데이터 재렌더 실패: ${err}`);
    });
  }

  private makeRenderKey(
    data: StockData,
    connectionState: StreamConnectionState | null,
    isStale: boolean,
  ): string {
    // REQ-PERF-001-2.4.1: normalize all floating-point values to prevent spurious cache misses
    const normalizedPrice = data.price.toFixed(PRICE_PRECISION_DIGITS);
    const normalizedChange = data.change.toFixed(CHANGE_PRECISION_DIGITS);
    const normalizedRate = data.changeRate.toFixed(CHANGE_RATE_PRECISION_DIGITS);
    return `${data.ticker}|${data.name}|${normalizedPrice}|${normalizedChange}|${normalizedRate}|${data.sign}|${connectionState ?? "NONE"}|${isStale ? "STALE" : "FRESH"}`;
  }

  private async renderStockData(
    actionId: string,
    action: { setImage(image: string): Promise<void> | void },
    data: StockData,
    options: { source: DataSource; force?: boolean },
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
    const svg = renderStockCard(data, "domestic", {
      isStale: stale,
      connectionState,
    });
    // REQ-PERF-001-2.2.1: debounce setImage() IPC calls within 50ms window
    this.scheduleRender(actionId, action, svgToDataUri(svg, renderKey), renderKey);
    this.scheduleStaleRender(actionId, action);
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<{ event: string }, DomesticStockSettings>,
  ): Promise<void> {
    if (ev.payload.event !== "testConnection") return;

    const globalSettings = kisGlobalSettings.get();
    if (!globalSettings?.appKey || !globalSettings?.appSecret) {
      await streamDeck.ui.current?.sendToPropertyInspector({
        event: "testConnectionResult",
        success: false,
        errorType: ErrorType.NO_CREDENTIAL,
      });
      return;
    }

    try {
      // 읽기 전용 토큰 조회 (캐시 무효화 없음)
      await getAccessToken(globalSettings);
      await streamDeck.ui.current?.sendToPropertyInspector({
        event: "testConnectionResult",
        success: true,
      });
    } catch (err) {
      const errorType =
        err instanceof Error && (err.message.includes("401") || err.message.includes("발급 실패"))
          ? ErrorType.AUTH_FAIL
          : ErrorType.NETWORK_ERROR;
      logger.warn(`[국내] 연결 테스트 실패: ${err}`);
      await streamDeck.ui.current?.sendToPropertyInspector({
        event: "testConnectionResult",
        success: false,
        errorType,
      });
    }
  }

  // @MX:NOTE: [AUTO] last-write-wins debounce flush — batches setImage() IPC calls within 50ms window to reduce Electron IPC overhead
  // @MX:SPEC: SPEC-PERF-001 REQ-PERF-001-2.2.3
  private flushPendingRenders(): void {
    this.flushTimer = null;
    for (const [, pending] of this.pendingRenderByAction) {
      void Promise.resolve(pending.action.setImage(pending.dataUri)).catch((err: unknown) => {
        logger.debug(`[국내] setImage flush 실패: ${err}`);
      });
    }
    this.pendingRenderByAction.clear();
  }

  private scheduleRender(
    actionId: string,
    action: { setImage(image: string): Promise<void> | void },
    dataUri: string,
    renderKey: string,
  ): void {
    // REQ-PERF-001-2.2.2: last-write-wins — replace any pending render for this action
    this.pendingRenderByAction.set(actionId, { action, dataUri, renderKey });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushPendingRenders(), DEBOUNCE_RENDER_MS);
    }
  }
}
