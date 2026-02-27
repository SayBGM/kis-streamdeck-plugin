---
id: SPEC-UI-001
document: acceptance
version: "1.0.0"
status: draft
created: 2026-02-27
updated: 2026-02-27
---

# SPEC-UI-001: Acceptance Criteria — Error UI & User Diagnostics

## AC-1: ErrorType Foundation

### Scenario 1.1 — ErrorType enum is exported

```
Given the TypeScript build is complete
When another module imports ErrorType from "src/types/index.ts"
Then all four values are accessible: NO_CREDENTIAL, AUTH_FAIL, NETWORK_ERROR, INVALID_STOCK
And TypeScript strict mode reports zero errors
```

### Scenario 1.2 — renderErrorCard produces distinct SVGs per type

```
Given the renderer is loaded
When renderErrorCard(ErrorType.AUTH_FAIL) is called
Then the returned SVG string contains the AUTH_FAIL icon/label (e.g., "인증 실패")
And the SVG does not contain the connection bar rectangle element

When renderErrorCard(ErrorType.NETWORK_ERROR) is called
Then the returned SVG is visually distinct from AUTH_FAIL (different icon or label)

When renderErrorCard(ErrorType.NO_CREDENTIAL) is called
Then the returned SVG contains "설정 필요" label

When renderErrorCard(ErrorType.INVALID_STOCK) is called
Then the returned SVG contains "종목 오류" label
```

---

## AC-2: Button Error Display

### Scenario 2.1 — Auth failure shows AUTH_FAIL card

```
Given the plugin is running with invalid App Key / App Secret
When a domestic stock action attempts to fetch price data
Then the Stream Deck button displays the AUTH_FAIL error card
And the button does NOT remain in a loading/blank state indefinitely
And the error is logged at the error level (not debug)
```

### Scenario 2.2 — Network failure shows NETWORK_ERROR card

```
Given the plugin is running with valid credentials
And the network connection is unavailable (simulated)
When a stock action attempts to fetch price data
Then the Stream Deck button displays the NETWORK_ERROR error card
And the button updates within 15 seconds (existing REST timeout)
```

### Scenario 2.3 — Invalid stock code shows INVALID_STOCK card

```
Given the plugin is running with valid credentials
And a domestic stock action is configured with an invalid stock code (e.g., "999999")
When the REST API responds with a non-zero rt_cd or empty data
Then the Stream Deck button displays the INVALID_STOCK error card
And the button does NOT remain in a loading state
```

### Scenario 2.4 — No credentials shows NO_CREDENTIAL card

```
Given the plugin starts with no App Key or App Secret configured
When a stock action first appears on the Stream Deck
Then the Stream Deck button displays the NO_CREDENTIAL error card (not a blank/generic "설정 필요")
```

---

## AC-3: Stale Data Indicator

### Scenario 3.1 — BACKUP state shows "지연" text

```
Given a stock action is in LIVE state with valid data
When no WebSocket data arrives for more than 20 seconds (BACKUP state triggers)
Then the stock card displays a "지연" text label in yellow (#ffd54f)
And the existing yellow connection bar at the bottom is also present
And the price/change data is still visible (stale data is shown, not hidden)
```

### Scenario 3.2 — LIVE state does not show "지연" text

```
Given a stock action is in LIVE state
When a new WebSocket tick arrives
Then the stock card does NOT display "지연" text
And the connection bar is green
```

---

## AC-4: Connection Recovery Notification

### Scenario 4.1 — Recovery from BACKUP to LIVE

```
Given a stock action was in BACKUP state (yellow connection bar, "지연" text)
When a new WebSocket tick arrives and connection state transitions to LIVE
Then the button briefly shows a recovery visual indicator for approximately 2 seconds
And after 2 seconds, the button automatically reverts to the normal stock card
And the stock card shows the latest price data without "지연" text
```

### Scenario 4.2 — Recovery from BROKEN to LIVE

```
Given a stock action was in BROKEN state (red connection bar)
When WebSocket reconnects and a valid tick is received
Then the button shows the 2-second recovery indicator
And then reverts to the normal LIVE stock card
```

---

## AC-5: Property Inspector Input Validation

### Scenario 5.1 — Domestic stock code validation (real-time)

```
Given the domestic stock Property Inspector is open
When the user types "Samsung" (non-numeric) into the stock code field
Then an inline error message appears: "6자리 숫자를 입력하세요 (예: 005930)"
And the settings are NOT saved (saveActionSettings is not called)

When the user clears the field and types "005930"
Then the inline error message disappears
And settings can be saved normally
```

### Scenario 5.2 — Overseas ticker validation (real-time)

```
Given the overseas stock Property Inspector is open
When the user types "APPLE123" (too long / has digits) into the ticker field
Then an inline error message appears: "1~6자 영문 티커를 입력하세요 (예: AAPL)"
And the settings are NOT saved

When the user changes the value to "AAPL"
Then the inline error disappears
And settings can be saved normally
```

### Scenario 5.3 — Empty field blocks save

```
Given the domestic stock Property Inspector is open
When the stock code field is empty and the user attempts to save
Then the settings are NOT saved
And an appropriate inline error message is shown
```

---

## AC-6: "연결 테스트" Button

### Scenario 6.1 — Successful connection test

```
Given the Property Inspector is open with valid App Key and App Secret saved
When the user clicks the "연결 테스트" button
Then the button becomes disabled and shows "테스트 중..." text
And within 10 seconds, a green success message appears: "연결 성공"
And after 3 seconds, the success message disappears
And the button returns to its enabled state
And the existing cached access token is NOT invalidated
```

### Scenario 6.2 — Failed connection test (auth error)

```
Given the Property Inspector is open with invalid App Key / App Secret
When the user clicks the "연결 테스트" button
Then the button shows "테스트 중..."
And within 10 seconds, a red failure message appears containing "인증 실패"
And the message remains visible for 5 seconds
And the button returns to its enabled state
```

### Scenario 6.3 — Failed connection test (network error)

```
Given the Property Inspector is open and the network is unavailable
When the user clicks the "연결 테스트" button
Then within the timeout period, a red failure message appears containing "연결 실패"
And the message includes guidance to check network connectivity
And the button returns to its enabled state
```

### Scenario 6.4 — Button disabled during test

```
Given the user clicks "연결 테스트"
When the test is in progress
Then the button is disabled (cannot be clicked again)
And a loading indicator or "테스트 중..." label is visible
```

---

## Performance Gate

| Metric | Requirement |
|---|---|
| Error card render time | < 50ms (reuses existing SVG pipeline) |
| "연결 테스트" response time | < 10s (KIS API latency + 3s buffer) |
| PI inline validation latency | < 100ms from keystroke to error display |
| Recovery notification duration | 2000ms ± 200ms |

---

## Regression Gate

All existing behavior must be preserved:

- [ ] LIVE stock card connection bar (green) renders correctly
- [ ] BACKUP stock card connection bar (yellow) renders correctly
- [ ] BROKEN stock card connection bar (red) renders correctly
- [ ] Existing 2-second status toast in PI still works
- [ ] Settings save/load flow unchanged for valid inputs
- [ ] WebSocket reconnect and subscription behavior unchanged
- [ ] No new npm packages introduced
- [ ] TypeScript strict mode: zero errors, zero `any` without explicit comment
