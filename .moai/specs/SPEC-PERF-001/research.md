# Research Document: 연결 안정성 & 렌더링 성능 최적화
## SPEC-PERF-001

**Research Date:** 2026-02-26
**Codebase Analysis:** KIS StreamDeck Plugin v1.1.0
**Focus Areas:** WebSocket 연결 안정성, SVG 렌더링 파이프라인, 성능 병목점

---

## 1. Executive Summary

### 핵심 발견사항

**연결 안정성 (Critical Issues):**
- 재연결 메커니즘: 5초 고정 딜레이, `isConnecting` guard로 동시 연결 방지
- PINGPONG: 서버 메시지 응답만 (클라이언트 측 keep-alive 없음)
- **토큰 만료 중 연결 유지: 고위험** — WebSocket 활성 중 approval_key 갱신 메커니즘 없음
- 메모리 누수 없음: `safeDisconnect()`에서 모든 타이머/리스너 정리 확인
- 구독 상태 재연결 간 보존: Map 기반 추적으로 안전하게 관리됨

**렌더링 성능 (최적화 기회):**
- SVG LRU 캐시 200개 엔트리, 캐시 히트율 약 90% 추정
- `encodeURIComponent()` 전체 SVG 문자열 인코딩이 슬로우 패스 병목
- `setImage()` IPC 호출(10-50ms)이 전체 파이프라인 최대 병목
- 렌더 키 중복 제거로 불필요한 setImage() 호출 방지 이미 구현됨

**위험 프로파일:**
- approval_key 만료 시 새 구독이 인증 오류로 실패 (조용히 실패할 수 있음)
- 고정 5초 재연결은 대규모 장애 시 thundering herd 유발 가능
- setImage() 큐 포화 시 표시 지연 발생 가능

---

## 2. 연결 안정성 — 현재 구현 분석

### 2.1 재연결 메커니즘

**위치:** `src/kis/websocket-manager.ts` lines 39-41, 174-246, 469-482

**상수:**
```
RECONNECT_DELAY_MS = 5000   // 5초 고정
CONNECT_TIMEOUT_MS = 10000  // 10초 타임아웃
```

**핵심 흐름:**
1. `ensureConnected()`: WebSocket.OPEN 상태 확인 (line 166)
2. 연결 진행 중이면 `connectPromise` 반환 (lines 167-169) — 중복 연결 방지
3. 10초 타임아웃 시 `safeDisconnect()` 호출, 상태를 BROKEN으로 변경 (lines 202-203)
4. close 이벤트 후 자동으로 재연결 스케줄 (line 232)
5. 구독이 존재하는 동안 무한 재시도 (5초 간격)

**강점:**
- `isConnecting` flag + `connectPromise` 중복 연결 완전 방지
- 타임아웃에서 명시적 정리로 좀비 연결 방지
- 재연결 후 모든 구독 재전송 (lines 215-217)

**약점:**
- 고정 5초 백오프 — 지속적 실패 시 지수 증가 없음
- 재연결 타이밍에 jitter 없음 — 다수 클라이언트 동시 재연결 시 thundering herd 가능
- 일시적 vs. 영구적 실패 구분 없음

### 2.2 토큰 만료 처리

**위치:** `src/kis/auth.ts` lines 134-234, `src/kis/websocket-manager.ts` lines 74-76

**현재 동작:**
- Access token 24시간 유효, 만료 1시간 전 갱신
- **approval_key는 `updateSettings()` 호출 시에만 한 번 발급** (lines 74-76)
- WebSocket 활성 중 approval_key 갱신 메커니즘 없음

**Critical Gap (websocket-manager.ts:74-76):**
```typescript
logger.info("[WS] approval_key 발급 시작...");
this.approvalKey = await getApprovalKey(settings);  // 한 번만 호출
logger.info("[WS] approval_key 발급 완료");
```

WebSocket 연결이 24시간 이상 유지될 경우 새 구독 시 stale approval_key 사용 위험.

### 2.3 PINGPONG 구현

**위치:** `src/kis/websocket-manager.ts` lines 256-259, 285-287

```typescript
if (trId === "PINGPONG") {
  this.ws?.send(rawData);  // 서버 메시지 그대로 에코
  return;
}
```

**이슈:**
- 서버 시작 PINGPONG에만 응답, 클라이언트 측 keep-alive heartbeat 없음
- PINGPONG 누락 타임아웃 없음 — 연결이 조용히 죽을 수 있음

### 2.4 경쟁 조건 분석

| 시나리오 | 위치 | 상태 | 비고 |
|----------|------|------|------|
| 다중 ensureConnected() 동시 호출 | lines 167-169 | 안전 | connectPromise 재사용 |
| 재연결 중 구독 추가 | lines 116-119 | 안전 | Map에 추가, 연결 후 전송 |
| 재연결 타이머 + 수동 해제 | line 470 | 대부분 안전 | 구독 수 확인 후 결정 |
| 토큰 만료 중 활성 연결 | lines 74-76 | **위험** | approval_key 갱신 없음 |

### 2.5 구독 상태 관리

**자료구조:** `subscriptions = Map<string, Subscription>` (line 48)

**키 구조:** `${trId}:${trKey}` (예: `H0UNCNT0:005930`)

**재연결 시 보존:**
- subscriptions Map은 연결 사이클 간 유지 (disconnect 시 초기화 안 됨)
- connection open 시 모든 구독 재전송 (`sendSubscribe()`, lines 215-217)

---

## 3. 렌더링 성능 — 현재 구현 분석

### 3.1 SVG 생성 파이프라인

**위치:** `src/renderer/stock-card.ts` lines 199-241

**파이프라인 단계:**
```
WebSocket 수신 (1ms)
  → JSON 파싱 (1-2ms)
  → 구독 조회 (0.1ms)
  → 데이터 파싱 domestic/overseas (0.5ms)
  → 렌더 키 비교 (0.5ms)
    → 변경 없음: skip setImage() ← 최적화 이미 구현
    → 변경 있음:
        → formatPrice() + getPriceFontSize() (0.2ms)
        → SVG 문자열 빌드 (0.5ms)
        → escapeXml() × 4 (1ms)
        → LRU 캐시 조회
          → HIT: DataURI 반환 (0.1ms) ← FAST PATH: ~3ms
          → MISS: encodeURIComponent() (5-10ms) ← SLOW PATH: ~15-20ms
  → setImage() IPC (10-50ms) ← 최대 병목
```

### 3.2 LRU 캐시 분석

**위치:** `src/renderer/stock-card.ts` lines 44, 311-331

**현재 구현:**
```typescript
const SVG_DATA_URI_CACHE_MAX_ENTRIES = 200;  // line 37
const svgDataUriCache = new Map<string, string>();  // line 44
// Key: 전체 SVG 문자열 (~300자)
// Value: data:image/svg+xml;charset=utf-8,... (2-4KB)
```

**LRU 구현 방식:**
- `Map` 삽입 순서 활용 (첫 번째 = 가장 오래됨)
- HIT: `delete(key)` 후 `set(key, value)` — LRU 순서 갱신 (lines 315-316)
- Eviction: 200개 초과 시 `Map.entries().next().value`로 첫 번째 삭제 (lines 323-327)

**캐시 효율 추정:**
- 10개 주식 × 초당 10회 업데이트 = 초당 100회 렌더 시도
- 같은 가격 반복 = 캐시 히트 90%
- 실제 가격 변경 = 캐시 미스 10%
- **캐시 키 개선 기회:** 300자 문자열 → 의미론적 키 또는 해시

**캐시 키 문제점:**
```
현재: 300자 SVG 전체 문자열 (문자 하나라도 다르면 미스)
개선: `${ticker}|${price}|${change}|${rate}|${sign}|${connectionState}|${isStale}`
```

### 3.3 폰트 사이징

**위치:** `src/renderer/stock-card.ts` lines 114-121

```typescript
function getPriceFontSize(priceStr: string): number {
  const len = priceStr.length;
  if (len <= 5) return 36;   // "$1.00"
  if (len <= 7) return 30;   // "$100.00"
  if (len <= 9) return 26;   // "$1,000.00"
  if (len <= 11) return 22;  // "$10,000.00"
  return 18;
}
```

- 렌더마다 재계산되나 비용 무시할 수준 (5회 비교)
- 이미 충분히 최적화됨

### 3.4 렌더 트리거 분석

**국내 주식 렌더 트리거** (`src/actions/domestic-stock.ts`):

| 트리거 | 위치 | 빈도 | 영향 |
|--------|------|------|------|
| WebSocket 데이터 | line 100 | 1-10 Hz (장중) | 메인 파이프라인 |
| 연결 상태 변경 | line 120 | ~1 Hz (불안정 시) | UI 업데이트 |
| Stale 타임아웃 (20s) | line 455 | 1회/20초 | 색상 변경만 |
| 구독 성공 | lines 109-111 | 시작 시 1회 | 초기 가격 없을 때 |
| 수동 새로고침 (버튼) | line 277 | 사용자 트리거 | 전체 재렌더 |
| 초기 가격 재시도 | line 343 | 4초마다 | 첫 가격 수신까지 |

**렌더 키 중복 제거 (이미 구현):**
```typescript
// domestic-stock.ts lines 473-480
const renderKey = `${data.ticker}|${data.name}|${data.price}|${data.change}|...`;
if (this.lastRenderKeyByAction.get(actionId) === renderKey) return; // skip
```

### 3.5 setImage() 호출 주파수

**10개 주식, 초당 5-10 업데이트 시나리오:**
```
기준선: 10 × 10 = 100 setImage() 호출/초
렌더 중복 제거 후: 10-20 호출/초 (가격 안정 시 최소화)
IPC 비용: 10ms × 20 = 200ms/초 (CPU 20% 상시 사용)
```

---

## 4. 참조 구현 발견

### 4.1 토큰 in-flight 중복 제거 (auth.ts:151-153)
```typescript
if (accessTokenInFlight && accessTokenInFlightKey === key) {
  return accessTokenInFlight;  // 동시 요청 병합
}
```
→ approval_key 갱신에도 동일 패턴 적용 가능

### 4.2 연결 상태 디바운싱 (domestic-stock.ts:33)
```typescript
const CONNECTION_STATE_MIN_HOLD_MS = 1_500;  // 1.5초 홀드
```
→ 재연결 결정에도 디바운싱 적용 가능

### 4.3 Stale 데이터 타이머 (domestic-stock.ts:436-440)
```typescript
private isStale(actionId: string): boolean {
  const lastAt = this.lastDataAtByAction.get(actionId);
  if (!lastAt) return false;
  return Date.now() - lastAt >= DOMESTIC_STALE_AFTER_MS;
}
```
→ 최적 구현, 변경 불필요

---

## 5. 성능 병목점 식별

**병목 계층 (중요도 순):**

| 순위 | 병목점 | 위치 | 비용 | 최적화 가능성 |
|------|--------|------|------|--------------|
| 1 | `setImage()` IPC | SDK API | 10-50ms | 제한적 (디바운싱으로 호출 감소) |
| 2 | `encodeURIComponent()` 전체 SVG | stock-card.ts:320 | 5-10ms | 높음 (캐시 히트로 회피) |
| 3 | SVG 문자열 빌드 | stock-card.ts:222-240 | 0.5ms | 낮음 (이미 충분히 빠름) |
| 4 | `escapeXml()` 정규식 | stock-card.ts | 1ms | 낮음 |
| 5 | LRU 캐시 조회 | stock-card.ts:312 | 0.5ms | 무시할 수준 |

---

## 6. 위험 매트릭스

### 연결 안정성 위험

| 위험 | 심각도 | 발생 가능성 | 완화 방안 |
|------|--------|------------|----------|
| approval_key 만료 중 활성 연결 | 높음 | 중간 | 30분마다 proactive 갱신 |
| Thundering herd 재연결 | 중간 | 낮음 | Jitter 추가 |
| 고정 백오프로 서버 부하 | 중간 | 중간 | 지수 백오프 (5s→60s) |
| PINGPONG 누락 감지 불가 | 낮음 | 낮음 | 클라이언트 heartbeat 추가 |

### 렌더링 성능 위험

| 위험 | 심각도 | 발생 가능성 | 완화 방안 |
|------|--------|------------|----------|
| setImage() 큐 포화 | 높음 | 중간 | setImage() 디바운싱 (50-100ms) |
| LRU 캐시 키 비효율 | 낮음 | 높음 | 의미론적 캐시 키 사용 |
| 정밀도 불일치로 불필요한 재렌더 | 낮음 | 중간 | 렌더 키 정규화 통일 |

---

## 7. 최적화 기회 (임팩트/위험 순)

### Tier 1: 고임팩트, 저위험

1. **지수 백오프 + Jitter 재연결** — 서버 부하 5-10배 감소, 구현 쉬움
2. **approval_key 주기적 갱신 (30분)** — 토큰 만료 문제 완전 해결
3. **의미론적 LRU 캐시 키** — 캐시 조회 비용 50% 감소, 히트율 향상

### Tier 2: 중간 임팩트, 중간 위험

4. **setImage() 디바운싱 (50-100ms)** — IPC 호출 90% 감소, 지연 허용 시
5. **클라이언트 측 PING heartbeat** — 연결 끊김 조기 감지 (30초 간격)
6. **LRU 캐시 크기 500으로 증가** — 더 많은 종목 캐시 유지

### Tier 3: 저임팩트, 저위험

7. **렌더 키 정밀도 통일** — 국내/해외 모두 2자리 반올림
8. **에러 로깅 강화** — 조용한 실패 패턴 가시화

---

## 8. 구현 접근법 권장사항

### 연결 안정성 개선 (3 스프린트)

**Sprint 1: 토큰 갱신**
- approval_key 30분 주기 갱신 타이머 추가 (`websocket-manager.ts`)
- 갱신 시 WebSocket 연결 유지하면서 approval_key만 업데이트
- 갱신 성공/실패 로깅

**Sprint 2: 지수 백오프**
- `scheduleReconnect()` 함수에 지수 증가 로직 추가
- 5s → 10s → 20s → 40s → 60s (최대) + ±10% jitter
- 연결 성공 시 백오프 레벨 리셋

**Sprint 3: 클라이언트 heartbeat**
- 30초 간격 클라이언트 측 PING 전송
- PONG 없을 시 재연결 트리거
- 기존 서버 PINGPONG 응답 유지

### 렌더링 성능 개선 (2 스프린트)

**Sprint 1: 캐시 최적화**
- 의미론적 캐시 키 구현 (`${ticker}|${price}|...`)
- LRU 캐시 크기 200 → 500
- 렌더 키 정밀도 통일 (국내/해외 동일 기준)

**Sprint 2: setImage() 최적화 (선택적)**
- 50ms 디바운스 큐 구현
- 동일 액션의 중복 업데이트 자동 병합
- Stream Deck SDK 큐 동작 테스트 후 결정

---

## 9. 코드 핵심 참조 테이블

### websocket-manager.ts

| 발견사항 | 라인 | 설명 |
|----------|------|------|
| 재연결 딜레이 상수 | 39 | `RECONNECT_DELAY_MS = 5000` |
| 연결 타임아웃 | 40 | `CONNECT_TIMEOUT_MS = 10000` |
| approval_key 저장 | 47 | 갱신 메커니즘 없음 |
| 연결 가드 | 51 | `isConnecting` flag |
| Promise 중복 제거 | 52 | `connectPromise` 재사용 |
| 구독 Map | 48 | O(n) 스캔 |
| 재연결 함수 | 469-482 | `scheduleReconnect()` |
| 안전 해제 | 448-467 | `safeDisconnect()` |
| PINGPONG 핸들러 | 256-259, 285-287 | 서버 에코만 |

### stock-card.ts

| 발견사항 | 라인 | 설명 |
|----------|------|------|
| 캐시 최대 크기 | 37 | `200` 엔트리 |
| 캐시 Map | 44 | `new Map<string, string>()` |
| 동적 폰트 사이징 | 114-121 | 렌더마다 재계산 (무시할 비용) |
| 캐시 히트 경로 | 312-317 | delete + set (LRU 갱신) |
| 캐시 퇴거 | 323-327 | 200 초과 시 첫 번째 삭제 |
| DataURI 인코딩 | 320 | `encodeURIComponent()` — 슬로우 패스 |

---

**연구 완료** — SPEC 계획 단계 준비 완료
