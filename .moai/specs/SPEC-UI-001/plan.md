---
id: SPEC-UI-001
document: plan
version: "1.0.0"
status: draft
created: 2026-02-27
updated: 2026-02-27
---

# SPEC-UI-001: Implementation Plan — Error UI & User Diagnostics

## Overview

This plan describes the implementation sequence for surfacing plugin errors directly on Stream Deck buttons and in the Property Inspector, replacing the silent log-only behavior with visible, categorized error states.

**Key constraint**: All changes must preserve the existing LIVE/BACKUP/BROKEN SVG connection bar behavior (bottom colored bar in `renderStockCard()`).

---

## Files to Modify

| File | Change Type | Rationale |
|---|---|---|
| `src/types/index.ts` | Add `ErrorType` enum | Central type definition for error categorization |
| `src/renderer/stock-card.ts` | Extend `renderErrorCard()`, add stale text | Wire up error cards with type-aware rendering |
| `src/actions/domestic-stock.ts` | Wire `renderErrorCard()` in catch blocks, add recovery notification, handle PI test connection | Surface errors and recovery events on button |
| `src/actions/overseas-stock.ts` | Same as domestic-stock.ts | Parallel implementation for overseas market |
| `ui/domestic-stock-pi.html` | Add inline validation, "연결 테스트" button, result display | User-facing diagnostics in Property Inspector |
| `ui/overseas-stock-pi.html` | Same as domestic-stock-pi.html | Parallel implementation for overseas PI |

---

## Implementation Milestones

### Primary Goal: Error Type Foundation

**Scope**: Type system and renderer

**Tasks**:
1. Add `ErrorType` enum to `src/types/index.ts`
   - Values: `NO_CREDENTIAL`, `AUTH_FAIL`, `NETWORK_ERROR`, `INVALID_STOCK`
   - Use `const enum` pattern for zero-runtime overhead in TypeScript

2. Extend `renderErrorCard()` in `src/renderer/stock-card.ts`
   - Change parameter from `message: string` to `errorType: ErrorType`
   - Map each `ErrorType` to an icon character and Korean label text
   - Ensure NO connection bar is rendered in error cards (unlike `renderStockCard()`)
   - Add a new `ERROR_COLOR` constant distinct from existing `COLOR_FALL`

3. Add stale "지연" text to `renderStockCard()`
   - Condition: `isStale && connectionState === "BACKUP"`
   - Position: small text near top-right, color `COLOR_TEXT_STALE` (`#ffd54f`)
   - Must NOT affect existing connection bar rendering

**Acceptance gate**: `renderErrorCard(ErrorType.AUTH_FAIL)` produces a valid SVG with no connection bar.

---

### Secondary Goal: Action Error Path Wiring

**Scope**: `domestic-stock.ts`, `overseas-stock.ts`

**Tasks**:
1. Wire `renderErrorCard()` in `fetchAndShowPrice()` catch block
   - Distinguish `INVALID_STOCK` (API response with non-zero rt_cd or empty data) from `NETWORK_ERROR` (fetch/network failure)
   - Replace `logger.debug(...)` only catch with `logger.error()` + `renderErrorCard()` + `setImage()`

2. Wire `renderErrorCard(ErrorType.AUTH_FAIL)` in auth-related error paths
   - Intercept errors thrown by auth token acquisition (HTTP 401, KIS error code `EGW00133`)
   - Requires identifying where auth errors propagate to action layer

3. Wire `renderErrorCard(ErrorType.NO_CREDENTIAL)` as the initial state guard
   - Replace `renderSetupCard("종목코드를 설정하세요")` with typed error card when credentials absent
   - Keep `renderSetupCard()` for the "no stock code set" case (different from auth error)

4. Implement connection recovery notification
   - In `applyConnectionState()`: detect transition from `BROKEN`/`BACKUP` → `LIVE`
   - Show a brief recovery SVG for 2 seconds, then revert to normal stock card
   - Use existing `setTimeout` + `renderLastDataIfPossible()` pattern

**Acceptance gate**: Setting an invalid stock code results in `INVALID_STOCK` error card on button (not a stuck loading state).

---

### Tertiary Goal: Property Inspector Diagnostics

**Scope**: `ui/domestic-stock-pi.html`, `ui/overseas-stock-pi.html`

**Tasks**:
1. Add inline input validation
   - National stock code: `/^\d{6}$/` — show "6자리 숫자를 입력하세요" inline
   - Overseas ticker: `/^[A-Z]{1,6}$/i` — show "1~6자 영문 티커를 입력하세요" inline
   - Block `saveActionSettings()` call when validation fails
   - Use `input` event (real-time) not `change` event for validation feedback

2. Add "연결 테스트" button
   - Position: below App Secret field, before the separator
   - Uses `sendToPlugin({ event: "testConnection" })` Elgato SDK pattern
   - Button disabled state during test in progress

3. Add test result display
   - Listen for `sendToPropertyInspector` message with `event: "testConnectionResult"`
   - Success: green "연결 성공 (access_token 발급 완료)" for 3 seconds
   - Failure with AUTH_FAIL: red "인증 실패: App Key/Secret을 확인하세요" for 5 seconds
   - Failure with NETWORK_ERROR: red "연결 실패: 네트워크를 확인하세요" for 5 seconds

4. Wire plugin-side handler for `testConnection` message
   - In action `onSendToPlugin()` override: call `auth.ts` token acquisition
   - Send result back via `action.sendToPropertyInspector()`
   - Must not invalidate existing cached tokens

**Acceptance gate**: Clicking "연결 테스트" with valid credentials shows green success message within 5 seconds.

---

### Optional Goal: Semantic Key Cache Integration

**Scope**: `renderErrorCard()` cache key

**Tasks**:
1. Ensure error card SVGs use stable `semanticKey` for `svgToDataUri()` cache
   - Key format: `error:{ErrorType}` (e.g., `error:AUTH_FAIL`)
   - Error cards are content-stable (no dynamic data), so cache hit rate will be 100% after first render

---

## Technical Approach

### Error Propagation Architecture

```
auth.ts / rest-price.ts
        │ throws typed errors
        ▼
fetchAndShowPrice() catch block
        │ classifies error → ErrorType
        ▼
renderErrorCard(errorType)
        │ produces SVG
        ▼
svgToDataUri(svg, "error:AUTH_FAIL")
        │
        ▼
action.setImage(dataUri)   ← visible on Stream Deck button
```

### PI Message Passing Architecture

```
PI HTML                    Plugin (Action)
  │                              │
  │─ sendToPlugin({              │
  │    event: "testConnection"   │
  │  }) ─────────────────────────►
  │                              │
  │                   onSendToPlugin()
  │                   calls auth.ts
  │                              │
  │◄─────────────────────────────│
  │  sendToPropertyInspector({   │
  │    event: "testConnectionResult",
  │    success: true/false,      │
  │    errorType?: ErrorType     │
  │  })                          │
  │                              │
  │ listener updates UI          │
```

### Stale Text Rendering Strategy

The `renderStockCard()` function already receives `isStale` and `connectionState` via `StockCardRenderOptions`. Adding "지연" text is purely additive SVG — a new `<text>` element conditionally appended. No structural change to the existing card layout.

---

## Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Auth error codes from KIS API not caught at action layer | Medium | High | Trace `fetchDomesticPrice()` → `rest-price.ts` → auth error propagation before implementing |
| SVG layout breakage from "지연" text addition | Low | Medium | Position text in top-right corner (same row as session badge), use `text-anchor="end"` |
| PI `onSendToPlugin` handler not available in base SDK | Low | High | Verify `SingletonAction` has `onSendToPlugin()` override in @elgato/streamdeck 1.1.0 docs |
| Token cache invalidation during "연결 테스트" | Low | Low | Read-only call to auth.ts; existing cached token must not be cleared on test failure |
| `renderErrorCard()` signature change breaks callers | None | Low | Function currently has zero call sites — safe to change signature |

---

## Definition of Done

- [ ] `ErrorType` enum exported from `src/types/index.ts`
- [ ] `renderErrorCard(errorType: ErrorType)` produces distinct SVG per type
- [ ] `renderErrorCard()` does not include connection bar rectangle
- [ ] Auth failure (invalid key) shows `AUTH_FAIL` card on button (not stuck loading)
- [ ] Invalid stock code shows `INVALID_STOCK` card on button
- [ ] Network failure shows `NETWORK_ERROR` card on button
- [ ] BACKUP state with stale data shows "지연" text on stock card
- [ ] LIVE recovery shows 2-second recovery notification then reverts
- [ ] PI shows inline validation error for bad stock code format (real-time)
- [ ] PI "연결 테스트" button calls auth and shows result
- [ ] Existing LIVE/BACKUP/BROKEN connection bar unchanged in `renderStockCard()`
- [ ] No new npm packages added
- [ ] TypeScript strict mode passes (zero `any`, zero `@ts-ignore` without comment)
