# Property Inspector Information Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 국내·미국 주식 PI를 목적별 accordion 구조로 재편하고, 실시간 모드에서 스로틀 간격을 완전히 숨기며, 저장·위험 작업·진단 흐름을 명확히 한 뒤 v2.2.0으로 릴리스한다.

**Architecture:** ui/stock-pi-shared.js의 기존 shared controller와 PI 프로토콜을 유지하면서 DOM 정보 구조와 UI 상태 helper를 재구성한다. 설정값·snapshot ordering·revision 보호는 그대로 두고, control 값을 읽고 쓰는 작은 helper와 accordion lifecycle 상태를 추가한다. CSS는 native details의 semantic 동작을 유지하면서 chevron, scope, segmented radio, compact connection strip을 표현한다.

**Tech Stack:** TypeScript, Vitest, JSDOM, plain HTML/CSS/JavaScript, Stream Deck SDK, npm release scripts, GitHub Actions

---

## 파일 구조

- Modify: ui/stock-pi-shared.js — PI markup, accordion summaries, radio/conditional field, dirty/pending state, confirmation, diagnostics open 동작
- Modify: ui/sdpi.css — connection strip, accordion, chevron, scope badge, segmented radio, focus/reduced-motion styles
- Modify: src/pi/__tests__/pi-ui.test.ts — DOM, interaction, snapshot ordering, 저장·확인·진단 회귀 테스트
- Modify: src/__tests__/domestic-stock-pi.test.ts — 국내·미국 엔트리가 같은 shared 정보 구조를 쓰는지 정적 계약 갱신
- Modify: README.md — 새 PI 정보 구조와 실시간/스로틀 조건 노출 사용법
- Modify: AGENTS.md — 아키텍처 설명과 PI 설계 원칙 갱신
- Create: docs/superpowers/specs/2026-07-14-property-inspector-information-architecture-design.md — 승인된 설계
- Create: docs/superpowers/plans/2026-07-14-property-inspector-information-architecture.md — 이 구현 계획

런타임, 설정 schema, PI 외부 프로토콜, WebSocket/REST/렌더러 파일은 수정하지 않는다.

### Task 1: 목적별 정보 구조와 명확한 accordion

**Files:**
- Modify: src/pi/__tests__/pi-ui.test.ts
- Modify: ui/stock-pi-shared.js
- Modify: ui/sdpi.css

- [ ] **Step 1: 새 section 순서와 기본 open 상태의 실패 테스트 작성**

기존 renders sections 테스트를 다음 계약으로 바꾼다.

    expect(sections).toEqual([
      "connection-status",
      "stock-settings",
      "credentials",
      "global-preferences",
      "troubleshooting",
    ]);
    expect(stockDetails.open).toBe(true);
    expect(credentialsDetails.open).toBe(false);
    expect(preferencesDetails.open).toBe(false);
    expect(troubleshootingDetails.open).toBe(false);
    expect(diagnosticsDetails.open).toBe(false);

각 summary에서 .sdpi-disclosure-icon과 scope/상태 요약을 검증한다.

- [ ] **Step 2: 대상 테스트가 기존 구조에서 실패하는지 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts -t "information architecture|accordion"

Expected: FAIL — 기존 stock-settings가 section이고 connection-status가 두 번째이며, 명시적 disclosure icon과 새 section이 없다.

- [ ] **Step 3: renderLayout을 새 정보 구조로 최소 변경**

markup 순서는 다음과 같이 고정한다.

    <section class="sdpi-connection-strip" data-section="connection-status">...</section>
    <details class="sdpi-group sdpi-disclosure" data-section="stock-settings" open>...</details>
    <details id="credentialsDetails" class="sdpi-group sdpi-disclosure"
      data-section="credentials">...</details>
    <details id="preferencesDetails" class="sdpi-group sdpi-disclosure"
      data-section="global-preferences">...</details>
    <details id="troubleshootingDetails" class="sdpi-group sdpi-disclosure"
      data-section="troubleshooting">
      ...
      <details id="diagnosticsDetails" class="sdpi-nested-disclosure">...</details>
    </details>

summary 내부는 제목, 보조 요약, chevron을 명시적으로 가진다. 이 단계에서 nested diagnostics markup까지 만들되 최초 open 요청 동작은 Task 4에서 연결한다. 기존 input/button/status ID는 가능한 한 유지해 snapshot 및 command 로직 변경 범위를 줄인다.

- [ ] **Step 4: accordion과 connection strip CSS 구현**

다음 selector를 추가한다.

    .sdpi-connection-strip
    .sdpi-disclosure > summary
    .sdpi-disclosure-icon
    .sdpi-disclosure[open] > summary .sdpi-disclosure-icon
    .sdpi-summary-copy
    .sdpi-summary-meta
    .sdpi-scope
    .sdpi-disclosure-body

native marker를 숨기고 summary 전체에 40px 이상 클릭 영역과 focus-visible outline을 제공한다. 좁은 폭의 보조 요약은 overflow hidden, text-overflow ellipsis, white-space nowrap을 사용한다.

prefers-reduced-motion: reduce media query에서는 chevron과 상태 transition-duration을 0s로 만든다. 테스트는 stylesheet에 해당 media query와 disclosure transition override가 있는지 검증한다.

- [ ] **Step 5: 대상 테스트 통과 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts -t "information architecture|accordion"

Expected: PASS

- [ ] **Step 6: 첫 UI 구조 커밋**

    git add src/pi/__tests__/pi-ui.test.ts ui/stock-pi-shared.js ui/sdpi.css
    git commit -m "feat: reorganize property inspector sections"

### Task 2: 실시간/스로틀 segmented control과 조건부 간격

**Files:**
- Modify: src/pi/__tests__/pi-ui.test.ts
- Modify: ui/stock-pi-shared.js
- Modify: ui/sdpi.css

- [ ] **Step 1: radio group과 hidden 간격의 실패 테스트 작성**

테스트는 uiUpdateMode select 대신 다음을 검증한다.

    const realtime = document.querySelector(
      'input[name="uiUpdateMode"][value="realtime"]'
    );
    const throttled = document.querySelector(
      'input[name="uiUpdateMode"][value="throttled"]'
    );
    const intervalRow = document.getElementById("renderIntervalField");

    expect(realtime.checked).toBe(true);
    expect(intervalRow.hidden).toBe(true);
    expect(interval.value).toBe("700");

스로틀 radio change 후 intervalRow.hidden이 false이고 기존 값이 보존되는지 검증한다.

- [ ] **Step 2: 기존 select 구현에서 실패 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts -t "render mode|throttle interval"

Expected: FAIL — radio와 renderIntervalField가 없다.

- [ ] **Step 3: 모드 control helper 구현**

stock-pi-shared.js에 다음 책임의 helper를 추가한다.

    selectedUiUpdateMode()
    setSelectedUiUpdateMode(mode)
    syncRenderIntervalVisibility()

syncRenderIntervalVisibility는 renderIntervalField.hidden만 전환한다. renderIntervalMs.value를 지우거나 50으로 바꾸지 않으며 input disabled에 의존하지 않는다.

- [ ] **Step 4: 접근 가능한 segmented radio markup/CSS 구현**

fieldset/legend 또는 aria-labelled group을 사용하고 두 label을 동일 너비로 표시한다. checked input의 label만 active 스타일을 가지되 텍스트로도 선택 상태가 드러나게 한다.

- [ ] **Step 5: snapshot hydrate와 저장 payload를 helper로 전환**

applyPreferenceSnapshot은 setSelectedUiUpdateMode를 사용한다. preferences/save payload는 selectedUiUpdateMode 결과와 보존된 renderIntervalMs를 사용한다. 기존 500~1000ms, 100ms 단위 검증은 유지한다.

- [ ] **Step 6: 모드 왕복·유효성·payload 테스트 통과 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts -t "render mode|throttle interval|preference payload"

Expected: PASS

- [ ] **Step 7: 모드 UI 커밋**

    git add src/pi/__tests__/pi-ui.test.ts ui/stock-pi-shared.js ui/sdpi.css
    git commit -m "feat: show throttle interval only when applicable"

### Task 3: 전역 환경설정 dirty·pending·결과 상태

**Files:**
- Modify: src/pi/__tests__/pi-ui.test.ts
- Modify: ui/stock-pi-shared.js
- Modify: ui/sdpi.css

- [ ] **Step 1: clean/dirty/revert 상태의 실패 테스트 작성**

authoritative snapshot 적용 직후 저장 버튼 disabled를 검증한다. dataMode, radio, interval, backupPollIntervalMs 중 하나를 바꾸면 enabled, 원래 값으로 되돌리면 disabled인지 검증한다. dirty 상태 문구는 저장하지 않은 변경사항을 포함해야 한다.

- [ ] **Step 2: pending 및 결과 상태의 실패 테스트 작성**

저장 click 직후 버튼 disabled와 중복 click command 차단을 검증한다. 저장 중 새 편집 후 성공 응답이 오면 새 편집값이 보존되고 버튼이 다시 enabled인지 검증한다. 오류 응답은 dirty/enabled, 충돌 snapshot은 적용 결과에 따라 clean 또는 dirty인지 검증한다.

- [ ] **Step 3: 기존 구현에서 실패 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts -t "preference save state"

Expected: FAIL — 저장 버튼은 항상 활성화되고 current controls와 snapshot 비교가 없다.

- [ ] **Step 4: preference control snapshot helper 구현**

다음 helper를 추가한다.

    readPreferenceControls()
    preferencesDirty()
    preferenceSavePending()
    syncPreferenceSaveState(message, kind)

readPreferenceControls는 dataMode, selectedUiUpdateMode, renderIntervalMs, backupPollIntervalMs를 반환한다. controller에는 lastAuthoritativePreferences를 추가하고, freshness/revision 검사를 통과한 모든 current snapshot에서 control hydrate 여부와 무관하게 갱신한다. 기존 lastAppliedPreferences는 실제 control에 hydrate된 snapshot 추적 용도로 유지한다. preferencesDirty는 lastAuthoritativePreferences가 없으면 false이고, 있으면 current controls와 preferencesEqual로 비교한다.

- [ ] **Step 5: 입력·snapshot·응답 경계마다 상태 동기화**

모든 preference change/input listener에서 edit version 증가 후 visibility와 save state를 동기화한다. preferences/save를 보내면 pending 상태를 표시한다. applySafeSnapshot은 snapshot이 accepted된 직후 lastAuthoritativePreferences를 먼저 갱신한 다음 hydrate 여부를 판단한다. handleMessage에서 success/error/conflict snapshot 처리 후 current control과 lastAuthoritativePreferences를 다시 비교해 버튼과 상태를 결정한다.

기존 snapshot epoch/sequence, late acknowledgement, dirty edit protection 로직은 삭제하지 않는다. applyPreferences 여부는 단순 editVersion === 0 대신 현재 dirty/pending 상태를 고려하되, 저장 중 추가 편집을 remote snapshot이 덮지 않도록 한다.

- [ ] **Step 6: 상태 전이 및 기존 ordering 회귀 테스트 통과 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts

Expected: PASS — 기존 96개 테스트와 새 저장 상태 테스트가 모두 통과한다.

- [ ] **Step 7: 저장 상태 커밋**

    git add src/pi/__tests__/pi-ui.test.ts ui/stock-pi-shared.js ui/sdpi.css
    git commit -m "feat: clarify global preference save state"

### Task 4: 계정 onboarding, 삭제 확인, 문제 해결·진단 분리

**Files:**
- Modify: src/pi/__tests__/pi-ui.test.ts
- Modify: ui/stock-pi-shared.js
- Modify: ui/sdpi.css

- [ ] **Step 1: KIS 계정 최초 자동 open 테스트 작성**

첫 accepted settings response 또는 settings/update snapshot에서 credentialsConfigured가 false이면 credentialsDetails.open이 true인지 검증한다. true이면 닫힌 상태인지 검증한다. 첫 적용 이후 사용자가 toggle한 상태를 후속 snapshot이 덮지 않는지 검증한다.

- [ ] **Step 2: 자격증명 삭제 확인 테스트 작성**

window.confirm을 false로 stub하면 credentials/clear command와 상태 변경이 없어야 한다. true이면 기존 settingsRevision payload로 한 번만 command를 보내야 한다.

- [ ] **Step 3: 문제 해결과 lazy diagnostics 테스트 작성**

retry/reconnect/refresh 버튼이 troubleshooting section 안에 있고 기존 command type을 보내는지 검증한다. diagnosticsDetails를 처음 열면 diagnostics/request를 한 번 보내고, 닫았다 다시 열어도 자동 요청은 반복하지 않는지 검증한다. 내부 새로고침은 매번 요청한다.

- [ ] **Step 4: 기존 구현에서 실패 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts -t "credentials disclosure|credential clear|troubleshooting|diagnostics disclosure"

Expected: FAIL — 자동 open, confirm, nested diagnostics open 요청 동작이 연결되지 않았다.

- [ ] **Step 5: accordion lifecycle 상태 구현**

controller에 credentialsDisclosureInitialized, credentialsDisclosureTouched, diagnosticsRequestedOnOpen을 추가한다. credentialsDetails toggle listener는 사용자 open 상태를 touched로 표시한다. 처음 적용된 current snapshot에서만 credential disclosure를 초기화한다.

- [ ] **Step 6: 위험 작업 confirmation과 문제 해결 status 구현**

clearCredentialsButton handler의 command 전송 전에 명확한 Korean confirm 문구를 검사한다. 인증/재연결/새로고침 pending section을 troubleshooting으로 분리하고 troubleshootingStatusMessage에 성공·오류 상태를 표시한다.

- [ ] **Step 7: nested diagnostics 동작 연결**

Task 1에서 만든 diagnosticsDetails에 toggle listener를 연결한다. open transition에서 최초 한 번만 request를 보내며 기존 diagnostics/update 적용은 유지한다.

- [ ] **Step 8: 대상·전체 PI 테스트 통과 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts

Expected: PASS

- [ ] **Step 9: 계정·문제 해결 커밋**

    git add src/pi/__tests__/pi-ui.test.ts ui/stock-pi-shared.js ui/sdpi.css
    git commit -m "feat: separate account and troubleshooting flows"

### Task 5: scope summary와 국내·미국 shared UI 회귀 고정

**Files:**
- Modify: src/pi/__tests__/pi-ui.test.ts
- Modify: src/__tests__/domestic-stock-pi.test.ts
- Modify: ui/stock-pi-shared.js

- [ ] **Step 1: 닫힌 summary 갱신 실패 테스트 작성**

action settings 수신 시 이 버튼 summary가 종목명 · 코드가 되는지, credential snapshot에 따라 Key 저장됨/설정 필요가 되는지, preference snapshot에 따라 자동 · 실시간 또는 자동 · 스로틀 700ms가 되는지 검증한다.

- [ ] **Step 2: summary 테스트가 기존 구현에서 실패하는지 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts -t "disclosure summary"

Expected: FAIL — 기존 summary에는 동적 종목·계정·preference 요약이 없다.

- [ ] **Step 3: 국내·미국 entry shared 계약 테스트 갱신**

두 HTML entry가 stock-pi-shared.js와 sdpi.css를 로드하며 별도 복제 markup이 없는지 검증한다. 국내·미국 config field가 새 이 버튼 section 안에서 정상 렌더되는 기존 테스트를 유지한다.

- [ ] **Step 4: summary helper 구현**

updateActionSummary, updateCredentialSummary, updatePreferenceSummary를 추가하고 해당 snapshot/action settings 적용 직후 호출한다. 사용자 입력 중 action summary는 유효한 current control 값을 반영하되 자동 저장 validation은 기존 정책을 따른다.

- [ ] **Step 5: 대상 테스트 통과 확인**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts src/__tests__/domestic-stock-pi.test.ts

Expected: PASS

- [ ] **Step 6: shared summary 커밋**

    git add src/pi/__tests__/pi-ui.test.ts src/__tests__/domestic-stock-pi.test.ts ui/stock-pi-shared.js
    git commit -m "test: lock shared property inspector summaries"

### Task 6: 문서 갱신

**Files:**
- Modify: README.md
- Modify: AGENTS.md

- [ ] **Step 1: README 사용법 갱신**

기존 접힌 고급 설정 설명을 공통 연결 상태, 이 버튼, KIS 계정, 전체 버튼 환경설정, 문제 해결 구조로 교체한다. 실시간에서는 간격이 숨겨지고 스로틀링 선택 시 500~1000ms 입력이 나타난다고 명시한다. 자동 저장과 전역 명시 저장의 차이도 적는다.

- [ ] **Step 2: AGENTS 아키텍처 설명 갱신**

PI의 semantic accordion, explicit chevron, scope badge, conditional throttle field, nested diagnostics 원칙을 기록한다.

- [ ] **Step 3: 문서의 구형 표현 검색**

Run: rg -n "접힌 고급 설정|고급 설정 저장|비활성화되지만" README.md AGENTS.md

Expected: 현재 UI와 충돌하는 구형 문구 0건

- [ ] **Step 4: 문서 커밋**

    git add README.md AGENTS.md
    git commit -m "docs: describe redesigned property inspector"

### Task 7: 코드 리뷰와 기능 브랜치 검증

**Files:**
- Review: 모든 feature branch 변경

- [ ] **Step 1: 변경 범위 정적 검사**

Run: git diff --check main...HEAD

Expected: 출력 없음

Run: git diff --name-only main...HEAD

Expected: 설계·계획·PI JS/CSS/테스트/README/AGENTS만 포함

- [ ] **Step 2: 요구사항별 targeted 테스트 실행**

Run: npx vitest run src/pi/__tests__/pi-ui.test.ts src/__tests__/domestic-stock-pi.test.ts

Expected: PASS

- [ ] **Step 3: 전체 검증 실행**

Run: npm run typecheck

Expected: exit 0

Run: npm test

Expected: 모든 test file과 test 통과

Run: npm run test:coverage

Expected: coverage gate 통과

Run: npm run build

Expected: bin/plugin.js 생성 및 검증 통과

Run: npm run package:plugin

Expected: dist/com.kis.streamdeck-v2.1.0.streamDeckPlugin 생성

Run: npm run package:smoke

Expected: 실제 archive smoke 검증 통과

- [ ] **Step 4: 독립 코드 리뷰**

superpowers:requesting-code-review를 사용해 Critical/Important/Minor 이슈를 검토한다. 유효한 이슈는 systematic-debugging과 TDD로 수정하고 targeted/전체 검증을 반복한다.

- [ ] **Step 5: 기능 브랜치 최종 커밋 상태 확인**

Run: git status --short --branch

Expected: clean feature worktree

### Task 8: main 병합과 v2.2.0 릴리스

**Files:**
- Modify by release script: package.json
- Modify by release script: package-lock.json
- Modify by release script: manifest.json

- [ ] **Step 1: finishing-a-development-branch 절차로 main에 병합**

main을 origin/main과 fast-forward한 뒤 codex/property-inspector-ui-redesign을 fast-forward merge한다. 병합된 main에서 npm test를 다시 실행한다.

- [ ] **Step 2: 기능 worktree와 로컬 feature branch 정리**

병합 검증 후 .worktrees/property-inspector-ui-redesign을 제거하고 codex/property-inspector-ui-redesign 로컬 브랜치를 삭제한다. 사용자 소유 .codex/와 .superpowers/는 건드리지 않는다.

- [ ] **Step 3: minor release commit과 tag 생성**

Run: npm run release:minor

Expected: package.json, package-lock.json, manifest.json이 2.2.0으로 동기화되고 release commit 2.2.0과 annotated tag v2.2.0이 생성된다.

- [ ] **Step 4: release commit 전체 검증**

Run: npm run verify

Expected: typecheck, coverage, build, production audit 모두 통과

Run: npm run package:plugin

Expected: dist/com.kis.streamdeck-v2.2.0.streamDeckPlugin 생성

Run: npm run package:smoke

Expected: v2.2.0 archive smoke 검증 통과

- [ ] **Step 5: main과 tag 푸시**

Run: git push origin main

Expected: main이 release commit으로 갱신

Run: git push origin v2.2.0

Expected: release workflow 시작

- [ ] **Step 6: GitHub Actions와 Release 자산 확인**

gh run watch로 v2.2.0 Release Stream Deck Plugin workflow가 success인지 확인한다. gh release view v2.2.0으로 draft/prerelease가 아니며 com.kis.streamdeck-v2.2.0.streamDeckPlugin 자산이 uploaded 상태인지 확인한다.

- [ ] **Step 7: 최종 completion audit**

section 구조, 명확한 folding, 실시간 conditional hide, 스로틀 value 보존, dirty/pending save, confirmation, troubleshooting/diagnostics, 국내·미국 shared UI, 문서, tests, package, tag, GitHub Release 각각의 직접 증거를 대조한다. 모든 항목이 증명된 뒤에만 goal을 complete로 표시한다.
