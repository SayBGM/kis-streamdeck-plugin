# SPEC-PERF-001 인수 테스트 기준

## 메타데이터

| 항목 | 내용 |
|------|------|
| SPEC ID | SPEC-PERF-001 |
| 버전 | 1.0.0 |
| 작성일 | 2026-02-27 |
| 방법론 | DDD (ANALYZE-PRESERVE-IMPROVE) |

---

## 완료 정의 (Definition of Done)

구현이 완료되려면 아래 모든 조건을 만족해야 한다:

- [ ] 아래 모든 시나리오의 Given/When/Then 조건을 충족한다
- [ ] TypeScript strict 모드 컴파일 오류가 없다
- [ ] 기존 서버 PINGPONG 에코 로직(`websocket-manager.ts:256-259`)이 변경 없이 유지된다
- [ ] `safeDisconnect()` 호출 시 모든 신규 타이머가 정리된다
- [ ] DDD ANALYZE 단계에서 파악된 기존 동작이 characterization test로 보존된다

---

## 모듈 1: 연결 안정성 강화

### Scenario 1: approval_key 자동 갱신 — 정상 케이스

**관련 요구사항:** REQ-PERF-001-1.1.1

```gherkin
Given: WebSocket이 활성 연결 상태이고
       approval_key가 발급된 지 30분이 경과했다
When: 자동 갱신 타이머(approvalKeyRefreshTimer)가 실행된다
Then: KIS API에서 새 approval_key가 발급되고
      WebSocket 연결이 중단되지 않으며 (readyState === WebSocket.OPEN 유지)
      this.approvalKey가 새 키 값으로 업데이트된다
      갱신 성공이 info 레벨로 로깅된다
```

**검증 방법:**
- `setInterval` 콜백을 수동으로 실행하여 타이머 트리거 시뮬레이션
- WebSocket mock의 `readyState` 변화 여부 확인 (변화 없어야 함)
- `this.approvalKey` 값이 새 키로 교체되었는지 확인

---

### Scenario 2: approval_key 갱신 실패

**관련 요구사항:** REQ-PERF-001-1.1.3

```gherkin
Given: 자동 갱신 타이머가 실행되었으나
       KIS API가 에러를 반환한다
When: approval_key 갱신 API 호출이 실패한다
Then: 기존 approval_key를 계속 사용하고 (this.approvalKey 값 불변)
      30초 후 재시도 타이머가 등록되며
      실패가 error 레벨로 로깅된다
```

**검증 방법:**
- KIS API 모킹하여 rejection 반환
- `this.approvalKey`가 기존 값 유지 확인
- `setTimeout`이 30,000ms로 호출되었는지 확인
- logger.error 호출 여부 확인

---

### Scenario 3: approval_key 동시 갱신 요청 — 중복 제거

**관련 요구사항:** REQ-PERF-001-1.1.2

```gherkin
Given: approval_key 갱신이 진행 중(in-flight)이다
When: 두 번째 approval_key 갱신 요청이 동시에 발생한다
Then: KIS API 호출이 1회만 실행되고
      두 번째 요청은 첫 번째 요청의 Promise를 반환받는다
      (중복 API 호출이 발생하지 않는다)
```

**검증 방법:**
- KIS API mock의 호출 횟수 카운터 확인 (1회여야 함)
- 두 호출이 동일한 Promise 객체를 반환하는지 확인

---

### Scenario 4: 지수 백오프 재연결 — 딜레이 계산

**관련 요구사항:** REQ-PERF-001-1.2.1

```gherkin
Given: WebSocket 연결이 끊어지고 활성 구독이 2개 있다
When: 3번째 재연결 시도가 발생한다 (reconnectAttempts === 2)
Then: 재연결 딜레이는 20,000ms ± 2,000ms (jitter ±10%) 범위 내이다
     (baseDelay = min(5000 * 2^2, 60000) = 20,000ms)
```

**검증 방법:**
- `scheduleReconnect()` 호출 시 `setTimeout`의 delay 인수 캡처
- delay 값이 [18,000, 22,000] 범위 내인지 확인
- 10회 반복으로 jitter 분포 확인

---

### Scenario 5: 재연결 성공 시 카운터 리셋

**관련 요구사항:** REQ-PERF-001-1.2.2

```gherkin
Given: 3번의 재연결 실패 후 reconnectAttempts === 3이다
When: 4번째 재연결 시도에서 WebSocket 연결이 open 상태가 된다
Then: reconnectAttempts가 0으로 리셋되고
      다음 연결 실패 시 딜레이는 5,000ms ± 500ms로 시작된다
```

**검증 방법:**
- WebSocket onopen 이벤트 발생 후 `reconnectAttempts` 값 확인 (0)
- 이후 연결 실패 시 `setTimeout` delay가 ~5,000ms인지 확인

---

### Scenario 6: 재연결 중 구독 상태 보존

**관련 요구사항:** REQ-PERF-001-1.2.3

```gherkin
Given: WebSocket이 종목 A, B, C 3개를 구독하고 있다
When: WebSocket 연결이 끊어졌다가 재연결된다
Then: 재연결 성공 후 종목 A, B, C가 자동으로 재구독된다
     (this.subscriptions 맵의 내용이 유지된다)
```

**검증 방법:**
- 연결 해제 전후 `this.subscriptions` 크기 비교 (동일해야 함)
- 재연결 후 구독 요청 메시지가 3개 전송되었는지 확인

---

### Scenario 7: PING heartbeat 타임아웃

**관련 요구사항:** REQ-PERF-001-1.3.2

```gherkin
Given: WebSocket이 연결되어 있고
       30초 후 클라이언트 PING이 전송되었다
When: 10초 동안 서버에서 아무 응답이 없다
Then: 시스템은 safeDisconnect()를 호출하고
      재연결 시퀀스(scheduleReconnect())를 시작한다
```

**검증 방법:**
- PING 전송 후 `pongTimeoutTimer` 등록 확인 (10,000ms)
- setTimeout 콜백 수동 실행 후 `safeDisconnect` 호출 여부 확인
- `scheduleReconnect` 호출 여부 확인

---

### Scenario 8: safeDisconnect 시 모든 타이머 정리

**관련 요구사항:** REQ-PERF-001-1.1.4, REQ-PERF-001-1.3.4

```gherkin
Given: approvalKeyRefreshTimer, clientPingTimer, pongTimeoutTimer가 모두 활성 상태이다
When: safeDisconnect()가 호출된다
Then: 3개의 타이머가 모두 정리된다 (clearInterval/clearTimeout)
      각 타이머 필드가 null로 초기화된다
```

**검증 방법:**
- `clearInterval`, `clearTimeout` 호출 횟수 및 인수 확인
- `safeDisconnect()` 완료 후 각 타이머 필드 값이 null인지 확인

---

## 모듈 2: 렌더링 성능 최적화

### Scenario 9: setImage() 디바운싱 — last-write-wins

**관련 요구사항:** REQ-PERF-001-2.2.1, REQ-PERF-001-2.2.2

```gherkin
Given: 액션 A에 대해 10ms 간격으로 3개의 주가 업데이트가 도착한다
       (가격: 100, 101, 102 순서로)
When: 50ms 디바운스 타이머가 실행된다
Then: setImage()는 1번만 호출되고
      마지막 가격(102)의 DataURI로 렌더링된다
      (가격 100, 101의 setImage는 호출되지 않는다)
```

**검증 방법:**
- `setImage` mock의 호출 횟수 확인 (1회)
- `setImage`에 전달된 DataURI가 가격 102 기준으로 생성된 것인지 확인

---

### Scenario 10: setImage() 디바운싱 — 복수 액션 일괄 처리

**관련 요구사항:** REQ-PERF-001-2.2.3

```gherkin
Given: 액션 A와 액션 B에 각각 다른 주가 업데이트가 pending 상태이다
When: 50ms 디바운스 타이머 1개가 실행된다
Then: 액션 A의 setImage()와 액션 B의 setImage()가 모두 호출된다
      pendingRenderByAction 맵이 비워진다
      flushTimer가 null로 초기화된다
```

**검증 방법:**
- `setImage` mock 호출 횟수 확인 (2회)
- `pendingRenderByAction.size`가 0인지 확인
- flush 후 타이머 참조가 null인지 확인

---

### Scenario 11: 의미론적 캐시 키 — 캐시 히트

**관련 요구사항:** REQ-PERF-001-2.1.1, REQ-PERF-001-2.1.2

```gherkin
Given: 삼성전자(005930) 75,400원, 변동 +200, 변동률 +0.27%, LIVE, FRESH 상태로
       이미 렌더링된 적이 있다
       (캐시 키: "005930|75400.00|200.00|0.27|2|LIVE|FRESH")
When: 동일한 데이터로 svgToDataUri()가 다시 호출된다
Then: encodeURIComponent()를 호출하지 않고
      캐시에서 DataURI를 즉시 반환한다
      LRU 순서가 갱신된다 (해당 엔트리가 최근 사용 위치로 이동)
```

**검증 방법:**
- `encodeURIComponent` 스파이로 호출 횟수 확인 (2번째 호출 시 0회)
- 캐시 맵의 엔트리 순서 확인 (LRU 갱신)

---

### Scenario 12: 의미론적 캐시 키 — 캐시 미스 (데이터 변경)

**관련 요구사항:** REQ-PERF-001-2.1.1

```gherkin
Given: 삼성전자(005930) 75,400원으로 캐시에 저장되어 있다
When: 삼성전자(005930) 75,500원(가격 변경)으로 렌더링 요청이 온다
      (새 캐시 키: "005930|75500.00|300.00|0.40|2|LIVE|FRESH")
Then: 캐시 미스가 발생하고
      encodeURIComponent()가 호출되어 새 DataURI가 생성된다
      새 캐시 엔트리가 추가된다
```

**검증 방법:**
- `encodeURIComponent` 스파이로 호출 확인 (1회)
- 캐시 맵에 새 키로 엔트리가 추가되었는지 확인

---

### Scenario 13: LRU 캐시 퇴거

**관련 요구사항:** REQ-PERF-001-2.3.1

```gherkin
Given: LRU 캐시에 500개 엔트리가 가득 찼다
When: 501번째 고유한 의미론적 키로 SVG DataURI가 생성된다
Then: 가장 오래된 캐시 엔트리(LRU 순서 기준)가 삭제되고
      새 엔트리가 추가되어
      캐시 크기는 정확히 500을 유지한다
```

**검증 방법:**
- 501번째 생성 후 캐시 맵의 `size` 확인 (500)
- 삭제된 엔트리가 가장 오래된 것인지 키 순서로 확인

---

### Scenario 14: 렌더 키 정밀도 — 동일 데이터 동일 키

**관련 요구사항:** REQ-PERF-001-2.4.1

```gherkin
Given: price = 75400.1, change = 200.1, changeRate = 0.265 인 주식 데이터가 있다
When: domestic-stock.ts의 makeRenderKey()와
      overseas-stock.ts의 makeRenderKey()를 각각 동일 데이터로 호출한다
Then: 두 함수 모두 price를 "75400.10", change를 "200.10",
      changeRate를 "0.27"로 정규화한 렌더 키를 생성한다
      (부동소수점 표현 불일치로 인한 키 차이가 없다)
```

**검증 방법:**
- 두 함수의 반환값에서 price, change, changeRate 부분이 동일한지 문자열 비교

---

### Scenario 15: 렌더 키 정밀도 — 불필요한 재렌더 방지

**관련 요구사항:** REQ-PERF-001-2.4.1

```gherkin
Given: 마지막 렌더 키가 "005930|75400.10|200.10|0.27|2|LIVE|FRESH"로 저장되어 있다
When: 동일 값이지만 부동소수점 표현이 다른 데이터(75400.100000001)가 도착한다
Then: makeRenderKey()가 동일한 렌더 키를 반환하고
      setImage() 호출이 스킵된다 (불필요한 재렌더 없음)
```

**검증 방법:**
- `setImage` mock의 호출 횟수 확인 (0회)
- `lastRenderKeyByAction`이 변경되지 않았는지 확인

---

## 품질 게이트 (Quality Gates)

### 타이머 정리 검증

모든 신규 타이머(`approvalKeyRefreshTimer`, `clientPingTimer`, `pongTimeoutTimer`, 디바운스 타이머)는 다음 시나리오에서 반드시 정리되어야 한다:

- 액션 `onWillDisappear` 또는 `onDestroy` 호출 시
- 플러그인 종료 시
- `safeDisconnect()` 호출 시

### TypeScript 컴파일 검증

```
npx tsc --noEmit
```

오류 0개, 경고 0개가 기준이다.

### 기존 동작 보존 (DDD PRESERVE 단계)

아래 기존 동작은 characterization test로 캡처하고 변경 없이 유지되어야 한다:

| 대상 함수 | 보존 동작 |
|-----------|-----------|
| `scheduleReconnect()` | 구독이 없거나 approvalKey가 없으면 재연결하지 않음 |
| `svgToDataUri()` | SVG → `data:image/svg+xml;charset=utf-8,{encoded}` 형식 유지 |
| `makeRenderKey()` — 중복 제거 | 동일 렌더 키이면 setImage() 호출하지 않음 (기존 로직) |
| PINGPONG 에코 | 서버 PINGPONG을 그대로 에코하는 로직 (`lines 256-259`) |

---

## 검증 체크리스트

### 모듈 1 체크리스트

- [ ] Scenario 1: approval_key 정상 갱신 (타이머 → 새 키)
- [ ] Scenario 2: approval_key 갱신 실패 (기존 키 유지 + 재시도)
- [ ] Scenario 3: 동시 갱신 요청 중복 제거
- [ ] Scenario 4: 지수 백오프 딜레이 계산 (attempt=2 → ~20초)
- [ ] Scenario 5: 재연결 성공 시 카운터 리셋
- [ ] Scenario 6: 재연결 중 구독 상태 보존
- [ ] Scenario 7: PING heartbeat 10초 타임아웃
- [ ] Scenario 8: safeDisconnect 시 모든 타이머 정리

### 모듈 2 체크리스트

- [ ] Scenario 9: setImage() last-write-wins 디바운싱
- [ ] Scenario 10: 복수 액션 일괄 flush
- [ ] Scenario 11: 의미론적 캐시 히트 (encodeURIComponent 미호출)
- [ ] Scenario 12: 의미론적 캐시 미스 (데이터 변경 시)
- [ ] Scenario 13: LRU 캐시 퇴거 (크기 500 유지)
- [ ] Scenario 14: 렌더 키 정밀도 통일 (국내/해외 동일)
- [ ] Scenario 15: 부동소수점 불일치로 인한 불필요한 재렌더 방지

### 공통 체크리스트

- [ ] TypeScript strict 컴파일 오류 없음
- [ ] 기존 PINGPONG 에코 동작 보존
- [ ] 모든 신규 타이머 safeDisconnect 시 정리 확인
- [ ] DDD characterization test 작성 완료
