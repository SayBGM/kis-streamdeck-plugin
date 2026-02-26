# 데이터 흐름

## 실시간 주식 시세 데이터 흐름

### 주요 경로: WebSocket 구독 → 파싱 → 렌더링

```
[WebSocket 서버 (KIS)]
│
├─ WebSocket 메시지 전송
│   ├─ JSON 제어 메시지 (구독 확인, PINGPONG)
│   └─ 파이프 구분 데이터 (|TR_ID|설정|필드^필드^...)
│
↓
[WebSocket 클라이언트 (ws 라이브러리)]
│
├─ 메시지 수신
│   └─ 이벤트: 'message' → data: string
│
↓
[KISWebSocketManager]
│
├─ handleMessage(rawData: string)
│   ├─ JSON 파싱 시도
│   │   ├─ PINGPONG: 즉시 응답 전송
│   │   └─ 제어: 구독 확인, 연결 상태 업데이트
│   │
│   └─ 파이프 데이터 파싱
│       ├─ |로 구분: TR_ID, trKey, 데이터 추출
│       ├─ ^ 로 구분: 필드 배열 생성
│       └─ findSubscriptionsForData()로 매칭
│           ├─ 국내: 주식코드(field[0])로 매칭
│           └─ 해외: 실시간키(field[0]) + 티커(field[1])로 매칭
│
├─ 등록된 콜백들 호출
│   ├─ connectionStateCallback (상태 업데이트)
│   └─ dataCallback (데이터 처리)
│
↓
[액션 (DomesticStockAction / OverseasStockAction)]
│
├─ callback 함수 (데이터 콜백)
│   ├─ parseDomesticData(fields, stockName) 호출
│   │   └─ StockData 객체 생성
│   │
│   ├─ applyConnectionState(actionId, "LIVE") 호출
│   │   └─ connectionStateByAction 업데이트
│   │
│   └─ renderStockData(actionId, action, data) 호출
│
├─ renderStockData 함수
│   ├─ 렌더링 옵션 생성
│   │   ├─ source: "live"
│   │   └─ connectionState: "LIVE"
│   │
│   ├─ SVG 렌더링 요청
│   │   └─ renderStockCard(data, options)
│   │
│   ├─ Data URI 변환
│   │   └─ svgToDataUri(svg)
│   │
│   └─ Stream Deck 아이콘 설정
│       └─ action.setImage(dataUri)
│
↓
[Stream Deck 호스트]
│
├─ 버튼 아이콘 업데이트
│
↓
[사용자]
```

---

## 초기 가격 로드 흐름 (REST API)

### 경로: REST API 호출 → 파싱 → 렌더링

```
[액션 (DomesticStockAction)]
│
├─ onWillAppear() 호출
│   └─ fetchAndShowPrice(ev, stockCode, stockName)
│
↓
[REST Price 모듈]
│
├─ fetchDomesticPrice(stockCode)
│   ├─ 1. Access Token 획득
│   │   └─ getAccessToken(settings)
│   │       ├─ 캐시 확인 (만료 1시간 전까지)
│   │       ├─ in-flight 요청 확인 (중복 방지)
│   │       └─ 새로운 토큰 발급
│   │           └─ POST /oauth2/tokenP
│   │               ├─ 200: access_token 캐시
│   │               └─ EGW00133: 1분 대기 후 재시도
│   │
│   ├─ 2. REST API 호출
│   │   └─ GET /uapi/domestic-stock/v1/quotations/inquire-price
│   │       ├─ Authorization: Bearer {token}
│   │       ├─ 200: response.output 파싱
│   │       └─ 오류: null 반환
│   │
│   ├─ 3. 필드 추출
│   │   ├─ stck_prpr (현재가)
│   │   ├─ prdy_vrss (변동량)
│   │   ├─ prdy_ctrt (변동률)
│   │   └─ stck_prdy_sign (부호)
│   │
│   └─ 4. StockData 객체 반환
│
↓
[액션의 renderStockData 함수]
│
├─ SVG 렌더링
│   └─ renderStockCard(data, { source: "backup" })
│       └─ connectionState: null (REST API는 상태 미포함)
│
├─ Data URI 변환 및 캐싱
│   └─ svgToDataUri(svg)
│
└─ Stream Deck 아이콘 설정
    └─ action.setImage(dataUri)

↓
[Stream Deck 호스트]
│
├─ 초기 가격 표시
│
↓
[WebSocket 구독]
│
├─ WebSocket 연결 대기
│
└─ 첫 실시간 데이터 수신 시
    └─ connectionState: "LIVE"로 갱신
```

---

## 토큰 관리 흐름

### OAuth2 Token 발급 및 갱신

```
[전역 설정 변경]
│
├─ appKey/appSecret 업데이트
│
↓
[applyGlobalSettings()]
│
├─ hydrateAccessTokenFromGlobalSettings()
│   ├─ Global Settings에서 accessToken 로드
│   ├─ 유효 기간 확인 (만료 1시간 전 체크)
│   └─ 유효하면 cachedAccessToken에 복원
│
├─ clearAccessTokenCache() (자격증명 변경 시)
│   ├─ cachedAccessToken = null
│   ├─ accessTokenInFlight = null
│   └─ 이전 토큰 불사용 처리
│
└─ kisWebSocket.updateSettings(settings)
    └─ getApprovalKey(settings) 호출
        └─ approval_key 발급 (WebSocket 접속용)
```

### Token 재사용 및 캐싱

```
[액션에서 REST API 호출 필요]
│
├─ fetchDomesticPrice() 호출
│   └─ getAccessToken(settings)
│
↓
[Token 캐시 확인]
│
├─ 캐시된 토큰 있는가?
│   ├─ YES:
│   │   ├─ 만료 시간 확인
│   │   │   ├─ 1시간 이상 남음: 캐시된 토큰 사용 (API 호출 안 함)
│   │   │   └─ 1시간 미만: 새로운 토큰 발급
│   │   │
│   │   └─ 자격증명 일치 확인
│   │       ├─ 일치: 캐시된 토큰 사용
│   │       └─ 불일치: 새로운 토큰 발급
│   │
│   └─ NO: 새로운 토큰 발급
│
↓
[동시 요청 통합 (EGW00133 회피)]
│
├─ 토큰 발급 중인가?
│   ├─ YES: accessTokenInFlight 프로미스 반환 (중복 요청 방지)
│   └─ NO: 새로운 발급 프로세스 시작
│
↓
[Token 발급 API 호출]
│
├─ POST /oauth2/tokenP
│   ├─ appkey, appsecret 전송
│   ├─ 200: access_token, expires_in (초 단위) 수신
│   └─ 429/503 (EGW00133): 1분 대기 후 재시도
│
├─ 캐시에 저장
│   ├─ cachedAccessToken = token
│   ├─ cachedTokenExpiry = now + expires_in * 1000 (ms)
│   └─ cachedSettings = { appKey, appSecret }
│
├─ 갱신 알림 발송
│   └─ notifyAccessTokenUpdated({
│        token,
│        expiryEpochMs,
│        settings
│      })
│
↓
[Global Settings 저장 (선택적)]
│
├─ onAccessTokenUpdated 콜백 (plugin.ts)
│   └─ streamDeck.settings.setGlobalSettings({
│        ...current,
│        accessToken: token,
│        accessTokenExpiry: expiryEpochMs
│      })
│
├─ 저장 완료
│   └─ 재시작 후에도 토큰 재사용 가능
│
↓
[토큰 반환 및 사용]
│
└─ REST API 호출에 사용
    └─ Authorization: Bearer {token}
```

**토큰 유효 기간 관리**

```
발급 시점: T
만료 시간: T + 24시간
갱신 임계값: T + 23시간 (만료 1시간 전)

사용자 관점:
  T → T+23h: 캐시된 토큰 사용 (API 호출 0회)
  T+23h → T+24h: 새로운 토큰 발급 (API 호출 1회)
  T+24h 이후: 만료됨 (error 응답)

결과:
  - 토큰 발급 API 호출 최소화 (하루 1회)
  - rate limit 여유 (1분당 1회 제한)
  - 사용자 경험 개선 (즉각적인 응답)
```

---

## WebSocket 연결 및 재연결 흐름

### 초기 연결

```
[설정 변경]
│
├─ applyGlobalSettings(settings)
│   └─ kisWebSocket.updateSettings(settings)
│
↓
[Approval Key 발급]
│
├─ getApprovalKey(settings)
│   └─ POST /oauth2/Approval
│       ├─ appkey, appSecret 전송
│       └─ approval_key 수신
│
├─ this.approvalKey = key
│   └─ isReady = true
│
↓
[대기 중인 구독 처리]
│
├─ subscriptions.size > 0 인가?
│   ├─ YES:
│   │   ├─ safeDisconnect() (이전 연결 정리)
│   │   └─ connect() 호출
│   │
│   └─ NO:
│       └─ 연결 보류 (구독 신청 시에만 연결)
│
↓
[WebSocket 연결]
│
├─ new WebSocket(KIS_WS_URL)
│
├─ 타임아웃 설정 (10초)
│
├─ 이벤트 핸들러 등록
│   ├─ on('open'): 모든 대기 중인 구독 전송
│   ├─ on('message'): handleMessage() 호출
│   ├─ on('close'): 상태 업데이트 + 재연결 예약
│   └─ on('error'): 에러 로깅 + 재연결 예약
│
↓
[open 이벤트]
│
├─ 연결 성공
│
├─ 모든 구독 전송
│   ├─ 각 subscription별로 sendSubscribe() 호출
│   │   ├─ JSON 메시지 생성
│   │   │   └─ approval_key, tr_id, tr_key
│   │   └─ ws.send(message)
│   │
│   └─ 로그: "[WS] 구독 요청 전송: TR_ID / trKey"
│
├─ connectPromise resolve
│
└─ isConnecting = false
```

### 연결 끊김 및 재연결

```
[WebSocket close/error 이벤트]
│
├─ ws.on('close') 또는 ws.on('error')
│
├─ notifyConnectionStateForAll("BROKEN")
│   └─ 모든 액션들의 onConnectionState 콜백 호출
│       └─ connectionState: "BROKEN"로 업데이트
│
├─ ws = null (참조 정리)
│
├─ isConnecting = false
│
└─ scheduleReconnect()
    ├─ subscriptions.size === 0 인가?
    │   ├─ YES: 재연결 스킵 (구독 없음)
    │   └─ NO: 계속 진행
    │
    └─ 5초 후 setTimeout(() => connect())
```

### 재연결 성공

```
[5초 후]
│
├─ connect() 자동 호출
│
├─ WebSocket 재생성
│
├─ 열기/메시지/에러 핸들러 재등록
│
├─ open 이벤트
│   ├─ 모든 구독 재전송
│   ├─ subscriptions의 모든 항목
│   └─ 각 액션의 onConnectionState("LIVE") 콜백 호출
│
└─ 데이터 수신 재개
    └─ 실시간 시세 다시 갱신
```

**재연결 특성**

```
- 간격: 고정 5초 (지수 백오프 아님)
- 조건: subscriptions.size > 0 (구독이 있을 때만)
- 상태: BROKEN → 재연결 중 → LIVE
- 타임아웃: 10초 (open 이벤트 없으면 재시도)
```

---

## 데이터 필드 파싱 흐름

### 국내주식 (H0UNCNT0)

```
[WebSocket 메시지]
│
├─ |H0UNCNT0|설정|005930^87000^1^500^0.58^...
│
├─ 필드 배열로 변환
│   └─ ["005930", "87000", "1", "500", "0.58", ...]
│
↓
[parseDomesticData(fields, stockName)]
│
├─ 필드 인덱스 매핑
│   ├─ field[0]: "005930" (주식코드)
│   ├─ field[1]: "87000" (현재가)
│   ├─ field[2]: "1" (부호: 1=상승, 2=하락, 3=보합)
│   ├─ field[3]: "500" (변동량)
│   └─ field[4]: "0.58" (변동률%)
│
├─ 타입 변환
│   ├─ price = parseInt(field[1]) = 87000
│   ├─ change = field[2] === "1" ? parseInt(field[3]) : -parseInt(field[3])
│   ├─ changeRate = parseFloat(field[4])
│   └─ sign = field[2] === "1" ? "rise" : field[2] === "2" ? "fall" : "flat"
│
├─ StockData 객체 생성
│   └─ {
│        ticker: "005930",
│        name: "삼성전자",
│        price: 87000,
│        change: 500,
│        changeRate: 0.58,
│        sign: "rise"
│      }
│
↓
[렌더링]
│
└─ SVG 카드 생성
    ├─ 가격 표시: 87,000
    ├─ 변동: ▲ 500 (상승)
    ├─ 변동률: 0.58%
    └─ 색상: 초록색 (상승)
```

### 해외주식 (HDFSCNT0)

```
[WebSocket 메시지]
│
├─ |HDFSCNT0|설정|DNASPLTR^PLTR^182.52^1^1.25^0.69^...
│
├─ 필드 배열로 변환
│   └─ ["DNASPLTR", "PLTR", "182.52", "1", "1.25", "0.69", ...]
│
↓
[parseOverseasData(fields, stockName, exchange)]
│
├─ 필드 인덱스 매핑
│   ├─ field[0]: "DNASPLTR" (실시간키)
│   ├─ field[1]: "PLTR" (티커)
│   ├─ field[2]: "182.52" (현재가, 달러)
│   ├─ field[3]: "1" (부호)
│   ├─ field[4]: "1.25" (변동량)
│   └─ field[5]: "0.69" (변동률%)
│
├─ 타입 변환
│   ├─ price = parseFloat(field[2]) = 182.52
│   ├─ change = field[3] === "1" ? parseFloat(field[4]) : -parseFloat(field[4])
│   ├─ changeRate = parseFloat(field[5])
│   └─ sign = field[3] === "1" ? "rise" : field[3] === "2" ? "fall" : "flat"
│
├─ StockData 객체 생성
│   └─ {
│        ticker: "PLTR",
│        name: "Palantir",
│        price: 182.52,
│        change: 1.25,
│        changeRate: 0.69,
│        sign: "rise"
│      }
│
↓
[렌더링]
│
└─ SVG 카드 생성
    ├─ 가격 표시: $182.52
    ├─ 변동: ▲ $1.25 (상승)
    ├─ 변동률: 0.69%
    └─ 색상: 초록색 (상승)
```

---

## SVG 렌더링 흐름

### 렌더링 프로세스

```
[StockData 객체]
│
├─ { ticker, name, price, change, changeRate, sign }
│
↓
[renderStockCard(data, options)]
│
├─ 1. 마켓 세션 판단
│   ├─ getMarketSession(market: Market)
│   │   ├─ 국내: KST 기준 08:30~09:00(PRE), 09:00~15:30(REG), 15:40~18:00(AFT), CLOSED
│   │   └─ 해외: ET 기준 (DST 반영) + 주간거래 09:00~15:30 KST
│   │
│   └─ 세션별 색상 결정
│       ├─ REG: #00c853 (초록, 정규장)
│       ├─ PRE/AFT: #ff9800 (주황)
│       └─ CLOSED: #616161 (회색)
│
├─ 2. 가격 형식 변환
│   ├─ formatPrice(price, market)
│   │   ├─ 국내: KR_INT_FORMAT.format(price) → "87,000"
│   │   └─ 해외: `$${price.toFixed(2)}` → "$182.52"
│   │
│   └─ formatChangeWithArrow(change, sign, market)
│       ├─ 상승: "▲ 500" (국내) / "▲ $1.25" (해외)
│       └─ 하락: "▼ 500" / "▼ $1.25"
│
├─ 3. 색상 선택
│   ├─ sign 기반
│   │   ├─ rise: #00c853 (초록)
│   │   ├─ fall: #ff1744 (빨강)
│   │   └─ flat: #9e9e9e (회색)
│   │
│   └─ connectionState 기반
│       ├─ LIVE: #00c853
│       ├─ BACKUP: #ffd54f (노랑)
│       └─ BROKEN: #ff1744
│
├─ 4. SVG 생성
│   ├─ 배경: 144x144px, 둥근 모서리, 어두운 배경색
│   ├─ 종목명: 상단 (stale 시 노란색)
│   ├─ 현재가: 중앙 (큰 폰트)
│   ├─ 변동 정보: 하단 (화살표 + 색상)
│   ├─ 세션 아이콘: 우상단 (세션 상태 표시)
│   └─ 연결 상태 바: 하단 (LIVE/BACKUP/BROKEN 색상)
│
↓
[Data URI 변환 및 캐싱]
│
├─ svgToDataUri(svg: string): string
│   ├─ 캐시 확인
│   │   ├─ 있음: 캐시된 Data URI 반환
│   │   └─ 없음: 계속
│   │
│   ├─ 캐시 생성
│   │   ├─ btoa(svg) → Base64 인코딩
│   │   ├─ `data:image/svg+xml;base64,${base64}` 생성
│   │   └─ 캐시에 저장 (최대 200개)
│   │
│   └─ Data URI 반환
│
↓
[Stream Deck 아이콘 설정]
│
├─ action.setImage(dataUri)
│   └─ Stream Deck 호스트에 전송
│
↓
[Stream Deck 버튼 표시]
│
└─ 아이콘 업데이트
```

### 특별한 렌더링 상태

**로딩 중 (renderWaitingCard)**
```
- 종목명: 상단
- 텍스트: "로딩 중..." (3줄)
- 애니메이션: 없음 (정적 이미지)
- 용도: onWillAppear 시 첫 표시
```

**연결됨 (renderConnectedCard)**
```
- 종목명: 상단
- 텍스트: "연결 중..." (3줄)
- 색상: 초록색 (LIVE 표시)
- 용도: WebSocket 구독 성공 시
```

**설정 필요 (renderSetupCard)**
```
- 메시지: 사용자 제공 텍스트 (예: "종목코드를 설정하세요")
- 용도: onWillAppear 시 설정 없을 때
```

---

## Stale 데이터 감지 및 처리

### Stale 타임아웃

```
[데이터 수신]
│
├─ renderStockData() 호출
│
├─ staleTimer 설정
│   ├─ 기존 타이머 취소
│   └─ 새로운 타이머 설정 (20초)
│
↓
[20초 경과 (데이터 미수신)]
│
├─ staleTimer 발동
│
├─ lastDataAtByAction 확인
│   └─ 마지막 데이터 시간과 현재 비교
│
├─ isStale = true
│   └─ renderStockData()에 { isStale: true } 전달
│
├─ SVG 렌더링 시 변화
│   ├─ 종목명 색상: 노란색 (#ffd54f)로 변경
│   └─ "데이터 갱신 중..." 텍스트 표시 (선택적)
│
↓
[WebSocket 재연결]
│
├─ 새로운 데이터 수신
│
├─ staleTimer 재설정
│   └─ isStale = false
│
└─ 정상 색상으로 복구
```

---

## 연결 상태 전환 로직

### 상태 관리

```
초기 상태: BROKEN (또는 설정 필요)

applyConnectionState(actionId, state)
  ├─ 현재 상태 확인
  ├─ 상태 변경 여부 확인
  │   ├─ 변경 없음: 반환
  │   └─ 변경 있음: 계속
  │
  ├─ 상태 전환 타이머 확인
  │   ├─ 타이머 실행 중: 새로운 상태만 기록, 실제 변경은 보류
  │   └─ 타이머 없음: 즉시 상태 변경
  │
  ├─ 상태 변경 시간 기록
  └─ 1.5초 타이머 시작 (상태 변경 최소 유지 시간)

결과:
  - 빈번한 상태 변경 완화 (최소 1.5초 유지)
  - 깜빡임(flicker) 방지
  - UI 안정성 향상
```

**상태 전환 다이어그램**

```
       ┌─────────────────────────────────────────┐
       │  BROKEN (연결 실패/장 종료)              │
       │  - 아이콘: 회색 또는 빨강                 │
       │  - 데이터: REST API 스냅샷 (BACKUP)      │
       └─────────────────────────────────────────┘
                      ↑         ↓
                      │    (WebSocket 연결)
                      │
       ┌──────────────────────────────────────────┐
       │  BACKUP (REST API 사용)                 │
       │  - 아이콘: 노란색 (대체 경로)            │
       │  - 데이터: REST API 스냅샷               │
       └──────────────────────────────────────────┘
                      ↑         ↓
                      │    (WebSocket 데이터 수신)
                      │
       ┌──────────────────────────────────────────┐
       │  LIVE (WebSocket 실시간)                │
       │  - 아이콘: 초록색 (정상)                 │
       │  - 데이터: WebSocket 실시간 시세         │
       └──────────────────────────────────────────┘
```

---

## 요청 동시성 관리

### Refresh In-Flight 추적

```
[REST API 호출 필요]
│
├─ fetchAndShowPrice()
│
├─ refreshInFlight.has(actionId) 확인
│   ├─ YES: 이미 진행 중 → 스킵
│   └─ NO: 계속
│
├─ refreshInFlight.add(actionId) (시작 표시)
│
├─ REST API 호출
│   ├─ fetchDomesticPrice(stockCode)
│   │   ├─ getAccessToken() → 캐시/발급
│   │   └─ REST API GET 요청
│   │
│   └─ 응답 처리
│       ├─ 성공: 데이터 파싱 및 렌더링
│       └─ 실패: null 반환
│
├─ refreshInFlight.delete(actionId) (종료 표시)
│
└─ 결과
    - 동시 중복 요청 방지
    - 네트워크 트래픽 절감
    - API 응답 대기 간단화
```

### Token In-Flight 추적 (auth.ts)

```
accessTokenInFlight = null (초기)

getAccessToken() 호출
  ├─ accessTokenInFlight 확인
  │   ├─ 발급 중: 기존 Promise 반환 (중복 방지)
  │   └─ 미발급: 새로운 발급 프로세스 시작
  │
  ├─ accessTokenInFlight = 새로운 Promise
  ├─ 토큰 발급 API 호출
  │
  └─ finally
      └─ accessTokenInFlight = null (정리)

결과:
  - 1분당 1회 제한 (EGW00133) 회피
  - 복수 액션 동시 구독 시 효율성
```

