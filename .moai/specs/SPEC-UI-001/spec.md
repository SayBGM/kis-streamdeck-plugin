---
id: SPEC-UI-001
version: "1.0.0"
status: draft
created: 2026-02-27
updated: 2026-02-27
author: SayBGM
priority: high
---

# SPEC-UI-001: 에러 UI 및 사용자 진단 개선

## 1. 환경 (Environment)

### 1.1 프로젝트 컨텍스트

- **프로젝트**: KIS StreamDeck Plugin (한국투자증권 실시간 시세)
- **플랫폼**: Elgato Stream Deck, @elgato/streamdeck SDK 1.1.0
- **언어**: TypeScript 5.7
- **렌더링**: SVG 기반 144×144px 카드

### 1.2 현재 상태 (기존 구현)

| 구성요소 | 파일 | 현재 상태 |
|---|---|---|
| `renderErrorCard(label)` | `src/renderer/stock-card.ts:147` | 정의됨, **한 번도 호출되지 않음** |
| LIVE/BACKUP/BROKEN 연결 바 | `src/renderer/stock-card.ts:239` | 정상 동작 중 |
| 국내주식 액션 에러 처리 | `src/actions/domestic-stock.ts:152` | 로그만 기록, UI 미반영 |
| 해외주식 액션 에러 처리 | `src/actions/overseas-stock.ts` | 국내주식과 동일 패턴 |
| PI 상태 메시지 | `ui/domestic-stock-pi.html:58` | 2초 자동 숨김 토스트만 존재 |
| PI 입력 검증 | `ui/domestic-stock-pi.html` | 없음 |

### 1.3 기술 제약

- 새로운 npm 패키지 추가 금지
- 기존 LIVE/BACKUP/BROKEN SVG 연결 바 시각 효과 유지 필수
- Property Inspector는 Elgato SDK 메시지 패싱 사용 (sendToPlugin / sendToPropertyInspector)
- 에러 카드는 기존 SVG 렌더링 인프라(`src/renderer/stock-card.ts`) 재사용

---

## 2. 가정 (Assumptions)

| ID | 가정 | 신뢰도 | 검증 방법 |
|---|---|---|---|
| A-01 | `renderErrorCard()`의 현재 시그니처(`message: string`)를 `ErrorType`을 받도록 확장 가능 | High | 함수 정의 확인 완료 |
| A-02 | Property Inspector에서 `sendToPlugin` 메시지로 "Test Connection" 요청 가능 | High | Elgato SDK 문서 확인 |
| A-03 | 인증 에러 코드(`EGW00133` 등)가 `src/kis/auth.ts`에서 throw 시 캡처 가능 | Medium | auth.ts 분석 필요 |
| A-04 | PI에서 종목코드 형식은 국내 6자리 숫자, 해외 1~6자 알파벳으로 단순 검증 가능 | High | 기존 KIS API 명세 기반 |
| A-05 | 연결 회복 알림은 2초간 표시 후 일반 시세 카드로 복원 | High | UX 일관성 원칙 |

---

## 3. 요구사항 (Requirements)

### 3.1 에러 타입 정의

**REQ-UI-001-1.1**: `src/types/index.ts`에 `ErrorType` enum을 추가해야 한다.

```
ErrorType 값:
- NO_CREDENTIAL   : App Key / App Secret 미설정
- AUTH_FAIL       : 인증 실패 (EGW00133 등 KIS 에러 코드)
- NETWORK_ERROR   : 네트워크 연결 불가
- INVALID_STOCK   : 유효하지 않은 종목코드 또는 티커
```

### 3.2 버튼 에러 표시

**REQ-UI-001-2.1** (Event-Driven):
WHEN 인증이 실패하면 THEN 시스템은 해당 버튼에 `ErrorType.AUTH_FAIL` 에러 카드를 표시해야 한다.

**REQ-UI-001-2.2** (Event-Driven):
WHEN 네트워크 오류가 발생하면 THEN 시스템은 해당 버튼에 `ErrorType.NETWORK_ERROR` 에러 카드를 표시해야 한다.

**REQ-UI-001-2.3** (Event-Driven):
WHEN 유효하지 않은 종목코드로 REST API가 실패하면 THEN 시스템은 해당 버튼에 `ErrorType.INVALID_STOCK` 에러 카드를 표시해야 한다.

**REQ-UI-001-2.4** (State-Driven):
IF App Key 또는 App Secret이 설정되어 있지 않으면 THEN 시스템은 기존 "설정 필요" 카드 대신 `ErrorType.NO_CREDENTIAL` 에러 카드를 표시해야 한다.

### 3.3 에러 타입별 시각적 구분

**REQ-UI-001-3.1** (Ubiquitous):
시스템은 각 `ErrorType`에 대해 서로 다른 아이콘 또는 레이블 텍스트로 에러 카드를 렌더링해야 한다.

| ErrorType | 표시 아이콘 | 표시 레이블 |
|---|---|---|
| `NO_CREDENTIAL` | `⚙` | 설정 필요 |
| `AUTH_FAIL` | `🔒` 또는 `✕` | 인증 실패 |
| `NETWORK_ERROR` | `⚡` 또는 `!` | 연결 오류 |
| `INVALID_STOCK` | `?` | 종목 오류 |

**REQ-UI-001-3.2** (Ubiquitous):
시스템은 에러 카드에서 기존 LIVE/BACKUP/BROKEN 연결 바를 표시하지 않아야 한다. (에러 상태이므로 연결 상태 바는 무의미)

### 3.4 Property Inspector 입력 검증

**REQ-UI-001-4.1** (Event-Driven):
WHEN 사용자가 국내주식 종목코드 입력 필드에 값을 입력하면 THEN 시스템은 6자리 숫자 형식인지 실시간 검증하고 인라인 오류 메시지를 표시해야 한다.

**REQ-UI-001-4.2** (Event-Driven):
WHEN 사용자가 해외주식 티커 입력 필드에 값을 입력하면 THEN 시스템은 1~6자 영문자 형식인지 실시간 검증하고 인라인 오류 메시지를 표시해야 한다.

**REQ-UI-001-4.3** (State-Driven):
IF 입력 필드가 유효하지 않은 형식이면 THEN 시스템은 설정 저장을 진행하지 않아야 한다.

### 3.5 연결 테스트 버튼

**REQ-UI-001-5.1** (Ubiquitous):
시스템은 Property Inspector에 "연결 테스트" 버튼을 제공해야 한다.

**REQ-UI-001-5.2** (Event-Driven):
WHEN 사용자가 "연결 테스트" 버튼을 클릭하면 THEN 시스템은 현재 저장된 App Key / App Secret으로 KIS API 인증을 시도하고 결과를 Property Inspector에 표시해야 한다.

**REQ-UI-001-5.3** (State-Driven):
IF 연결 테스트가 진행 중이면 THEN 시스템은 버튼을 비활성화하고 "테스트 중..." 텍스트를 표시해야 한다.

**REQ-UI-001-5.4** (Event-Driven):
WHEN 연결 테스트가 성공하면 THEN 시스템은 "연결 성공" 메시지를 3초간 표시해야 한다.

**REQ-UI-001-5.5** (Event-Driven):
WHEN 연결 테스트가 실패하면 THEN 시스템은 실패 원인 (인증 오류 / 네트워크 오류)을 포함한 메시지를 5초간 표시해야 한다.

### 3.6 지연 데이터 텍스트 경고

**REQ-UI-001-6.1** (State-Driven):
IF 데이터가 20초 이상 갱신되지 않아 BACKUP 상태이면 THEN 시스템은 시세 카드에 "지연" 텍스트 레이블을 추가로 표시해야 한다. (기존 노란 연결 바와 함께)

**REQ-UI-001-6.2** (Ubiquitous):
시스템은 "지연" 텍스트를 노란색(`#ffd54f`)으로 표시하여 LIVE 상태와 시각적으로 구분해야 한다.

### 3.7 연결 회복 알림

**REQ-UI-001-7.1** (Event-Driven):
WHEN WebSocket 연결이 BACKUP 또는 BROKEN 상태에서 LIVE 상태로 회복되면 THEN 시스템은 버튼에 2초간 회복 성공 시각 효과를 표시해야 한다.

**REQ-UI-001-7.2** (Ubiquitous):
시스템은 회복 알림 표시 후 자동으로 일반 시세 카드로 복원해야 한다.

---

## 4. 명세 (Specifications)

### 4.1 ErrorType Enum 설계

```typescript
// src/types/index.ts 추가
export enum ErrorType {
  NO_CREDENTIAL = "NO_CREDENTIAL",
  AUTH_FAIL     = "AUTH_FAIL",
  NETWORK_ERROR = "NETWORK_ERROR",
  INVALID_STOCK = "INVALID_STOCK",
}
```

### 4.2 renderErrorCard 확장 설계

기존 시그니처:
```typescript
export function renderErrorCard(message: string): string
```

변경 후 시그니처:
```typescript
export function renderErrorCard(errorType: ErrorType): string
```

각 `ErrorType`에 따라 아이콘과 레이블을 내부적으로 매핑하여 SVG 생성.
기존 LIVE/BACKUP/BROKEN 연결 바(`CONNECTION_LINE_*` 상수)는 에러 카드에서 렌더링하지 않음.

### 4.3 액션 에러 경로 배선 설계

`domestic-stock.ts`와 `overseas-stock.ts`의 `catch` 블록에서:
- 인증 에러 (`EGW00133`, HTTP 401): `renderErrorCard(ErrorType.AUTH_FAIL)`
- 네트워크 에러 (timeout, DNS, fetch 실패): `renderErrorCard(ErrorType.NETWORK_ERROR)`
- API 응답 실패 (종목 없음, rt_cd !== "0"): `renderErrorCard(ErrorType.INVALID_STOCK)`

### 4.4 PI 메시지 패싱 설계

연결 테스트 흐름:
```
PI (HTML) → sendToPlugin({ event: "testConnection" })
           → Plugin (domestic/overseas action) → auth.ts 호출
           → sendToPropertyInspector({ event: "testConnectionResult", success: boolean, error?: string })
PI (HTML) ← 결과 수신 → 상태 메시지 표시
```

### 4.5 PI 입력 검증 설계

국내주식 종목코드 검증:
```
정규식: /^\d{6}$/
오류 메시지: "6자리 숫자를 입력하세요 (예: 005930)"
```

해외주식 티커 검증:
```
정규식: /^[A-Z]{1,6}$/i
오류 메시지: "1~6자 영문 티커를 입력하세요 (예: AAPL)"
```

### 4.6 "지연" 텍스트 및 회복 알림 설계

- "지연" 텍스트: `renderStockCard()` 내부에서 `isStale && connectionState === "BACKUP"` 조건 시 SVG에 추가 `<text>` 요소 삽입
- 회복 알림: `applyConnectionState()` 내부에서 BROKEN/BACKUP → LIVE 전환 감지 시 2초 타이머로 임시 회복 카드 표시 후 자동 복원

---

## 5. 추적성 (Traceability)

| 요구사항 ID | 대상 파일 | 관련 SPEC |
|---|---|---|
| REQ-UI-001-1.1 | `src/types/index.ts` | SPEC-UI-001 |
| REQ-UI-001-2.1~2.4 | `src/actions/domestic-stock.ts`, `src/actions/overseas-stock.ts` | SPEC-UI-001 |
| REQ-UI-001-3.1~3.2 | `src/renderer/stock-card.ts` | SPEC-UI-001 |
| REQ-UI-001-4.1~4.3 | `ui/domestic-stock-pi.html`, `ui/overseas-stock-pi.html` | SPEC-UI-001 |
| REQ-UI-001-5.1~5.5 | `ui/domestic-stock-pi.html`, `ui/overseas-stock-pi.html`, `src/actions/domestic-stock.ts`, `src/actions/overseas-stock.ts` | SPEC-UI-001 |
| REQ-UI-001-6.1~6.2 | `src/renderer/stock-card.ts` | SPEC-UI-001 |
| REQ-UI-001-7.1~7.2 | `src/actions/domestic-stock.ts`, `src/actions/overseas-stock.ts` | SPEC-UI-001 |
