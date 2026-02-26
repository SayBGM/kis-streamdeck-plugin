# SPEC-PERF-001 구현 계획

## 1. SPEC 식별 정보

| 항목 | 내용 |
|------|------|
| **SPEC ID** | SPEC-PERF-001 |
| **제목** | WebSocket 연결 안정성 및 SVG 렌더링 성능 극한 최적화 |
| **도메인** | PERF (Performance) |
| **우선순위** | HIGH |
| **상태** | Planned |
| **방법론** | DDD (ANALYZE-PRESERVE-IMPROVE) — 기존 코드 보존 중심 |

---

## 2. 문제 정의

### 2.1 현재 상태

KIS StreamDeck 플러그인(v1.1.0)은 실시간 주식 시세를 Stream Deck 버튼에 표시하는 플러그인입니다. 현재 다음 두 가지 영역에서 개선이 필요합니다:

**연결 안정성:**
- WebSocket 연결이 장시간 유지될 경우 `approval_key`가 만료되어 신규 구독 시 조용히 인증 실패 발생 가능
- 재연결 실패 시 5초 고정 딜레이로 재시도하여, 다수 클라이언트 동시 실패 시 서버에 thundering herd 현상 유발
- 클라이언트 측 heartbeat 없이 서버 PINGPONG에만 의존하여 연결 단절을 최대 20초까지 감지하지 못함

**렌더링 성능:**
- SVG 캐시 키로 300자 이상의 전체 SVG 문자열을 사용하여 키 비교 비용이 불필요하게 큼
- `setImage()` IPC 호출(10~50ms)이 파이프라인 최대 병목이나 디바운싱 미적용으로 10Hz 업데이트 시 최대 100회/초 호출 가능
- LRU 캐시 크기 200개로 10종목 이상 활성 시 잦은 캐시 퇴거 발생
- 국내/해외 주식 간 렌더 키 정밀도 기준 불일치로 불필요한 재렌더 발생 가능

### 2.2 개선 목표

1. `approval_key` 만료로 인한 조용한 인증 실패를 완전 제거
2. 재연결 시 서버 부하를 지수 백오프 + jitter로 5~10배 감소
3. 연결 단절 감지 시간을 최대 20초에서 10초 이내로 단축
4. `setImage()` IPC 호출 횟수를 디바운싱으로 90% 감소
5. SVG 캐시 히트율 향상으로 `encodeURIComponent()` 슬로우 패스 회피

---

## 3. 모듈 1: 연결 안정성 강화 (Connection Stability)

### 3.1 approval_key 30분 주기 갱신

**대상 파일:** `src/kis/websocket-manager.ts`

**현재 코드 위치:** lines 74-76 (`updateSettings()` 내부)

**현재 동작:**
```
updateSettings() 호출 시 → approval_key 1회 발급 → WebSocket 활성 중 갱신 없음
```

**문제점:** approval_key는 한 번만 발급되며 WebSocket이 활성 상태인 동안 갱신되지 않습니다. 연결이 24시간 이상 유지될 경우 key가 만료되어 신규 구독 시 `EGW00133` 오류가 조용히 발생할 수 있습니다.

**개선 접근법:**
- `KISWebSocketManager` 클래스에 `approvalKeyRefreshTimer` 필드 추가
- WebSocket 연결 성공 후 30분 간격으로 `approval_key`를 proactive 갱신하는 타이머 시작
- 갱신 시 WebSocket 연결은 유지하고 `this.approvalKey`만 업데이트
- `safeDisconnect()` 호출 시 갱신 타이머 함께 정리
- `auth.ts:151-153`의 in-flight 중복 제거 패턴 참조하여 동시 갱신 요청 병합

**참조 구현:** `src/kis/auth.ts:151-153` — `accessTokenInFlight` 패턴

**갱신 타이머 로직 개요:**
```
WebSocket 연결 성공 시
  → clearInterval(approvalKeyRefreshTimer)  // 중복 방지
  → approvalKeyRefreshTimer = setInterval(refresh, 30분)

refresh() 함수:
  → if (갱신 중복 요청) return 기존 Promise  // in-flight 패턴
  → 새 approval_key 발급
  → this.approvalKey 업데이트
  → 로그 기록

safeDisconnect() 시:
  → clearInterval(approvalKeyRefreshTimer)
  → approvalKeyRefreshTimer = null
```

**위험 요소:** KIS API `EGW00133` 레이트 리밋

**완화 방안:** in-flight 중복 제거 + 30분 캐시 TTL 적용

---

### 3.2 지수 백오프 + Jitter 재연결

**대상 파일:** `src/kis/websocket-manager.ts`

**현재 코드 위치:** lines 469-482 (`scheduleReconnect()` 함수), line 39 (`RECONNECT_DELAY_MS` 상수)

**현재 동작:**
```typescript
// 현재: 5초 고정 딜레이
const RECONNECT_DELAY_MS = 5000;
this.reconnectTimer = setTimeout(() => { ... }, RECONNECT_DELAY_MS);
```

**문제점:** 고정 5초 딜레이는 다수 클라이언트가 동시에 실패할 경우 서버에 동일 시간에 대량의 재연결 요청이 몰리는 thundering herd 현상을 유발합니다.

**개선 접근법:**
- `KISWebSocketManager` 클래스에 `reconnectAttempts` 카운터 필드 추가
- `scheduleReconnect()`에서 지수 증가 + jitter 계산으로 딜레이 결정
- 연결 성공 시 `reconnectAttempts = 0` 리셋
- 연결 실패 시마다 카운터 증가

**지수 백오프 공식:**
```
baseDelay = Math.min(5000 * Math.pow(2, attempt), 60000)
jitter     = baseDelay * (Math.random() * 0.2 - 0.1)  // ±10%
delay      = baseDelay + jitter

시도별 딜레이 (jitter 제외):
  attempt 0 → 5,000ms  (5초)
  attempt 1 → 10,000ms (10초)
  attempt 2 → 20,000ms (20초)
  attempt 3 → 40,000ms (40초)
  attempt 4+ → 60,000ms (60초 상한)
```

**상수 변경:**
- 기존 `RECONNECT_DELAY_MS = 5000` 상수 → `RECONNECT_BASE_DELAY_MS`, `RECONNECT_MAX_DELAY_MS` 로 분리
- `MAX_RECONNECT_ATTEMPTS` 상수 제거 (무한 재시도 유지)

**위험 요소:** 지수 백오프로 일시적 장애 회복 시 복구가 최대 60초 지연

**완화 방안:** 상한을 60초로 제한하여 최악의 경우도 1분 내 재시도 보장

---

### 3.3 클라이언트 측 PING heartbeat

**대상 파일:** `src/kis/websocket-manager.ts`

**현재 코드 위치:** lines 256-259, 285-287 (서버 PINGPONG 에코 핸들러)

**현재 동작:**
```typescript
if (trId === "PINGPONG") {
  this.ws?.send(rawData);  // 서버가 보낸 PINGPONG을 그대로 에코
  return;
}
```

**문제점:** 클라이언트는 서버가 PINGPONG을 보낼 때만 반응합니다. 서버가 PINGPONG을 보내지 않거나 연결이 조용히 끊어진 경우, 데이터가 오지 않아 stale 처리(20초)되기 전까지 연결 단절을 감지하지 못합니다.

**개선 접근법:**
- `KISWebSocketManager` 클래스에 `clientPingTimer`와 `pongTimeoutTimer` 필드 추가
- WebSocket 연결 성공 후 30초 간격으로 클라이언트 PING 전송 타이머 시작
- PING 전송 후 10초 내 PONG 응답 없으면 연결 단절로 판단하고 `safeDisconnect()` 호출
- PONG 수신 시 `pongTimeoutTimer` 취소
- `safeDisconnect()` 호출 시 두 타이머 모두 정리

**주의:** 기존 서버 PINGPONG 에코 로직(lines 256-259)은 그대로 유지합니다. 클라이언트 heartbeat는 이와 별개로 추가되는 기능입니다.

**PING 전송 형식:**
```
KIS WebSocket은 JSON 형식의 PING이 아닌 WebSocket 프로토콜 수준의 ping/pong 또는
KIS API 규격에 따른 별도 형식 확인 필요 → 구현 전 KIS API 문서 검토 필수
```

**위험 요소:** KIS API 규격에서 클라이언트 측 PING 형식이 다를 수 있음

**완화 방안:** 구현 전 KIS WebSocket API 공식 문서 확인 후 올바른 PING 형식 사용

---

## 4. 모듈 2: SVG 렌더링 성능 최적화 (Rendering Performance)

### 4.1 의미론적 LRU 캐시 키

**대상 파일:** `src/renderer/stock-card.ts`

**현재 코드 위치:** lines 311-331 (`svgToDataUri()` 함수), line 44 (캐시 Map 선언)

**현재 동작:**
```typescript
// 캐시 키: 전체 SVG 문자열 (~300자)
const cached = svgDataUriCache.get(svg);  // svg = 300자 문자열
```

**문제점:** 캐시 키가 300자 이상의 SVG 전체 문자열이어서 키 비교 비용이 크고, SVG 내 공백 하나만 달라도 캐시 미스가 발생합니다.

**개선 접근법:**
- `svgToDataUri()` 함수 시그니처 변경: `svg` 문자열 외에 `semanticKey` 파라미터 추가
- 캐시 조회는 `semanticKey`로, 캐시 저장은 `semanticKey → dataUri`로 변경
- 기존 캐시 Map의 key 타입을 의미론적 키 문자열로 변경

**의미론적 키 형식:**
```
${ticker}|${price}|${change}|${changeRate}|${sign}|${connectionState}|${isStale}
```

예시: `005930|75400|200|0.27|2|LIVE|FRESH`

**호출부 변경:** `stock-card.ts`에서 `svgToDataUri(svg)` 호출 부분에 semanticKey 파라미터 전달

**위험 요소:** 의미론적 키가 동일하나 SVG가 다른 경우 (예: 테마 변경 후 캐시 무효화 미처리)

**완화 방안:** 테마/디자인 변경 시 전체 캐시 clear 메커니즘 추가

---

### 4.2 setImage() 디바운싱

**대상 파일:** `src/actions/domestic-stock.ts`, `src/actions/overseas-stock.ts`

**현재 동작:**
```typescript
// domestic-stock.ts makeRenderKey() — 중복 제거는 이미 구현됨
const renderKey = `${data.ticker}|...`;
if (this.lastRenderKeyByAction.get(actionId) === renderKey) return;
await action.setImage(dataUri);  // 즉시 호출
```

**문제점:** 렌더 키가 변경될 때마다 즉시 `setImage()`를 호출합니다. 10Hz 업데이트 × 10종목 = 최대 100회/초 호출이 가능하며, 각 IPC 비용 10~50ms를 감안하면 CPU 부하가 큽니다.

**개선 접근법:**
- 각 액션 클래스에 `pendingRenderByAction: Map<string, PendingRender>` 필드 추가
- `setImage()` 직접 호출 대신 pending 맵에 최신 데이터만 저장 (last-write-wins)
- 50ms 단일 타이머로 모든 pending 렌더를 일괄 flush
- flush 시 pending 맵의 각 항목에 대해 `setImage()` 호출

**PendingRender 타입:**
```typescript
interface PendingRender {
  action: { setImage(image: string): Promise<void> | void };
  dataUri: string;
  renderKey: string;
}
```

**flush 로직 개요:**
```
데이터 수신 시:
  1. 렌더 키 중복 확인 (기존 로직 유지)
  2. 변경 있음 → pendingRenderByAction.set(actionId, { action, dataUri, renderKey })
  3. 아직 flush 타이머 없으면 setTimeout(flush, 50ms) 설정

flush() 실행 시:
  pendingRenderByAction.forEach((pending, actionId) => {
    action.setImage(pending.dataUri)
    lastRenderKeyByAction.set(actionId, pending.renderKey)
  })
  pendingRenderByAction.clear()
  flushTimer = null
```

**주의:** 50ms 딜레이는 최악의 경우에도 눈에 띄는 지연을 유발하지 않는 것으로 간주되지만, 고빈도 업데이트 시나리오에서 사용자 피드백을 통해 검증 필요

**위험 요소:** 50ms 딜레이가 빠른 시장 움직임 시 시각적 지연으로 느껴질 수 있음

**완화 방안:** 50ms 상한 유지, 향후 조정 가능한 상수로 분리

---

### 4.3 LRU 캐시 크기 500으로 증가

**대상 파일:** `src/renderer/stock-card.ts`

**현재 코드 위치:** line 37

**현재 동작:**
```typescript
const SVG_DATA_URI_CACHE_MAX_ENTRIES = 200;
```

**문제점:** 10종목 × 연결 상태(LIVE/BACKUP/BROKEN) × stale 여부(FRESH/STALE) = 최대 60개 캐시 엔트리. 200개면 충분하나 향후 20~30종목 확장 시 퇴거가 빈번해집니다.

**개선 접근법:**
- 상수값을 200 → 500으로 변경
- 메모리 영향 추정: 500 × 평균 3KB(DataURI) = 1.5MB → 허용 범위

**변경 사항:** 단순 상수 변경으로 다른 로직에 영향 없음

---

### 4.4 렌더 키 정밀도 통일

**대상 파일:** `src/actions/domestic-stock.ts`, `src/actions/overseas-stock.ts`

**현재 코드 위치:**
- `domestic-stock.ts:478` — `CHANGE_RATE_PRECISION_DIGITS` 사용
- `overseas-stock.ts` — 별도 확인 필요

**문제점:** 국내주식과 해외주식의 `makeRenderKey()`에서 가격 정밀도(소수점 자리수) 처리 기준이 다를 경우, 동일한 가격이 다른 문자열로 표현되어 불필요한 재렌더가 발생합니다.

**개선 접근법:**
- 양쪽 `makeRenderKey()`에서 모든 부동소수점 가격/변동률을 `.toFixed(2)` 정규화 적용
- `price`, `change`도 `.toFixed(2)` 처리하여 부동소수점 표현 불일치 제거

**주의:** 이미 `domestic-stock.ts`에서 `changeRate.toFixed(CHANGE_RATE_PRECISION_DIGITS)`를 사용 중 — 일관성 검증 후 필요한 부분만 추가

---

## 5. 기술 제약 조건

| 제약 | 설명 |
|------|------|
| KIS WebSocket API 호환성 | 기존 API 규격을 벗어나는 변경 불가 |
| 플러그인 시작 시간 | approval_key 갱신 타이머가 시작 지연을 유발하면 안 됨 |
| 활성 구독 유지 | approval_key 갱신 중 기존 WebSocket 구독이 끊어지면 안 됨 |
| setImage() 지연 허용치 | 디바운싱 딜레이 최대 50ms — 시각적으로 허용 가능한 범위 |
| TypeScript strict 모드 | tsconfig.json strict 모드 준수 필수 |
| 기존 PINGPONG 로직 유지 | 서버 PINGPONG 에코(lines 256-259) 변경 없이 유지 |

---

## 6. 의존성 및 위험 매트릭스

### 6.1 위험 목록

| 위험 | 심각도 | 발생 가능성 | 완화 방안 |
|------|--------|------------|----------|
| approval_key 갱신 시 `EGW00133` 레이트 리밋 | 높음 | 낮음 | in-flight 중복 제거 + 30분 캐시 TTL |
| setImage() 50ms 디바운스로 시각적 지연 | 중간 | 낮음 | 50ms 상한 유지, 조정 가능한 상수 |
| 지수 백오프로 일시적 장애 회복 지연 | 중간 | 낮음 | 5초 시작, 60초 상한 |
| 클라이언트 PING 형식 KIS API 비호환 | 높음 | 중간 | 구현 전 KIS API 문서 확인 필수 |
| 의미론적 캐시 키 충돌 (다른 SVG 동일 키) | 낮음 | 낮음 | 키에 connectionState와 isStale 포함 |
| 캐시 크기 증가(500)로 메모리 증가 | 낮음 | 낮음 | 1.5MB 이내 — 허용 범위 |

### 6.2 모듈 간 의존성

```
Module 1.1 (approval_key 갱신)
  → 독립 구현 가능

Module 1.2 (지수 백오프)
  → 독립 구현 가능 (scheduleReconnect() 수정)

Module 1.3 (클라이언트 PING)
  → KIS API 문서 확인 선행 필요
  → Module 1.1 구현 후 통합 권장

Module 2.1 (의미론적 캐시 키)
  → Module 2.2보다 먼저 구현 권장 (캐시 효율 개선 후 setImage 호출 최적화)

Module 2.2 (setImage 디바운싱)
  → Module 2.4 (렌더 키 정규화) 완료 후 구현

Module 2.3 (LRU 캐시 크기)
  → 독립 구현 가능 (단순 상수 변경)

Module 2.4 (렌더 키 정밀도)
  → 독립 구현 가능
```

---

## 7. 변경 파일 목록

| 파일 | 변경 내용 | 우선순위 |
|------|-----------|---------|
| `src/kis/websocket-manager.ts` | approval_key 30분 갱신 타이머, 지수 백오프, 클라이언트 PING heartbeat | Primary Goal |
| `src/renderer/stock-card.ts` | 의미론적 캐시 키 (`svgToDataUri` 시그니처 변경), LRU 캐시 크기 500으로 증가 | Primary Goal |
| `src/actions/domestic-stock.ts` | setImage() 디바운싱, 렌더 키 정밀도 정규화 | Primary Goal |
| `src/actions/overseas-stock.ts` | setImage() 디바운싱, 렌더 키 정밀도 정규화 | Primary Goal |

---

## 8. 참조 구현

### 8.1 in-flight 중복 제거 패턴

**파일:** `src/kis/auth.ts:151-153`

```typescript
if (accessTokenInFlight && accessTokenInFlightKey === key) {
  return accessTokenInFlight;  // 동시 요청 병합
}
```

approval_key 30분 갱신 타이머에도 동일 패턴 적용 예정.

### 8.2 scheduleReconnect() — 수정 대상

**파일:** `src/kis/websocket-manager.ts:469-482`

```typescript
private scheduleReconnect(): void {
  if (this.subscriptions.size === 0) return;
  if (!this.approvalKey) return;
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  this.reconnectTimer = setTimeout(() => {
    this.connect().catch((err) => {
      logger.error("[WS] 재연결 실패:", err);
      this.scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);  // ← 이 부분을 지수 백오프 + jitter로 교체
}
```

### 8.3 LRU 캐시 — 최적화 대상

**파일:** `src/renderer/stock-card.ts:311-331`

```typescript
export function svgToDataUri(svg: string): string {
  const cached = svgDataUriCache.get(svg);  // ← 키: 300자 SVG 문자열
  if (cached) {
    svgDataUriCache.delete(svg);
    svgDataUriCache.set(svg, cached);
    return cached;
  }
  const dataUri = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  // ...
}
```

의미론적 키 도입으로 get/set 키를 `semanticKey`로 변경.

### 8.4 makeRenderKey() — 정규화 대상

**파일:** `src/actions/domestic-stock.ts:473-480`

```typescript
private makeRenderKey(data: StockData, connectionState, isStale): string {
  const normalizedRate = data.changeRate.toFixed(CHANGE_RATE_PRECISION_DIGITS);
  return `${data.ticker}|${data.name}|${data.price}|${data.change}|${normalizedRate}|...`;
  // ↑ data.price, data.change도 .toFixed(2) 정규화 추가 필요
}
```

---

## 9. MX 태그 전략

| 대상 파일 | 대상 함수/위치 | 태그 | 이유 |
|-----------|--------------|------|------|
| `src/kis/websocket-manager.ts` | approval_key 갱신 함수 (신규) | `@MX:ANCHOR` | 연결 수명 전체에 영향하는 공개 계약 |
| `src/kis/websocket-manager.ts` | `scheduleReconnect()` | `@MX:NOTE` | 지수 백오프 + jitter 알고리즘 설명 |
| `src/kis/websocket-manager.ts` | 클라이언트 PING 타이머 (신규) | `@MX:WARN` | 타이머 미정리 시 메모리 누수 위험 |
| `src/renderer/stock-card.ts` | `svgToDataUri()` | `@MX:NOTE` | 의미론적 캐시 키 형식 문서화 |
| `src/actions/domestic-stock.ts` | setImage() 디바운스 flush 함수 | `@MX:NOTE` | last-write-wins 의미론 설명 |
| `src/actions/overseas-stock.ts` | setImage() 디바운스 flush 함수 | `@MX:NOTE` | last-write-wins 의미론 설명 |

**주의:** `@MX:WARN`과 `@MX:ANCHOR` 태그는 `@MX:REASON` 하위 라인 필수.

---

## 10. 구현 마일스톤

### Primary Goal (1단계) — 핵심 안정성

- Module 1.2: 지수 백오프 + Jitter 재연결 (`scheduleReconnect()` 수정)
- Module 2.3: LRU 캐시 크기 500 증가 (단순 상수 변경)
- Module 2.4: 렌더 키 정밀도 정규화

**이유:** 기존 동작에 영향이 적으면서 안정성을 즉시 개선할 수 있는 항목들.

### Secondary Goal (2단계) — 성능 최적화

- Module 1.1: approval_key 30분 갱신 타이머
- Module 2.1: 의미론적 LRU 캐시 키
- Module 2.2: setImage() 50ms 디바운싱

**이유:** 더 복잡한 로직 변경으로 충분한 테스트가 선행되어야 하는 항목들.

### Final Goal (3단계) — 심화 안정성

- Module 1.3: 클라이언트 측 PING heartbeat

**이유:** KIS API 문서 확인 및 프로토콜 검증이 선행 필요.

### Optional Goal (4단계) — 추가 개선

- setImage() 디바운스 딜레이 설정값 공개 (환경 변수 또는 글로벌 설정)
- 재연결 통계 메트릭 로깅 추가

---

## 11. DDD 방법론 적용 지침

이 SPEC은 기존 코드베이스 위에서 DDD(ANALYZE-PRESERVE-IMPROVE) 방법론으로 구현합니다.

### ANALYZE 단계
- `websocket-manager.ts`, `stock-card.ts`, `domestic-stock.ts`, `overseas-stock.ts`의 현재 동작 파악
- 각 함수의 부수 효과, 타이머, 전역 상태 식별
- 기존 테스트 없음 → characterization test 작성 계획 수립

### PRESERVE 단계
- 각 수정 대상 함수에 대한 characterization test 작성 (현재 동작 스냅샷)
- 특히 `scheduleReconnect()`, `svgToDataUri()`, `makeRenderKey()` 대상
- 테스트 실행하여 현재 동작 기록

### IMPROVE 단계
- Primary Goal → Secondary Goal → Final Goal 순으로 소규모 incremental 변경
- 각 변경 후 characterization test 통과 확인
- 새로운 동작에 대한 specification test 추가

---

*연구 문서 참조: `.moai/specs/SPEC-PERF-001/research.md`*
*생성일: 2026-02-26*
