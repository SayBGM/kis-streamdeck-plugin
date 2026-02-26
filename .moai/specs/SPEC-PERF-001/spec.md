---
id: SPEC-PERF-001
version: "1.1.0"
status: completed
created: "2026-02-27"
updated: "2026-02-27"
author: 광민
priority: high
---

## HISTORY

- 2026-02-27 v1.0.0: Initial creation
- 2026-02-27 v1.1.0: Implementation completed (sync phase)

## Implementation Notes

구현 완료 (DDD ANALYZE-PRESERVE-IMPROVE 사이클):

**구현된 항목 (TASK-001 ~ TASK-012):**
- TASK-001: `scheduleReconnect()` 특성 테스트 5개 (vitest 도입)
- TASK-002~003: 지수 백오프 + ±10% 지터 재연결 (`RECONNECT_BASE_DELAY_MS=5000`, `RECONNECT_MAX_DELAY_MS=60000`)
- TASK-004: LRU 캐시 크기 200 → 500
- TASK-005: `makeRenderKey()` 부동소수점 정규화 (`.toFixed(2)`)
- TASK-006: `svgToDataUri()` 특성 테스트 6개
- TASK-007: `svgToDataUri()` 의미론적 캐시 키 (`semanticKey` 파라미터)
- TASK-008: `renderStockData()` 특성 테스트 5개
- TASK-009~010: `setImage()` 50ms 디바운싱 (국내/해외주식)
- TASK-011: `updateSettings()` 특성 테스트 8개
- TASK-012: `approval_key` 30분 자동 갱신 타이머

**의도적으로 연기된 항목:**
- TASK-013: 클라이언트 PING heartbeat — KIS WebSocket API PING 메시지 포맷 문서화 필요. 현재 서버 PINGPONG 에코 방식으로 충분히 동작 중.

**테스트:** 24/24 통과, TypeScript 0 에러, 빌드 성공

---

# SPEC-PERF-001: WebSocket 연결 안정성 및 SVG 렌더링 성능 극한 최적화

## 1. 개요 (Overview)

### 1.1 목적

KIS StreamDeck 플러그인(v1.1.0)의 두 가지 핵심 영역을 개선한다.

**연결 안정성:** `approval_key` 만료로 인한 조용한 인증 실패를 제거하고, 재연결 시 thundering herd 현상을 방지하며, 클라이언트 측 heartbeat를 통해 연결 단절 감지 시간을 단축한다.

**렌더링 성능:** SVG DataURI LRU 캐시의 키 비교 비용을 의미론적 키로 절감하고, `setImage()` IPC 호출 횟수를 디바운싱으로 대폭 감소시킨다.

### 1.2 범위

이 SPEC은 다음 파일의 변경을 포함한다:

| 파일 | 변경 영역 |
|------|-----------|
| `src/kis/websocket-manager.ts` | approval_key 갱신 타이머, 지수 백오프, 클라이언트 PING heartbeat |
| `src/renderer/stock-card.ts` | 의미론적 캐시 키, LRU 캐시 크기 증가 |
| `src/actions/domestic-stock.ts` | setImage() 디바운싱, 렌더 키 정밀도 정규화 |
| `src/actions/overseas-stock.ts` | setImage() 디바운싱, 렌더 키 정밀도 정규화 |

이 SPEC은 KIS WebSocket API 프로토콜 자체의 변경, 신규 주식 종목 타입 지원, UI 디자인 변경은 포함하지 않는다.

### 1.3 관련 모듈

- `src/kis/websocket-manager.ts` — WebSocket 연결 수명 주기 관리
- `src/kis/auth.ts` — approval_key 발급 및 in-flight 중복 제거 패턴 (참조 구현)
- `src/renderer/stock-card.ts` — SVG 생성 및 DataURI LRU 캐시
- `src/actions/domestic-stock.ts` — 국내주식 액션 렌더링 파이프라인
- `src/actions/overseas-stock.ts` — 해외주식 액션 렌더링 파이프라인

---

## 2. 환경 (Environment)

### 2.1 기술 스택

- **언어:** TypeScript 5.7.0, strict 모드
- **런타임:** Electron (Stream Deck 플러그인 호스트)
- **외부 API:** KIS WebSocket API (한국투자증권)
- **빌드 도구:** 기존 프로젝트 빌드 시스템

### 2.2 현재 상태 (As-Is)

**연결 안정성 문제:**
- `approval_key`는 `updateSettings()` 호출 시 1회만 발급되며, WebSocket이 활성인 동안 갱신 없음
- 재연결 딜레이: 고정 5,000ms (`RECONNECT_DELAY_MS` 상수)
- 연결 단절 감지: 서버 PINGPONG 에코 방식 의존, 최대 20초 소요 가능

**렌더링 성능 문제:**
- SVG DataURI 캐시 키: 전체 SVG 문자열 (~300자)
- `setImage()` 호출: 렌더 키 변경 시 즉시 호출 (디바운싱 없음)
- LRU 캐시 최대 크기: 200개 (`SVG_DATA_URI_CACHE_MAX_ENTRIES`)
- 렌더 키 정밀도: 국내/해외주식 간 부동소수점 처리 불일치

---

## 3. 가정 (Assumptions)

| ID | 가정 | 신뢰도 | 위반 시 영향 |
|----|------|--------|------------|
| A1 | KIS WebSocket API의 `approval_key`는 장시간 후 만료될 수 있다 | 높음 | 신규 구독 시 `EGW00133` 오류 발생 |
| A2 | 30분 주기 갱신은 KIS API 레이트 리밋에 저촉되지 않는다 | 높음 | in-flight 중복 제거로 완화 |
| A3 | 50ms 디바운스 딜레이는 사용자가 시각적으로 인지하기 어렵다 | 중간 | 빠른 시장 데이터에서 지연 체감 가능 |
| A4 | LRU 캐시 500개 확장 시 메모리 증가는 1.5MB 이내이다 | 높음 | 메모리 제약 환경에서 문제 가능 |
| A5 | 의미론적 캐시 키(`ticker|price|change|...`)는 SVG 내용과 1:1로 대응한다 | 높음 | 테마 변경 시 캐시 무효화 필요 |
| A6 | 클라이언트 측 PING 형식은 KIS API 문서 확인 후 결정한다 | 중간 | API 비호환 시 연결 장애 가능 |

---

## 4. 요구사항 (Requirements)

### 모듈 1: 연결 안정성 강화 (Connection Stability)

#### 1.1 approval_key 자동 갱신

**REQ-PERF-001-1.1.1 (COMPLEX)**
WHILE WebSocket 연결이 활성 상태이고, WHEN 마지막 approval_key 발급으로부터 30분이 경과하면, 시스템은 KIS API에서 새 approval_key를 발급받고 기존 WebSocket 연결을 중단하지 않고 `this.approvalKey`를 갱신해야 한다.

**REQ-PERF-001-1.1.2 (UNWANTED BEHAVIOR)**
IF approval_key 갱신 요청이 동시에 2개 이상 발생하면, 시스템은 첫 번째 요청의 응답을 공유하고 중복 KIS API 호출을 방지해야 한다. (`src/kis/auth.ts:151-153`의 `accessTokenInFlight` 패턴 참조)

**REQ-PERF-001-1.1.3 (UNWANTED BEHAVIOR)**
IF approval_key 갱신 API 호출이 실패하면, 시스템은 기존 approval_key를 계속 사용하고 30초 후 재시도하며, 실패를 에러 레벨로 로깅해야 한다.

**REQ-PERF-001-1.1.4 (EVENT-DRIVEN)**
WHEN `safeDisconnect()`가 호출되면, 시스템은 `approvalKeyRefreshTimer`를 즉시 정리(clearInterval)해야 한다.

#### 1.2 지수 백오프 재연결

**REQ-PERF-001-1.2.1 (EVENT-DRIVEN)**
WHEN WebSocket 연결이 끊어지고 활성 구독이 1개 이상 존재하면, 시스템은 지수 백오프 딜레이(기준 5초, 최대 60초)와 ±10% jitter를 적용하여 재연결을 시도해야 한다.

딜레이 계산 공식:
```
baseDelay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000)
jitter     = baseDelay * (Math.random() * 0.2 - 0.1)
delay      = baseDelay + jitter
```

**REQ-PERF-001-1.2.2 (EVENT-DRIVEN)**
WHEN WebSocket 재연결이 성공하면, 시스템은 `reconnectAttempts` 카운터를 0으로 리셋해야 한다.

**REQ-PERF-001-1.2.3 (STATE-DRIVEN)**
WHILE 재연결을 시도하는 동안, 시스템은 모든 기존 구독 상태(`this.subscriptions`)를 보존하고 연결 성공 후 자동으로 재구독해야 한다.

**REQ-PERF-001-1.2.4 (UBIQUITOUS)**
The system shall replace the `RECONNECT_DELAY_MS` constant with `RECONNECT_BASE_DELAY_MS` (5000) and `RECONNECT_MAX_DELAY_MS` (60000) constants.

#### 1.3 클라이언트 heartbeat

**REQ-PERF-001-1.3.1 (STATE-DRIVEN)**
WHILE WebSocket 연결이 활성 상태이면, 시스템은 30초 간격으로 클라이언트 측 PING을 전송해야 한다.

**REQ-PERF-001-1.3.2 (UNWANTED BEHAVIOR)**
IF PING 전송 후 10초 이내에 서버로부터 아무 응답이 없으면, 시스템은 연결이 단절된 것으로 판단하고 `safeDisconnect()`를 호출한 뒤 재연결 시퀀스를 시작해야 한다.

**REQ-PERF-001-1.3.3 (UBIQUITOUS)**
The system shall preserve the existing server PINGPONG echo logic at `websocket-manager.ts:256-259` without modification. Client heartbeat is an independent addition.

**REQ-PERF-001-1.3.4 (EVENT-DRIVEN)**
WHEN `safeDisconnect()`가 호출되면, 시스템은 `clientPingTimer`와 `pongTimeoutTimer`를 모두 즉시 정리해야 한다.

---

### 모듈 2: 렌더링 성능 최적화 (Rendering Performance)

#### 2.1 의미론적 캐시 키

**REQ-PERF-001-2.1.1 (UBIQUITOUS)**
The system shall use a semantic cache key in the format `${ticker}|${price}|${change}|${changeRate}|${sign}|${connectionState}|${isStale}` for the SVG DataURI LRU cache, instead of the full SVG string.

예시: `005930|75400.00|200.00|0.27|2|LIVE|FRESH`

**REQ-PERF-001-2.1.2 (EVENT-DRIVEN)**
WHEN SVG DataURI 캐시가 조회되면, 시스템은 의미론적 키로 조회하고 캐시 히트 시 LRU 순서를 갱신하며 DataURI를 반환해야 한다.

**REQ-PERF-001-2.1.3 (UBIQUITOUS)**
The system shall update the `svgToDataUri()` function signature to accept a `semanticKey` parameter in addition to the `svg` string parameter.

#### 2.2 setImage() 디바운싱

**REQ-PERF-001-2.2.1 (EVENT-DRIVEN)**
WHEN 주식 데이터 또는 연결 상태가 변경되면, 시스템은 `setImage()` 호출을 즉시 실행하지 않고 50ms 디바운스 큐에 등록해야 한다.

**REQ-PERF-001-2.2.2 (COMPLEX)**
WHILE 디바운스 타이머가 활성 상태이고, IF 동일 액션에 대해 새로운 업데이트가 도착하면, 시스템은 대기 중인 업데이트를 새 데이터로 교체해야 한다 (last-write-wins).

**REQ-PERF-001-2.2.3 (EVENT-DRIVEN)**
WHEN 50ms 디바운스 타이머가 실행되면, 시스템은 대기 중인 모든 액션의 `setImage()`를 일괄 호출하고 pending 맵을 비워야 한다.

**REQ-PERF-001-2.2.4 (UBIQUITOUS)**
The system shall implement `pendingRenderByAction: Map<string, PendingRender>` in each action class, with the following interface:

```typescript
interface PendingRender {
  action: { setImage(image: string): Promise<void> | void };
  dataUri: string;
  renderKey: string;
}
```

#### 2.3 LRU 캐시 크기

**REQ-PERF-001-2.3.1 (UBIQUITOUS)**
The system shall maintain an SVG DataURI LRU cache with a maximum capacity of 500 entries, increased from the current 200. (`SVG_DATA_URI_CACHE_MAX_ENTRIES = 500`)

#### 2.4 렌더 키 정밀도

**REQ-PERF-001-2.4.1 (UBIQUITOUS)**
The system shall normalize all floating-point values — `price`, `change`, `changeRate` — to 2 decimal places using `.toFixed(2)` in the `makeRenderKey()` function of both `domestic-stock.ts` and `overseas-stock.ts`.

---

## 5. 비기능 요구사항 (Non-Functional Requirements)

**REQ-PERF-001-NF-01 (UBIQUITOUS)**
The system shall maintain full backward compatibility with the KIS WebSocket API protocol throughout all optimizations.

**REQ-PERF-001-NF-02 (UBIQUITOUS)**
The system shall not introduce more than 50ms additional latency to the stock data display pipeline as a result of debouncing.

**REQ-PERF-001-NF-03 (EVENT-DRIVEN)**
WHEN 액션이 소멸되거나 플러그인이 종료되면, 시스템은 모든 타이머(`approvalKeyRefreshTimer`, `clientPingTimer`, `pongTimeoutTimer`, 디바운스 타이머)를 정리해야 한다.

**REQ-PERF-001-NF-04 (UBIQUITOUS)**
The system shall comply with TypeScript strict mode throughout all new and modified code.

---

## 6. 구현 제약 (Implementation Constraints)

| 제약 | 설명 |
|------|------|
| KIS WebSocket API 호환성 | 기존 API 프로토콜 규격 변경 불가 |
| 기존 PINGPONG 로직 유지 | `websocket-manager.ts:256-259` 서버 PINGPONG 에코 로직 수정 없이 유지 |
| 플러그인 시작 시간 영향 없음 | approval_key 갱신 타이머가 초기 연결 속도를 저하하면 안 됨 |
| 활성 구독 유지 | approval_key 갱신 중 기존 WebSocket 구독이 끊어지면 안 됨 |
| TypeScript strict 모드 | `tsconfig.json` strict 모드 준수 필수 |
| PING 형식 확인 선행 | 클라이언트 PING 구현 전 KIS WebSocket API 공식 문서로 PING 형식 검증 필수 |

---

## 7. MX 태그 계획

| 대상 파일 | 대상 함수/위치 | 태그 | 이유 |
|-----------|------------|------|------|
| `src/kis/websocket-manager.ts` | approval_key 갱신 함수 (신규) | `@MX:ANCHOR` | 연결 수명 전체에 영향하는 공개 계약 — fan_in >= 3 예상 |
| `src/kis/websocket-manager.ts` | `scheduleReconnect()` | `@MX:NOTE` | 지수 백오프 + jitter 알고리즘 공식 문서화 |
| `src/kis/websocket-manager.ts` | 클라이언트 PING 타이머 (신규) | `@MX:WARN` | 타이머 미정리 시 메모리 누수 위험 |
| `src/renderer/stock-card.ts` | `svgToDataUri()` | `@MX:NOTE` | 의미론적 캐시 키 형식과 1:1 대응 조건 문서화 |
| `src/actions/domestic-stock.ts` | setImage() 디바운스 flush 함수 | `@MX:NOTE` | last-write-wins 의미론 및 50ms 상한 설명 |
| `src/actions/overseas-stock.ts` | setImage() 디바운스 flush 함수 | `@MX:NOTE` | last-write-wins 의미론 및 50ms 상한 설명 |

> `@MX:WARN`과 `@MX:ANCHOR` 태그는 반드시 `@MX:REASON` 하위 라인을 포함해야 한다.

---

## 8. 추적성 (Traceability)

| 요구사항 ID | 관련 파일 | 마일스톤 |
|-------------|-----------|----------|
| REQ-PERF-001-1.1.x | `src/kis/websocket-manager.ts` | Secondary Goal |
| REQ-PERF-001-1.2.x | `src/kis/websocket-manager.ts` | Primary Goal |
| REQ-PERF-001-1.3.x | `src/kis/websocket-manager.ts` | Final Goal |
| REQ-PERF-001-2.1.x | `src/renderer/stock-card.ts` | Secondary Goal |
| REQ-PERF-001-2.2.x | `src/actions/domestic-stock.ts`, `src/actions/overseas-stock.ts` | Secondary Goal |
| REQ-PERF-001-2.3.1 | `src/renderer/stock-card.ts` | Primary Goal |
| REQ-PERF-001-2.4.1 | `src/actions/domestic-stock.ts`, `src/actions/overseas-stock.ts` | Primary Goal |
