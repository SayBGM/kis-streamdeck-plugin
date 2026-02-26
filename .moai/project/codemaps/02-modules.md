# 모듈 구조 및 책임

## 디렉토리 구조

```
src/
├── plugin.ts                  # 플러그인 엔트리 포인트
├── actions/                   # 액션 구현 (버튼별 비즈니스 로직)
│   ├── domestic-stock.ts      # 국내 주식 액션 (513줄)
│   └── overseas-stock.ts      # 해외 주식 액션 (512줄)
├── kis/                       # KIS API 통합 계층
│   ├── auth.ts               # OAuth2 토큰 관리
│   ├── websocket-manager.ts  # WebSocket 실시간 데이터
│   ├── rest-price.ts         # REST API 스냅샷 조회
│   ├── domestic-parser.ts    # H0UNCNT0 필드 파싱
│   ├── overseas-parser.ts    # HDFSCNT0 필드 파싱
│   └── settings-store.ts     # 글로벌 설정 저장소
├── renderer/                  # 프레젠테이션 계층
│   └── stock-card.ts         # SVG 카드 렌더링 (332줄)
├── types/                     # 타입 정의 및 상수
│   └── index.ts              # 타입 정의, KIS 상수
└── utils/                     # 유틸리티
    ├── logger.ts             # 로거 래퍼 (21줄)
    └── timezone.ts           # KST/ET 타임존 유틸 (78줄)
```

## 핵심 모듈 상세

### 1. plugin.ts - 플러그인 진입점

**책임**
- Stream Deck 연결 및 초기화
- 액션 등록
- 전역 설정 관리
- 토큰 갱신 이벤트 처리

**주요 함수**

| 함수 | 역할 |
|------|------|
| `hasCredentials()` | appKey/appSecret 존재 여부 확인 |
| `credentialKey()` | 자격증명 조합의 고유 키 생성 |
| `applyGlobalSettings()` | 설정 변경 적용 (토큰 hydrate, WS 업데이트) |

**전역 상태**

- `lastAppliedCredentialKey`: 마지막 적용된 자격증명 키 (중복 WS 업데이트 방지)
- `isInternalGlobalSettingsWrite`: 내부 설정 쓰기 플래그 (이벤트 재귀 방지)

**이벤트 핸들러**

```typescript
streamDeck.settings.onDidReceiveGlobalSettings()
  // 전역 설정 변경 감지
  // 자격증명 검증 및 변경 감지
  // 토큰 캐시 초기화 (자격증명 변경 시)
  // WebSocket 업데이트 요청

streamDeck.connect()
  // Stream Deck 연결
  // initialize() 호출
```

**초기화 흐름**

```
initialize()
  → onAccessTokenUpdated 리스너 등록
    (토큰 갱신 시 Global Settings에 저장)
  → getGlobalSettings() 호출
  → applyGlobalSettings() 호출
  → 자격증명 로깅
```

---

### 2. kis/auth.ts - OAuth2 토큰 관리

**책임**
- REST API 접근 토큰(access_token) 발급 및 캐싱
- WebSocket 접속용 approval_key 발급
- 토큰 만료 시간 관리
- 동시 발급 요청 통합

**주요 함수**

| 함수 | 역할 |
|------|------|
| `getAccessToken(settings)` | REST API용 토큰 발급 (캐싱 포함) |
| `getApprovalKey(settings)` | WebSocket용 approval_key 발급 |
| `hydrateAccessTokenFromGlobalSettings()` | Global Settings에서 토큰 복원 |
| `clearAccessTokenCache()` | 토큰 캐시 초기화 |
| `onAccessTokenUpdated(listener)` | 토큰 갱신 이벤트 리스너 등록 |

**토큰 발급 로직**

```
getAccessToken(settings)
  ├─ 캐시된 토큰 확인 (만료 1시간 전까지 재사용)
  ├─ 토큰 발급 중(in-flight) 확인 (중복 요청 방지)
  └─ 새로운 토큰 발급
      ├─ REST API 호출: POST /oauth2/tokenP
      ├─ EGW00133 에러 처리 (1분 대기 후 재시도)
      ├─ 토큰 캐시 저장
      └─ 갱신 콜백 호출
```

**토큰 캐싱 전략**

- **유효 기간**: 발급 후 24시간
- **갱신 임계값**: 만료 1시간 전에 자동 갱신
- **재사용**: 캐시된 토큰이 유효하면 API 호출 건너뜀
- **캐시 초기화**: 자격증명(appKey/appSecret) 변경 시 캐시 전체 초기화

**보안 고려사항**

- 동시 토큰 발급 제한 (1분당 1회): in-flight 요청으로 중복 방지
- 토큰 만료 안전 마진: 1시간 여유 (임박한 만료 회피)
- 자격증명 변경 시 토큰 초기화: 계정 불일치 방지

---

### 3. kis/websocket-manager.ts - WebSocket 실시간 데이터 (386줄)

**책임**
- KIS WebSocket 연결 관리 (싱글톤)
- 구독/구독해제 관리
- 실시간 시세 데이터 수신 및 배포
- 연결 상태 모니터링 및 재연결

**핵심 타입**

```typescript
interface Subscription {
  trId: string;                           // 거래 ID (H0UNCNT0, HDFSCNT0 등)
  trKey: string;                          // 구독 대상 (주식코드, 실시간 키)
  callbacks: Set<DataCallback>;           // 데이터 수신 콜백들
  successCallbacks: Set<SubscribeSuccessCallback>;  // 구독 성공 콜백
  connectionStateCallbacks: Set<ConnectionStateCallback>;  // 연결 상태 콜백
}
```

**주요 메서드**

| 메서드 | 역할 |
|--------|------|
| `updateSettings(settings)` | 자격증명 변경 시 approval_key 재발급 |
| `subscribe(trId, trKey, callback, ...)` | 구독 요청 및 콜백 등록 |
| `unsubscribe(trId, trKey, callback, ...)` | 구독 해제 및 콜백 제거 |
| `isReady` | approval_key 준비 상태 확인 |
| `destroy()` | 모든 구독 정리 및 연결 종료 |

**구독/구독해제 로직**

```
subscribe(trId, trKey, callback)
  ├─ 구독 정보 등록 (없으면 생성)
  ├─ 콜백 함수 추가
  ├─ approval_key 확인
  │   ├─ 없으면: 대기 (init 후 WS 업데이트 시 처리)
  │   └─ 있으면: ensureConnected() 호출
  └─ sendSubscribe() 전송

unsubscribe(trId, trKey, callback)
  ├─ 콜백 함수 제거
  ├─ 콜백 목록이 비면 구독 삭제 및 unsubscribe 메시지 전송
  └─ 활성 구독이 없으면 연결 종료
```

**메시지 처리**

WebSocket에서 수신한 데이터:

1. **JSON 제어 메시지**
   - PINGPONG: 서버 ping에 즉시 pong 응답
   - 구독 확인: msg_cd == "OPSP0000" 또는 "OPSP0002"

2. **텍스트 데이터 메시지** (파이프 구분)
   ```
   |TR_ID|설정내용|데이터필드^데이터필드^...
   ```
   - tr_key 매칭: 주식코드(국내) 또는 실시간키(해외)
   - 등록된 콜백들에게 필드 배열 전달

**연결 관리**

```
ensureConnected()
  ├─ WebSocket OPEN 확인
  ├─ 연결 중이면: connectPromise 대기
  └─ 미연결이면: connect() 호출

connect()
  ├─ WebSocket 생성
  ├─ 10초 타임아웃 설정
  ├─ open: 모든 대기 중인 구독 전송
  ├─ message: handleMessage() 호출
  ├─ close/error: 상태 갱신 및 재연결 예약
  └─ connectPromise 완료

scheduleReconnect()
  ├─ 5초 후 connect() 재시도
  └─ 활성 구독이 없으면 스킵
```

**상수**

```typescript
const RECONNECT_DELAY_MS = 5000;      // 재연결 간격
const CONNECT_TIMEOUT_MS = 10000;     // 연결 타임아웃
```

---

### 4. kis/rest-price.ts - REST API 스냅샷 조회

**책임**
- 현재가 REST API 호출
- 초기 가격 로드 (onWillAppear 시)
- 대체 경로 데이터 제공

**주요 함수**

| 함수 | 역할 |
|------|------|
| `fetchDomesticPrice(stockCode)` | 국내주식 현재가 조회 |
| `fetchOverseasPrice(ticker, exchange)` | 해외주식 현재가 조회 |

**API 엔드포인트**

- **국내**: FHKST01010100 (국내주식 현재가 시세)
- **해외**: HHDFS00000300 (해외주식 현재체결가)

---

### 5. kis/domestic-parser.ts - H0UNCNT0 필드 파싱

**책임**
- H0UNCNT0 (국내주식 실시간체결가) 데이터 필드 파싱
- 필드 인덱스를 의미 있는 값으로 변환

**파싱 필드**

```typescript
[0]: 주식코드
[1]: 현재가
[2]: 전일 대비 부호 (+/-)
[3]: 전일 대비 수량 (절대값)
[4]: 전일 대비 변동률 (%)
```

**출력**

```typescript
StockData {
  ticker,        // 주식코드
  name,          // 종목명 (전달받음)
  price,         // 현재가 (정수)
  change,        // 변동량 (정수)
  changeRate,    // 변동률 (소수점 2자리)
  sign            // 'rise' | 'fall' | 'flat'
}
```

---

### 6. kis/overseas-parser.ts - HDFSCNT0 필드 파싱

**책임**
- HDFSCNT0 (해외주식 실시간지연체결가) 데이터 필드 파싱
- 달러 가격 처리

**파싱 필드**

```typescript
[0]: 실시간키 (DNASPLTR 형태)
[1]: 티커 (PLTR 등)
[2]: 현재가 (달러, 소수점 2자리)
[3]: 전일 대비 부호 (+/-)
[4]: 전일 대비 수량
[5]: 변동률 (%)
```

---

### 7. kis/settings-store.ts - 글로벌 설정 저장소

**책임**
- 글로벌 설정의 동기식 접근
- 액션들 간 설정 공유

**주요 인터페이스**

```typescript
class KisGlobalSettingsStore {
  set(settings: GlobalSettings): void
  get(): GlobalSettings | null
  onDidReceiveSettings(callback): void
}
```

---

### 8. renderer/stock-card.ts - SVG 렌더링 엔진

**책임**
- 주식 카드를 SVG로 렌더링
- 시장 상태(PRE/REG/AFT/CLOSED) 시각화
- 연결 상태 표시 (LIVE/BACKUP/BROKEN)
- 캐싱을 통한 성능 최적화

**주요 함수**

| 함수 | 역할 |
|------|------|
| `renderStockCard(data, options)` | 완전한 주식 카드 SVG 생성 |
| `renderWaitingCard(name, market)` | 로딩 대기 중 카드 |
| `renderConnectedCard(name, market)` | 연결 완료된 카드 |
| `renderSetupCard(message)` | 설정 필요 메시지 |
| `svgToDataUri(svg)` | SVG를 Data URI로 변환 (캐싱) |

**색상 스키마**

```typescript
상승: #00c853 (녹색)
하락: #ff1744 (빨강)
보합: #9e9e9e (회색)

정규장: #00c853
프리/에프터: #ff9800 (주황)
장 마감: #616161 (어두운 회색)

LIVE: #00c853
BACKUP: #ffd54f (노랑)
BROKEN: #ff1744
```

**캐싱 전략**

- SVG Data URI 캐시: 최대 200개 항목
- 동일한 렌더링 결과는 재사용
- 메모리 효율성을 위해 캐시 크기 제한

---

### 9. types/index.ts - 타입 정의 및 상수

**주요 타입**

```typescript
type GlobalSettings = {
  appKey?: string
  appSecret?: string
  accessToken?: string
  accessTokenExpiry?: number  // epoch ms
}

type DomesticStockSettings = {
  stockCode: string      // 예: "005930"
  stockName: string      // 예: "삼성전자"
}

type OverseasStockSettings = {
  ticker: string         // 예: "AAPL"
  exchange: OverseasExchange  // "NYS" | "NAS" | "AMS"
  stockName: string
}

interface StockData {
  ticker: string
  name: string
  price: number
  change: number
  changeRate: number     // %
  sign: "rise" | "fall" | "flat"
}

type StreamConnectionState = "LIVE" | "BACKUP" | "BROKEN"
```

**KIS API 상수**

```typescript
const KIS_WS_URL = "ws://ops.koreainvestment.com:21000"
const KIS_REST_BASE = "https://openapi.koreainvestment.com:9443"

const TR_ID_DOMESTIC = "H0UNCNT0"      // 국내주식 실시간
const TR_ID_OVERSEAS = "HDFSCNT0"      // 해외주식 지연

const OVERSEAS_NIGHT_PREFIX = {        // 야간거래 (미국 정규장)
  NYS: "DNYS", NAS: "DNAS", AMS: "DAMS"
}
const OVERSEAS_DAY_PREFIX = {          // 주간거래 (한국 장)
  NYS: "RBAY", NAS: "RBAQ", AMS: "RBAA"
}
```

**헬퍼 함수**

```typescript
function isOverseasDayTrading(): boolean
  // 현재 미국 주간거래 시간(09:00~15:30 KST) 확인
```

---

### 10. utils/logger.ts & timezone.ts

**logger.ts** - Stream Deck 로거 래퍼
- streamDeck.logger를 편리하게 사용

**timezone.ts** - 타임존 유틸리티
```typescript
getKSTTotalMinutes(): number   // KST 기준 오늘 00:00부터의 분
getETTotalMinutes(): number    // ET 기준 오늘 00:00부터의 분 (DST 반영)
```

---

## 모듈 간 의존성

### 의존성 그래프

```
plugin.ts
├── DomesticStockAction
├── OverseasStockAction
├── kis/websocket-manager (싱글톤)
├── kis/settings-store (싱글톤)
├── kis/auth
│   └── types/index
└── types/index

DomesticStockAction / OverseasStockAction
├── kis/websocket-manager
├── kis/rest-price
│   └── kis/auth
├── kis/domestic-parser / kis/overseas-parser
├── renderer/stock-card
├── types/index
└── utils/logger

renderer/stock-card
├── types/index
├── utils/timezone
└── (재사용 가능한 순수 함수)

kis/websocket-manager
├── kis/auth
│   └── types/index
└── types/index
```

### 무순환 의존성 (Acyclic Dependency Graph)

모든 의존성이 일방향이며 순환 구조가 없습니다:

```
types/index (기반 계층)
    ↑
    ↑ (모듈들이 의존)
    ↑
kis/auth, kis/parsers, utils
    ↑
kis/websocket-manager, renderer
    ↑
액션 (DomesticStockAction, OverseasStockAction)
    ↑
plugin.ts (최상위)
```

---

## 공개 인터페이스 (Public Interfaces)

### kisWebSocket (싱글톤)

```typescript
export interface KISWebSocketManager {
  // 상태
  isReady: boolean

  // 설정
  updateSettings(settings: GlobalSettings): Promise<void>

  // 구독 관리
  subscribe(
    trId: string,
    trKey: string,
    callback: DataCallback,
    onSuccess?: SubscribeSuccessCallback,
    onConnectionState?: ConnectionStateCallback
  ): Promise<void>

  unsubscribe(
    trId: string,
    trKey: string,
    callback: DataCallback,
    onSuccess?: SubscribeSuccessCallback,
    onConnectionState?: ConnectionStateCallback
  ): void

  // 정리
  destroy(): void
}
```

### 액션 인터페이스

```typescript
export abstract class SingletonAction {
  // Stream Deck 제공 메서드
  onWillAppear(ev: WillAppearEvent): Promise<void>
  onWillDisappear(ev: WillDisappearEvent): Promise<void>
  onDidReceiveSettings(ev: DidReceiveSettingsEvent): Promise<void>
  onKeyDown(ev: KeyDownEvent): Promise<void>
}
```

### 데이터 처리 콜백 체인

```typescript
type DataCallback = (
  trId: string,
  trKey: string,
  dataFields: string[]
) => void

type SubscribeSuccessCallback = (
  trId: string,
  trKey: string
) => void

type ConnectionStateCallback = (
  trId: string,
  trKey: string,
  state: StreamConnectionState
) => void
```

