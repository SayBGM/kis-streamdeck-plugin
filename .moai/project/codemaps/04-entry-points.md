# 진입점 및 라이프사이클

## 애플리케이션 진입점

### src/plugin.ts - 플러그인 메인 진입점

**로드 순서**

```
bin/plugin.js (번들 진입점)
  ↓
src/plugin.ts 모듈 실행 (상단에서 하단 순서)
  ↓
  1. 로깅 설정
  2. 전역 함수 정의 (hasCredentials, credentialKey, applyGlobalSettings)
  3. 액션 등록
  4. Stream Deck 이벤트 핸들러 등록
  5. Stream Deck 연결
```

**코드 실행 순서**

```typescript
// 1. 로깅 설정
streamDeck.logger.setLevel(LogLevel.DEBUG);

// 2. 액션 등록
const domesticAction = new DomesticStockAction();
const overseasAction = new OverseasStockAction();
streamDeck.actions.registerAction(domesticAction);
streamDeck.actions.registerAction(overseasAction);

// 3. 이벤트 핸들러 등록
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  // 전역 설정 변경 감지
});

// 4. Stream Deck 연결
streamDeck.connect().then(() => {
  initialize();
});
```

**초기화 함수** (initialize)

```typescript
async function initialize(): Promise<void> {
  // 토큰 갱신 콜백 등록
  onAccessTokenUpdated(async (p) => {
    // Global Settings에 토큰 저장
  });

  // 저장된 글로벌 설정 로드
  const globalSettings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();

  // 설정 적용
  applyGlobalSettings(globalSettings);
}
```

---

## 액션 라이프사이클

### DomesticStockAction / OverseasStockAction

각 액션은 버튼이 나타났다 사라질 때까지의 생명주기를 관리합니다.

#### Phase 1: 액션 초기화 (onWillAppear)

**시점**: 사용자가 버튼을 보이는 폴더 또는 페이지를 열었을 때

**호출 스택**
```
Stream Deck 호스트
  ↓
@elgato/streamdeck SDK
  ↓
DomesticStockAction.onWillAppear(WillAppearEvent)
```

**작업 순서** (DomesticStockAction 예시)

```typescript
async onWillAppear(ev: WillAppearEvent<DomesticStockSettings>): Promise<void> {
  // 1. 액션 참조 저장
  this.actionRefMap.set(ev.action.id, ev.action);

  // 2. 종목코드 검증
  const stockCode = settings.stockCode?.trim();
  if (!stockCode) {
    // 설정 필요 카드 표시
    await ev.action.setImage(svgToDataUri(renderSetupCard("종목코드를 설정하세요")));
    return;
  }

  // 3. 로딩 카드 표시
  await ev.action.setImage(svgToDataUri(renderWaitingCard(stockName, "domestic")));

  // 4. REST API로 초기 가격 로드
  const hasSnapshot = await this.fetchAndShowPrice(ev, stockCode, stockName);

  // 5. WebSocket 구독 요청
  await kisWebSocket.subscribe(
    TR_ID_DOMESTIC,
    stockCode,
    callback,              // 데이터 수신 콜백
    onSuccess,            // 구독 성공 콜백
    onConnectionState     // 연결 상태 콜백
  );
}
```

**콜백 함수들**

```typescript
// 데이터 콜백: WebSocket에서 데이터 수신 시
const callback: DataCallback = (_trId, _trKey, fields) => {
  const data = parseDomesticData(fields, stockName);
  this.applyConnectionState(ev.action.id, "LIVE");
  this.renderStockData(ev.action.id, ev.action, data, {
    source: "live",
  });
};

// 성공 콜백: 구독이 성공했을 때
const onSuccess: SubscribeSuccessCallback = () => {
  this.applyConnectionState(ev.action.id, "LIVE");
  if (!this.hasInitialPrice.has(ev.action.id)) {
    ev.action.setImage(svgToDataUri(renderConnectedCard(stockName, "domestic")));
  }
};

// 연결 상태 콜백: LIVE/BACKUP/BROKEN 상태 변화
const onConnectionState: ConnectionStateCallback = (_trId, _trKey, state) => {
  this.applyConnectionState(ev.action.id, state);
  this.renderLastDataIfPossible(ev.action.id);
};
```

**초기화 완료 상태**

```
아이콘 상태:
  - 종목코드 없음: "설정이 필요합니다" 메시지
  - 로딩 중: "로딩 중..." 카드 (종목명 표시)
  - 초기 가격 로드됨: 가격 카드 (BACKUP 상태)
  - WebSocket 연결됨: 가격 카드 (LIVE 상태, 실시간 갱신)

메모리 상태:
  - actionRefMap에 action 참조 저장
  - callbackMap에 콜백 함수들 저장
  - connectionStateByAction에 현재 상태 저장
  - lastDataByAction에 마지막 데이터 저장
```

---

#### Phase 2: 데이터 수신 및 갱신 (동안)

**실시간 데이터 갱신**

```
WebSocket 메시지 수신
  ↓
kisWebSocket.handleMessage()
  ↓
매칭되는 구독찾기 (trId, trKey 기반)
  ↓
등록된 콜백 함수들 호출
  ├─ callback(trId, trKey, fields)
  ├─ onSuccess(trId, trKey)
  └─ onConnectionState(trId, trKey, state)
  ↓
액션의 데이터 처리
  ├─ 필드 파싱 (parseDomesticData 등)
  ├─ 가격 데이터 추출
  └─ renderStockData() 호출
  ↓
SVG 렌더링 및 이미지 설정
  ↓
Stream Deck 아이콘 갱신
```

**타이머 관리**

액션 내부에서 여러 타이머가 실행됩니다:

```typescript
// Stale 데이터 감지 (20초 미수신)
staleTimers.set(actionId, setTimeout(() => {
  // stale 상태 표시 변경
}, DOMESTIC_STALE_AFTER_MS));

// 상태 전환 최소 유지 시간 (1.5초)
stateTransitionTimers.set(actionId, setTimeout(() => {
  // 상태 전환 허용
}, CONNECTION_STATE_MIN_HOLD_MS));

// 초기 가격 재시도 (4초 간격)
retryTimers.set(actionId, setTimeout(() => {
  this.fetchAndShowPrice(ev, stockCode, stockName);
}, INITIAL_PRICE_RETRY_DELAY_MS));
```

---

#### Phase 3: 액션 종료 (onWillDisappear)

**시점**: 사용자가 버튼을 숨기는 폴더 또는 페이지를 떠났을 때

**작업 순서**

```typescript
async onWillDisappear(ev: WillDisappearEvent<DomesticStockSettings>): Promise<void> {
  // 1. 웹소켓 구독 해제
  const entry = this.callbackMap.get(ev.action.id);
  if (entry) {
    kisWebSocket.unsubscribe(
      TR_ID_DOMESTIC,
      entry.trKey,
      entry.callback,
      entry.onSuccess,
      entry.onConnectionState
    );
  }

  // 2. 모든 타이머 정리
  this.clearAllTimers(ev.action.id);

  // 3. 메모리 상태 정리
  this.resetActionRuntime(ev.action.id);
}
```

**정리 작업**

```typescript
private resetActionRuntime(actionId: string): void {
  // 타이머 정리
  this.staleTimers.delete(actionId);
  this.stateTransitionTimers.delete(actionId);
  this.retryTimers.delete(actionId);
  this.refreshInFlight.delete(actionId);

  // 메모리 상태 정리
  this.hasInitialPrice.delete(actionId);
  this.actionRefMap.delete(actionId);
  this.lastRenderKeyByAction.delete(actionId);
  this.lastDataByAction.delete(actionId);
  this.lastDataAtByAction.delete(actionId);
  this.connectionStateByAction.delete(actionId);
  this.connectionStateChangedAtByAction.delete(actionId);

  // 콜백 제거
  this.callbackMap.delete(actionId);
}
```

**WebSocket 동작**

```
구독 해제 요청
  ↓
kisWebSocket.unsubscribe()
  ├─ 콜백 함수 Set에서 제거
  ├─ 활성 콜백이 없으면 구독 삭제
  └─ 모든 구독이 없으면 WebSocket 연결 종료
```

**메모리 상태**

```
정리 후:
  - actionRefMap: 액션 참조 제거
  - callbackMap: 콜백 함수 제거
  - 타이머들: 모두 정리
  - 데이터 캐시: 모두 제거

WebSocket 상태:
  - 구독이 남아 있으면: 계속 유지
  - 구독이 모두 없으면: 연결 종료 (비용 절감)
```

---

#### Phase 4: 설정 변경 (onDidReceiveSettings)

**시점**: 사용자가 버튼 설정(종목코드, 거래소 등)을 변경했을 때

**작업 순서**

```typescript
async onDidReceiveSettings(ev: DidReceiveSettingsEvent<DomesticStockSettings>): Promise<void> {
  const oldStockCode = this.callbackMap.get(ev.action.id)?.trKey;
  const newStockCode = ev.payload.settings.stockCode?.trim();

  // 1. 종목코드 변경 감지
  if (oldStockCode === newStockCode) {
    return; // 변경 없음
  }

  // 2. 이전 구독 해제
  if (oldStockCode) {
    kisWebSocket.unsubscribe(TR_ID_DOMESTIC, oldStockCode, /* ... */);
  }

  // 3. 새로운 구독 신청
  await kisWebSocket.subscribe(TR_ID_DOMESTIC, newStockCode, /* ... */);

  // 4. UI 상태 초기화
  this.hasInitialPrice.delete(ev.action.id);
  this.lastDataByAction.delete(ev.action.id);

  // 5. 로딩 카드 표시
  await ev.action.setImage(svgToDataUri(renderWaitingCard(newStockName, "domestic")));
}
```

---

### 설정 변경 (Global Settings)

**시점**: 사용자가 플러그인 전역 설정(appKey, appSecret)을 변경했을 때

**호출 스택**

```
Stream Deck 호스트
  ↓
streamDeck.settings.onDidReceiveGlobalSettings() 핸들러
  ↓
applyGlobalSettings(settings)
```

**작업 순서**

```typescript
function applyGlobalSettings(settings: GlobalSettings): void {
  // 1. 토큰 hydrate (저장된 토큰 복원)
  hydrateAccessTokenFromGlobalSettings(settings);

  // 2. REST API 용 설정 저장
  kisGlobalSettings.set(settings);

  // 3. 자격증명 검증
  if (!hasCredentials(settings)) {
    return; // 자격증명 없음, 처리 종료
  }

  // 4. 자격증명 변경 감지
  const credKey = credentialKey(settings);
  if (lastAppliedCredentialKey === credKey) {
    return; // 변경 없음 (토큰만 갱신된 경우)
  }

  // 5. 토큰 캐시 초기화
  clearAccessTokenCache();
  lastAppliedCredentialKey = credKey;

  // 6. WebSocket 업데이트 요청
  kisWebSocket.updateSettings(settings).catch((err) => {
    logger.error("[Plugin] WebSocket 업데이트 실패:", err);
  });
}
```

**WebSocket 업데이트 동작**

```typescript
// kis/websocket-manager.ts
async updateSettings(settings: GlobalSettings): Promise<void> {
  // 1. Approval Key 발급
  this.approvalKey = await getApprovalKey(settings);

  // 2. 대기 중인 구독들 연결
  if (this.subscriptions.size > 0) {
    this.safeDisconnect(); // 이전 연결 정리
    await this.connect();  // 새로운 연결
  }
}
```

**연결 복구**

```
getApprovalKey 발급 성공
  ↓
connect() 호출
  ├─ WebSocket 새로 생성
  ├─ open 이벤트: 모든 대기 중인 구독 전송
  └─ 각 액션의 onConnectionState 콜백 호출
    ↓
    모든 액션들이 자동으로 LIVE 상태로 갱신
```

---

## 키다운 이벤트 (onKeyDown)

**시점**: 사용자가 버튼을 눌렀을 때

```typescript
async onKeyDown(ev: KeyDownEvent<DomesticStockSettings>): Promise<void> {
  // 현재 구현: 아무 동작 없음 (향후 확장 가능)
  // 예: 포트폴리오 조회, 거래 실행, 설정창 열기 등
}
```

---

## KIS API 통합 진입점

### REST API 진입점

**AccessToken 발급** (kis/auth.ts)

```typescript
export async function getAccessToken(settings: GlobalSettings): Promise<string> {
  // 1. 캐시 확인 (만료 1시간 전까지 재사용)
  if (캐시된_토큰_유효()) {
    return 캐시된_토큰;
  }

  // 2. in-flight 요청 확인 (중복 방지)
  if (토큰_발급_중()) {
    return 토큰_발급_프로미스;
  }

  // 3. 새로운 토큰 발급
  return 토큰_발급_요청();
}
```

**REST API 호출** (kis/rest-price.ts)

```typescript
export async function fetchDomesticPrice(
  stockCode: string,
): Promise<StockData | null> {
  // 1. Access Token 획득
  const token = await getAccessToken(kisGlobalSettings.get());

  // 2. REST API 호출: GET /uapi/domestic-stock/v1/quotations/inquire-price
  const response = await fetch(
    `${KIS_REST_BASE}/uapi/domestic-stock/v1/quotations/inquire-price`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );

  // 3. 응답 파싱
  const data = await response.json();

  // 4. 필드 추출 (response.output 객체)
  return {
    ticker: stockCode,
    name,
    price: parseInt(data.stck_prpr),    // 현재가
    change: parseInt(data.prdy_vrss),    // 변동량
    changeRate: parseFloat(data.prdy_ctrt),  // 변동률
    sign: getSign(data.stck_prdy_sign),  // 부호
  };
}
```

### WebSocket 진입점

**Approval Key 발급** (kis/auth.ts)

```typescript
export async function getApprovalKey(settings: GlobalSettings): Promise<string> {
  // 1. REST API 호출: POST /oauth2/Approval
  const response = await fetch(
    `${KIS_REST_BASE}/oauth2/Approval`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: settings.appKey,
        secretkey: settings.appSecret,
      }),
    }
  );

  // 2. 응답 파싱
  const data = await response.json();

  // 3. approval_key 반환
  return data.approval_key;
}
```

**WebSocket 구독** (kis/websocket-manager.ts)

```typescript
async subscribe(
  trId: string,
  trKey: string,
  callback: DataCallback,
): Promise<void> {
  // 1. 구독 정보 등록
  this.subscriptions.set(makeKey(trId, trKey), {
    trId,
    trKey,
    callbacks: new Set([callback]),
    // ...
  });

  // 2. 연결 확인 (없으면 생성)
  await this.ensureConnected();

  // 3. 구독 메시지 전송
  this.sendSubscribe(trId, trKey);
}
```

**구독 메시지 형식**

```json
{
  "header": {
    "approval_key": "발급받은키",
    "custtype": "P",
    "tr_type": "1",
    "content-type": "utf-8"
  },
  "body": {
    "input": {
      "tr_id": "H0UNCNT0",
      "tr_key": "005930"
    }
  }
}
```

**데이터 수신 메시지 형식**

```
|H0UNCNT0|설정데이터|005930^87000^1^500^0.58^...
```

---

## 설정 저장소 진입점

### Global Settings 저장/로드

```typescript
// plugin.ts
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  // 수신: Global Settings 변경 감지
});

await streamDeck.settings.getGlobalSettings<GlobalSettings>();
// 로드: 현재 Global Settings 조회

await streamDeck.settings.setGlobalSettings({
  ...settings,
  accessToken: token,
  accessTokenExpiry: expiryMs,
});
// 저장: Global Settings 업데이트
```

### Action Settings 저장/로드

```typescript
// DomesticStockAction
override async onDidReceiveSettings(
  ev: DidReceiveSettingsEvent<DomesticStockSettings>,
): Promise<void> {
  const { stockCode, stockName } = ev.payload.settings;
  // 설정 변경 감지 및 처리
}
```

---

## 로거 진입점

**모든 모듈**에서 로깅:

```typescript
import { logger } from "../utils/logger.js";

logger.info("[모듈명] 메시지");
logger.warn("[모듈명] 경고");
logger.error("[모듈명] 에러:", error);
logger.debug("[모듈명] 디버그 정보");
```

**로그 출력**

```
→ Stream Deck 플러그인 로그 뷰어
→ 플러그인 디버그 콘솔
→ 파일 로그 (설정 시)
```

---

## 요청/응답 흐름 시각화

### 초기 로드 흐름

```
Stream Deck 호스트 연결
  ↓
plugin.ts 실행
  ↓
initialize() 호출
  ├─ getGlobalSettings() → REST API
  ├─ applyGlobalSettings()
  ├─ onAccessTokenUpdated 리스너 등록
  └─ WebSocket 준비 대기
  ↓
사용자가 버튼 페이지 열기
  ↓
DomesticStockAction.onWillAppear()
  ├─ fetchAndShowPrice() → REST API
  ├─ kisWebSocket.subscribe() → WebSocket
  └─ 콜백 등록
  ↓
WebSocket 메시지 수신 시작
  ├─ callback() → parseDomesticData()
  ├─ renderStockData() → SVG 렌더링
  └─ ev.action.setImage() → 아이콘 갱신
```

### 설정 변경 흐름

```
사용자가 appKey/appSecret 변경
  ↓
Global Settings 이벤트
  ↓
applyGlobalSettings()
  ├─ clearAccessTokenCache()
  ├─ getApprovalKey() → REST API
  └─ kisWebSocket.updateSettings()
    ├─ safeDisconnect() (이전 연결 종료)
    └─ connect() (새 연결 수립)
      └─ 모든 대기 중인 구독 전송
  ↓
모든 액션들의 onConnectionState() 콜백 호출
  ↓
LIVE 상태로 복구
```

