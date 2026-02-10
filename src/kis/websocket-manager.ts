import WebSocket from "ws";
import { getApprovalKey } from "./auth.js";
import {
  KIS_WS_URL,
  TR_ID_DOMESTIC,
  TR_ID_OVERSEAS,
  type GlobalSettings,
} from "../types/index.js";
import { logger } from "../utils/logger.js";

// ─── 콜백 타입 ───
export type DataCallback = (
  trId: string,
  trKey: string,
  dataFields: string[]
) => void;

/**
 * 구독 성공 시 호출되는 콜백
 */
export type SubscribeSuccessCallback = (trId: string, trKey: string) => void;

// ─── 구독 정보 ───
interface Subscription {
  trId: string;
  trKey: string;
  callbacks: Set<DataCallback>;
  onSuccess?: SubscribeSuccessCallback;
}

// ─── 상수 ───
const RECONNECT_DELAY_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;

/**
 * KIS WebSocket 매니저
 */
class KISWebSocketManager {
  private ws: WebSocket | null = null;
  private approvalKey: string | null = null;
  private subscriptions = new Map<string, Subscription>();
  private globalSettings: GlobalSettings | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private connectPromise: Promise<void> | null = null;
  private isUpdating = false;

  get isReady(): boolean {
    return !!this.approvalKey;
  }

  async updateSettings(settings: GlobalSettings): Promise<void> {
    if (this.isUpdating) {
      logger.info("[WS] updateSettings 이미 진행 중, 스킵");
      return;
    }
    this.isUpdating = true;

    try {
      this.globalSettings = settings;

      if (!settings.appKey || !settings.appSecret) {
        logger.warn("[WS] App Key 또는 App Secret이 비어있습니다");
        return;
      }

      logger.info("[WS] approval_key 발급 시작...");
      this.approvalKey = await getApprovalKey(settings);
      logger.info("[WS] approval_key 발급 완료");

      if (this.subscriptions.size > 0) {
        logger.info(`[WS] 대기 중인 구독 ${this.subscriptions.size}건 연결 시도`);
        this.safeDisconnect();
        await this.connect();
      } else {
        logger.info("[WS] 대기 중인 구독 없음, 연결 보류");
      }
    } catch (e) {
      logger.error("[WS] updateSettings 실패:", e);
    } finally {
      this.isUpdating = false;
    }
  }

  async subscribe(
    trId: string,
    trKey: string,
    callback: DataCallback,
    onSuccess?: SubscribeSuccessCallback
  ): Promise<void> {
    const key = this.makeKey(trId, trKey);

    if (!this.subscriptions.has(key)) {
      this.subscriptions.set(key, { trId, trKey, callbacks: new Set() });
    }

    const sub = this.subscriptions.get(key)!;
    sub.callbacks.add(callback);
    if (onSuccess) sub.onSuccess = onSuccess;

    if (!this.approvalKey) {
      logger.info(`[WS] approval_key 대기, 구독 예약: ${trId}/${trKey}`);
      return;
    }

    try {
      await this.ensureConnected();
      this.sendSubscribe(trId, trKey);
    } catch (err) {
      logger.error(`[WS] 구독 연결 실패: ${trId}/${trKey}`, err);
    }
  }

  unsubscribe(trId: string, trKey: string, callback: DataCallback): void {
    const key = this.makeKey(trId, trKey);
    const sub = this.subscriptions.get(key);

    if (sub) {
      sub.callbacks.delete(callback);
      if (sub.callbacks.size === 0) {
        this.subscriptions.delete(key);
        this.sendUnsubscribe(trId, trKey);
      }
    }

    if (this.subscriptions.size === 0) {
      this.safeDisconnect();
    }
  }

  destroy(): void {
    this.subscriptions.clear();
    this.safeDisconnect();
  }

  // ─── Private ───

  private makeKey(trId: string, trKey: string): string {
    return `${trId}:${trKey}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.isConnecting && this.connectPromise) {
      await this.connectPromise;
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.approvalKey || !this.globalSettings) {
      throw new Error("approval_key 또는 설정이 없습니다");
    }

    if (this.isConnecting && this.connectPromise) {
      return this.connectPromise;
    }

    this.isConnecting = true;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      logger.info(`[WS] WebSocket 연결 시도: ${KIS_WS_URL}`);

      try {
        this.ws = new WebSocket(KIS_WS_URL);
      } catch (err) {
        logger.error("[WS] WebSocket 생성 실패:", err);
        this.isConnecting = false;
        this.connectPromise = null;
        reject(err);
        return;
      }

      const timeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          logger.error("[WS] 연결 타임아웃 (10초)");
          this.safeDisconnect();
          this.isConnecting = false;
          this.connectPromise = null;
          reject(new Error("연결 타임아웃"));
        }
      }, CONNECT_TIMEOUT_MS);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        logger.info("[WS] WebSocket 연결됨!");
        this.isConnecting = false;
        this.connectPromise = null;

        for (const sub of this.subscriptions.values()) {
          this.sendSubscribe(sub.trId, sub.trKey);
        }
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("close", (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        logger.info(`[WS] 연결 종료 (code=${code}, reason=${reason.toString()})`);
        this.isConnecting = false;
        this.connectPromise = null;
        this.ws = null;
        this.scheduleReconnect();
      });

      this.ws.on("error", (err: Error) => {
        clearTimeout(timeout);
        logger.error("[WS] WebSocket 에러:", err.message);
        this.isConnecting = false;
        this.connectPromise = null;
        reject(err);
      });
    });

    return this.connectPromise;
  }

  private handleMessage(rawData: string): void {
    // JSON 형태 메시지 (제어 메시지, PINGPONG 포함)
    if (rawData.startsWith("{")) {
      try {
        const json = JSON.parse(rawData);
        const trId = json.header?.tr_id;

        // PINGPONG: 서버가 보낸 메시지를 그대로 반환
        if (trId === "PINGPONG") {
          this.ws?.send(rawData);
          logger.debug("[WS] PINGPONG 응답");
          return;
        }

        // 구독 확인 메시지
        if (json.header && json.body) {
          const { msg_cd, msg1 } = json.body;
          const trKey = this.extractControlTrKey(json.body);
          logger.info(`[WS] 제어: ${trId} - ${msg_cd}: ${msg1}`);

          // 구독 성공 시 콜백 호출
          if ((msg_cd === "OPSP0000" || msg_cd === "OPSP0002") && trId) {
            this.notifySubscribeSuccess(trId, trKey);
          }
        }
        return;
      } catch {
        // JSON 파싱 실패 시 데이터 메시지로 처리
      }
    }

    // 텍스트 PINGPONG (일부 경우)
    if (rawData.startsWith("PINGPONG")) {
      this.ws?.send(rawData);
      return;
    }

    const pipeIdx1 = rawData.indexOf("|");
    if (pipeIdx1 < 0) return;
    const pipeIdx2 = rawData.indexOf("|", pipeIdx1 + 1);
    if (pipeIdx2 < 0) return;
    const pipeIdx3 = rawData.indexOf("|", pipeIdx2 + 1);
    if (pipeIdx3 < 0) return;

    const trId = rawData.substring(pipeIdx1 + 1, pipeIdx2);
    const dataStr = rawData.substring(pipeIdx3 + 1);
    const fields = dataStr.split("^");

    const matchedSubscriptions = this.findSubscriptionsForData(trId, fields);
    for (const sub of matchedSubscriptions) {
      for (const cb of sub.callbacks) {
        cb(trId, sub.trKey, fields);
      }
    }
  }

  /**
   * 구독 성공 알림: 가능하면 tr_key를 기준으로, 없으면 해당 TR_ID 전체에 대해 콜백 호출
   */
  private notifySubscribeSuccess(trId: string, trKey?: string): void {
    if (trKey) {
      const exact = this.subscriptions.get(this.makeKey(trId, trKey));
      if (exact?.onSuccess) {
        exact.onSuccess(exact.trId, exact.trKey);
        return;
      }
    }

    for (const sub of this.subscriptions.values()) {
      if (sub.trId === trId && sub.onSuccess) {
        sub.onSuccess(sub.trId, sub.trKey);
      }
    }
  }

  private extractControlTrKey(body: unknown): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const bodyObj = body as {
      input?: { tr_key?: string };
      output?: { tr_key?: string };
    };
    return bodyObj.output?.tr_key ?? bodyObj.input?.tr_key;
  }

  private findSubscriptionsForData(trId: string, fields: string[]): Subscription[] {
    const matches = new Map<string, Subscription>();

    switch (trId) {
      case TR_ID_DOMESTIC: {
        const stockCode = fields[0]?.trim();
        if (!stockCode) return [];
        const sub = this.subscriptions.get(this.makeKey(trId, stockCode));
        if (sub) matches.set(this.makeKey(sub.trId, sub.trKey), sub);
        return [...matches.values()];
      }
      case TR_ID_OVERSEAS: {
        const realTimeKey = fields[0]?.trim(); // 예: DNASPLTR
        const ticker = fields[1]?.trim().toUpperCase(); // 예: PLTR

        if (realTimeKey) {
          const exact = this.subscriptions.get(this.makeKey(trId, realTimeKey));
          if (exact) {
            matches.set(this.makeKey(exact.trId, exact.trKey), exact);
          }
        }

        // 서버 데이터 형식 차이가 있을 수 있어 ticker suffix로도 보조 매칭
        if (ticker) {
          for (const sub of this.subscriptions.values()) {
            if (sub.trId !== trId) continue;
            if (!sub.trKey.toUpperCase().endsWith(ticker)) continue;
            matches.set(this.makeKey(sub.trId, sub.trKey), sub);
          }
        }

        return [...matches.values()];
      }
      default:
        return [];
    }
  }

  private sendSubscribe(trId: string, trKey: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.approvalKey) return;

    const message = JSON.stringify({
      header: {
        approval_key: this.approvalKey,
        custtype: "P",
        tr_type: "1",
        "content-type": "utf-8",
      },
      body: { input: { tr_id: trId, tr_key: trKey } },
    });

    this.ws.send(message);
    logger.info(`[WS] 구독 요청 전송: ${trId} / ${trKey}`);
  }

  private sendUnsubscribe(trId: string, trKey: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.approvalKey) return;

    const message = JSON.stringify({
      header: {
        approval_key: this.approvalKey,
        custtype: "P",
        tr_type: "2",
        "content-type": "utf-8",
      },
      body: { input: { tr_id: trId, tr_key: trKey } },
    });

    this.ws.send(message);
    logger.info(`[WS] 구독 해제: ${trId} / ${trKey}`);
  }

  private safeDisconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.close();
        } else {
          this.ws.terminate();
        }
      } catch (e) {
        logger.debug("[WS] WebSocket 정리 중 에러 (무시)");
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.subscriptions.size === 0) return;
    if (!this.approvalKey) return;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = setTimeout(() => {
      logger.info("[WS] 재연결 시도...");
      this.connect().catch((err) => {
        logger.error("[WS] 재연결 실패:", err);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }
}

export const kisWebSocket = new KISWebSocketManager();
