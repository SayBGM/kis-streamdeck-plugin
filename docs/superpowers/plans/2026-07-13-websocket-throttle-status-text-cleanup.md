# WebSocket Throttle and Status Text Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KIS의 실제 WebSocket 구독 성공 응답을 인식하고, 모든 시세를 수신하면서 화면에는 설정 간격의 최신 값만 반영하며, 일반 시세 카드 하단 상태 텍스트를 제거한다.

**Architecture:** `SubscriptionSupervisor`는 공식 응답 위치인 `header.tr_key`를 기존 body fallback보다 먼저 읽되 현재 제어 작업과의 정확한 키 일치를 계속 요구한다. 시세 데이터는 기존 `StockActionController → RenderScheduler` 흐름을 그대로 사용해 수신 단계에서는 버리지 않고 버튼별 마지막값 우선으로 2·5·10초 화면 반영만 제한한다. 렌더러는 정상 quote 분기에서만 하단 상태 텍스트와 결합 스피너를 제거하고 제목 색상·점 및 예외 카드는 유지한다.

**Tech Stack:** TypeScript 5.7, SVG, Vitest 3, happy-dom, Stream Deck Property Inspector JavaScript, Rollup

---

## 파일 구조

- Modify: `src/kis/subscription-supervisor.ts` — KIS 제어 응답의 `header.tr_key`를 우선 인식한다.
- Modify: `src/kis/__tests__/subscription-supervisor.test.ts` — 실제 KIS ACK 형식과 키 불일치 보호를 검증한다.
- Modify: `src/actions/__tests__/stock-action-controller.policy.test.ts` — 모든 WS 틱 처리와 최신값 화면 스로틀을 통합 검증한다.
- Modify: `ui/stock-pi-shared.js` — 기존 `renderIntervalMs` 설정을 `화면 갱신 제한`으로 명확히 표시한다.
- Modify: `src/pi/__tests__/pi-ui.test.ts` — 스로틀 설정의 사용자 표시와 기존 저장 값을 검증한다.
- Modify: `src/renderer/stock-card.ts` — quote 화면의 하단 상태 텍스트·스피너를 제거하고 등락 행을 `y=116`으로 옮긴다.
- Modify: `src/renderer/__tests__/stock-card.stock-action-view.test.ts` — 신규 quote 렌더 경로의 상태 텍스트 부재와 제목 상태색 유지를 검증한다.
- Modify: `src/renderer/__tests__/stock-card.rendering.test.ts` — 레거시 quote 렌더 경로를 같은 규칙으로 검증한다.
- Modify: `AGENTS.md` — stale 및 일반 카드 상태 표시 설명을 새 UI와 일치시킨다.
- Modify: `CLAUDE.md` — `AGENTS.md`와 동일한 프로젝트 지침을 유지한다.
- Modify: `README.md` — 카드 상태 표시와 PI 화면 갱신 제한 설명을 사용자 문서에 반영한다.

## Task 1: 실제 KIS WebSocket 구독 ACK 인식

**Files:**
- Modify: `src/kis/__tests__/subscription-supervisor.test.ts:69-74,199-225`
- Modify: `src/kis/subscription-supervisor.ts:583-604`

@superpowers:test-driven-development

- [ ] **Step 1: 실제 KIS header key 성공 응답의 실패 테스트 작성**

기존 body 기반 `control()`은 호환 테스트를 위해 유지하고 실제 응답용 헬퍼를 추가한다.

```ts
function kisControl(trId: string, trKey: string, msgCd = "OPSP0000"): string {
  return JSON.stringify({
    header: { tr_id: trId, tr_key: trKey, encrypt: "N" },
    body: {
      rt_cd: msgCd === "OPSP0000" || msgCd === "OPSP0002" ? "0" : "1",
      msg_cd: msgCd,
      msg1: "SUBSCRIBE SUCCESS",
    },
  });
}

it("accepts the KIS control key from the response header without reconnecting", async () => {
  const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
  const handle = supervisor.subscribe(descriptor);
  await flush();

  connection.emitRaw(kisControl(descriptor.trId, descriptor.trKey));

  expect(handle.snapshot?.state).toBe("live");
  advance(5_000);
  expect(connection.reconnects).toBe(0);
});
```

- [ ] **Step 2: 테스트가 현재 ACK 파서 때문에 올바르게 실패하는지 확인**

Run: `npx vitest run src/kis/__tests__/subscription-supervisor.test.ts -t "accepts the KIS control key"`

Expected: FAIL — 상태가 `pending`이며 5초 뒤 reconnect가 1회 발생한다.

- [ ] **Step 3: 다른 header key를 현재 작업으로 승인하지 않는 실패 테스트 추가**

```ts
it("does not acknowledge a different KIS header control key", async () => {
  const descriptor = { trId: "H0UNCNT0", trKey: "005930" } as const;
  const handle = supervisor.subscribe(descriptor);
  await flush();

  connection.emitRaw(kisControl(descriptor.trId, "000660"));

  expect(handle.snapshot?.state).toBe("pending");
  advance(5_000);
  expect(connection.reconnects).toBe(1);
});
```

- [ ] **Step 4: header → body output → body input 순서의 최소 구현**

`src/kis/subscription-supervisor.ts`의 제어 프레임 파싱을 다음처럼 바꾼다.

```ts
const trId = (header as { tr_id?: unknown }).tr_id;
const msgCd = (body as { msg_cd?: unknown }).msg_cd;
const input = (body as { input?: unknown }).input;
const output = (body as { output?: unknown }).output;
const trKey = this.readControlKey(header) ??
  this.readControlKey(output) ??
  this.readControlKey(input);
```

키 없는 응답과 키 불일치 응답을 거부하는 아래의 정확 일치 검사는 변경하지 않는다.

```ts
if (trKey !== job.entry.descriptor.trKey) return;
```

- [ ] **Step 5: WebSocket 구독 관리자 테스트 통과 확인**

Run: `npx vitest run src/kis/__tests__/subscription-supervisor.test.ts`

Expected: PASS — 신규 header ACK 테스트와 기존 body/keyless/직렬화 테스트가 모두 통과한다.

- [ ] **Step 6: 변경 커밋**

```bash
git add src/kis/subscription-supervisor.ts src/kis/__tests__/subscription-supervisor.test.ts
git commit -m "fix: accept KIS websocket header subscription keys"
```

## Task 2: 화면 스로틀링 노출과 종단 간 계약 고정

**Files:**
- Modify: `src/pi/__tests__/pi-ui.test.ts:92-110,150-180`
- Modify: `ui/stock-pi-shared.js:104-114`
- Modify: `src/actions/__tests__/stock-action-controller.policy.test.ts:330-390,1357-1401`

@superpowers:test-driven-development

- [ ] **Step 1: PI의 화면 갱신 제한 표기 실패 테스트 작성**

```ts
it("labels the existing render throttle as a screen refresh limit", () => {
  const { document } = createUi();

  expect(document.body.textContent).toContain("화면 갱신 제한");
  expect(document.body.textContent).not.toContain("렌더 간격");
  const select = document.getElementById("renderIntervalMs") as HTMLSelectElement;
  expect(Array.from(select.options).map((option) => option.value)).toEqual([
    "2000",
    "5000",
    "10000",
  ]);
});
```

- [ ] **Step 2: 새 PI 테스트의 RED 확인**

Run: `npx vitest run src/pi/__tests__/pi-ui.test.ts -t "screen refresh limit"`

Expected: FAIL — 현재 DOM에는 `렌더 간격`만 존재한다.

- [ ] **Step 3: 사용자 표기만 최소 변경**

`ui/stock-pi-shared.js`에서 저장 키와 option 값은 바꾸지 않고 label만 변경한다.

```js
'<div class="sdpi-item"><div class="sdpi-item-label">화면 갱신 제한</div><div class="sdpi-item-value">',
```

- [ ] **Step 4: PI 테스트 GREEN 확인**

Run: `npx vitest run src/pi/__tests__/pi-ui.test.ts`

Expected: PASS — 2·5·10초 값과 `preferences/save` payload가 기존 그대로다.

- [ ] **Step 5: 모든 WS 틱 처리와 마지막값 우선 화면 반영 통합 테스트 추가**

기존 `makeAdapter()`의 `parseWebSocket`을 spy로 감싸고 실제 `RenderScheduler`를 주입한다. 초기 화면과 연결 상태 화면을 먼저 flush한 뒤 세 틱을 2초 창 안에 전달한다.

```ts
it("processes every websocket quote and commits only the latest value per render interval", async () => {
  const base = makeAdapter();
  const parseWebSocket = vi.fn(base.parseWebSocket.bind(base));
  const adapter = { ...base, parseWebSocket };
  const renderScheduler = new RenderScheduler({
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  const test = setup({
    adapterResolver: () => adapter,
    renderScheduler,
  });
  test.settings.resolve();
  const setImage = vi.fn();
  await test.controller.appear({
    actionId: "throttled",
    settings: { symbol: "005930" },
    actionPort: { setImage },
  });
  await vi.advanceTimersByTimeAsync(2_000);
  test.subscriptions.state("live");
  await vi.advanceTimersByTimeAsync(1_000);
  setImage.mockClear();

  test.subscriptions.data(70_000);
  test.subscriptions.data(71_000);
  test.subscriptions.data(72_000);

  expect(parseWebSocket).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(setImage).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(setImage).toHaveBeenCalledTimes(1);
  expect(JSON.parse(setImage.mock.calls[0]![0] as string).quote.price).toBe(72_000);
  renderScheduler.destroy();
});
```

이 테스트가 기존 구현에서 바로 통과하면 스로틀 데이터 경계의 characterization으로 유지하고 새 처리 계층을 추가하지 않는다. 실패한다면 원인을 조사한 뒤 `RenderScheduler`의 마지막값 우선 계약만 최소 수정하며 원문/시세 이벤트 드롭은 추가하지 않는다.

- [ ] **Step 6: 관련 스로틀 테스트 통과 확인**

Run: `npx vitest run src/actions/__tests__/stock-action-controller.policy.test.ts src/renderer/__tests__/render-scheduler.test.ts src/pi/__tests__/pi-ui.test.ts`

Expected: PASS — 모든 시세 파싱 3회, 화면 커밋 1회, 마지막 가격 72,000.

- [ ] **Step 7: 변경 커밋**

```bash
git add ui/stock-pi-shared.js src/pi/__tests__/pi-ui.test.ts src/actions/__tests__/stock-action-controller.policy.test.ts
git commit -m "feat: expose latest-value screen throttling"
```

## Task 3: StockActionView 시세 카드 하단 상태 텍스트 제거

**Files:**
- Modify: `src/renderer/__tests__/stock-card.stock-action-view.test.ts:43-76,79-194`
- Modify: `src/renderer/stock-card.ts:415-441`

@superpowers:test-driven-development

- [ ] **Step 1: quote 전용 상태 텍스트 부재 helper와 실패 테스트 작성**

테스트에서 SVG를 DOM으로 파싱해 종목명·점·가격·등락률을 유지하면서 quote 상태 문구만 없는지 확인한다.

```ts
const QUOTE_STATUS_TEXTS = [
  "실시간",
  "백업",
  "백업 · 지연",
  "지연",
  "시세 지연",
  "새로고침 중",
  "연결 확인 필요",
] as const;

function expectNoQuoteStatus(svg: string): void {
  for (const text of QUOTE_STATUS_TEXTS) expect(svg).not.toContain(`>${text}<`);
  expect(svg).not.toContain('data-role="loading-indicator"');
}
```

다음 조합을 각각 검증한다.

```ts
it.each([
  { connection: undefined, stale: true, refreshing: false, color: "#7f8aa8" },
  { connection: "LIVE" as const, stale: false, refreshing: false, color: "#00c853" },
  { connection: "BACKUP" as const, stale: false, refreshing: false, color: "#7dd3fc" },
  { connection: "BROKEN" as const, stale: true, refreshing: true, color: "#ff1744" },
  { connection: "LIVE" as const, stale: true, refreshing: true, color: "#00c853" },
])("omits quote status text for $connection", ({ connection, stale, refreshing, color }) => {
  const svg = renderStockActionView(view({ connection, stale, refreshing }));
  expectNoQuoteStatus(svg);
  expectConnectionTitle(svg, color);
  expect(svg).toContain("72,100");
  expect(svg).toContain("▲ +1.25%");
});
```

등락률 DOM 노드의 기준선이 `y=116`인지도 검증한다.

기존의 quote 상태 문구 존재 테스트는 위 부재 테스트로 교체하고, 더 이상 사용되지 않는
`expectStatusLabel()` 테스트 헬퍼도 제거한다. 대기·오류·회복 카드의 상태 문구 기대는 유지한다.

- [ ] **Step 2: quote 렌더 테스트 RED 확인**

Run: `npx vitest run src/renderer/__tests__/stock-card.stock-action-view.test.ts`

Expected: FAIL — 기존 상태 문구, refreshing 스피너, 등락률 `y=108`이 남아 있다.

- [ ] **Step 3: 신규 quote 경로 최소 구현**

`renderStockActionQuote()`에서 `effectiveRefreshing`, `statusText`, `statusColor` 계산과 `renderStatusLabel()` 호출을 제거한다. 가격 기준선은 유지하고 등락률만 이동한다.

```ts
<text x="72" y="82" ...>${escapeXml(priceText)}</text>
<text x="72" y="116" ...>${escapeXml(rateText)}</text>
```

대기·오류·회복 분기와 `renderLoadingIndicator()`는 수정하지 않는다.

- [ ] **Step 4: 신규 렌더 경로 GREEN 확인**

Run: `npx vitest run src/renderer/__tests__/stock-card.stock-action-view.test.ts`

Expected: PASS — quote 화면에는 상태 문구·스피너가 없고 제목 색상과 점은 유지된다.

- [ ] **Step 5: 변경 커밋**

```bash
git add src/renderer/stock-card.ts src/renderer/__tests__/stock-card.stock-action-view.test.ts
git commit -m "feat: remove quote status text from stock action cards"
```

## Task 4: 레거시 시세 카드 정렬과 미사용 상태 helper 제거

**Files:**
- Modify: `src/renderer/__tests__/stock-card.rendering.test.ts:58-110`
- Modify: `src/renderer/stock-card.ts:595-652,678-754`

@superpowers:test-driven-development

- [ ] **Step 1: 레거시 quote 상태 텍스트 부재 실패 테스트 작성**

`renderStockCard()`의 `LIVE`, `BACKUP + stale`, `BROKEN + refreshing` 조합에서 다음을 검증한다.

```ts
expect(svg).not.toContain("실시간");
expect(svg).not.toContain("백업 · 지연");
expect(svg).not.toContain("연결 확인 필요");
expect(svg).not.toContain("새로고침 중");
expect(svg).not.toContain('data-role="loading-indicator"');
expectConnectionTitle(svg, expectedColor);
expect(svg).toContain("AAPL");
expect(svg).toContain("$182.52");
expect(svg).toContain("0.68%");
```

변동량과 등락률 노드의 기준선이 모두 `y=116`인지 DOM으로 검증한다. 대기·연결·회복·오류·설정 카드 테스트는 기존 기대를 유지한다.
기존 레거시 quote 상태 문구 존재 테스트는 같은 조합의 부재 테스트로 교체한다.

- [ ] **Step 2: 레거시 렌더 테스트 RED 확인**

Run: `npx vitest run src/renderer/__tests__/stock-card.rendering.test.ts`

Expected: FAIL — 기존 하단 상태 markup과 `y=108` 등락 행이 남아 있다.

- [ ] **Step 3: 레거시 quote 경로 최소 구현**

`renderStockCard()`에서 `effectiveRefreshing`, `statusText`, `statusColor`, `statusMarkup` 계산과 SVG 삽입을 제거한다. 변동량과 등락률 기준선만 `y=116`으로 바꾼다.

```ts
<text x="12" y="116" ...>${escapeXml(changeStr)}</text>
<text x="132" y="116" ...>${escapeXml(rateStr)}</text>
```

- [ ] **Step 4: quote 경로 제거 후 미사용 helper 정리**

프로젝트 전체 사용처를 확인한다.

Run: `rg -n "COLOR_TEXT_STALE|getConnectionTextColor|getConnectionStatusText|renderStatusLabel" src/renderer/stock-card.ts src`

Expected: production call site가 없다. 다음 항목을 삭제한다.

- `COLOR_TEXT_STALE`
- `getConnectionTextColor()`
- `getConnectionStatusText()`
- `renderStatusLabel()`

`renderLoadingIndicator()`와 `COLOR_LOADING`은 대기 화면이 사용하므로 유지한다. 공개 `StockCardRenderOptions` 타입의 `isStale`, `isRefreshing` 필드는 호환성을 위해 유지한다.

- [ ] **Step 5: 두 렌더 테스트와 타입 검사 통과 확인**

Run: `npx vitest run src/renderer/__tests__/stock-card.stock-action-view.test.ts src/renderer/__tests__/stock-card.rendering.test.ts && npm run typecheck`

Expected: PASS — quote 경로는 간결해지고 예외 카드 동작은 유지된다.

- [ ] **Step 6: 변경 커밋**

```bash
git add src/renderer/stock-card.ts src/renderer/__tests__/stock-card.rendering.test.ts
git commit -m "feat: align legacy quote status cleanup"
```

## Task 5: 프로젝트 문서 동기화와 전체 검증

**Files:**
- Modify: `AGENTS.md:69-76`
- Modify: `CLAUDE.md:69-76`
- Modify: `README.md:18-28,72-78`

- [ ] **Step 1: 프로젝트 지침의 오래된 하단 상태 문구 설명 수정**

`AGENTS.md`와 `CLAUDE.md`를 같은 내용으로 맞춘다.

```md
- 종목명과 앞쪽 작은 점: LIVE=초록, BACKUP=파랑, BROKEN=빨강, 대기=회색
- 일반 시세 카드는 하단 연결·지연·새로고침 상태 텍스트를 표시하지 않음
- stale/refreshing 상태는 화면 모델과 렌더 의미 키에는 유지되며 종목명 상태색을 덮어쓰지 않음
- 하단 연결 상태 컬러 바는 사용하지 않음
```

- [ ] **Step 2: README 사용자 설명 갱신**

- 카드 설명에서 작은 하단 연결 상태 문구를 제거하고 종목명 색상+점으로 상태를 확인한다고 적는다.
- 고급 설정의 `렌더 간격`을 `화면 갱신 제한`으로 바꾸고 모든 WS 시세는 수신하되 최신 값만 선택 간격마다 표시한다고 설명한다.

- [ ] **Step 3: 문서 일관성 정적 확인**

Run: `rg -n "하단 지연 문구|렌더 간격|실시간.*백업.*하단" AGENTS.md CLAUDE.md README.md`

Expected: 오래된 설명이 없다.

- [ ] **Step 4: 대상 테스트 실행**

Run:

```bash
npx vitest run \
  src/kis/__tests__/subscription-supervisor.test.ts \
  src/actions/__tests__/stock-action-controller.policy.test.ts \
  src/renderer/__tests__/render-scheduler.test.ts \
  src/renderer/__tests__/stock-card.stock-action-view.test.ts \
  src/renderer/__tests__/stock-card.rendering.test.ts \
  src/pi/__tests__/pi-ui.test.ts
```

Expected: PASS.

- [ ] **Step 5: 전체 품질 게이트 실행**

Run:

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run package:plugin
npm run package:smoke
git diff --check
```

Expected:

- TypeScript 오류 0개
- 전체 Vitest 테스트 통과
- 기존 커버리지 임계값 통과
- `bin/plugin.js` 프로덕션 빌드 성공
- `.streamDeckPlugin` 패키지 생성 및 smoke 검증 성공
- whitespace 오류 없음

- [ ] **Step 6: 최종 독립 코드 리뷰**

@superpowers:requesting-code-review

설계 문서와 구현 계획을 기준으로 WebSocket 상관관계 안전성, 시세 이벤트 무손실, 화면 스로틀 최신값 보장, quote 전용 UI 범위를 검토한다. Critical/Important 문제가 있으면 수정 후 대상 테스트와 전체 검증을 다시 실행한다.

- [ ] **Step 7: 문서 및 검증 변경 커밋**

```bash
git add AGENTS.md CLAUDE.md README.md
git commit -m "docs: describe websocket screen throttling"
```

- [ ] **Step 8: 완료 상태 확인**

Run: `git status --short && git log -7 --oneline`

Expected: 사용자 소유의 미추적 `.superpowers/` 외 작업 트리가 깨끗하고, 설계·WebSocket·스로틀·UI·문서 커밋이 순서대로 존재한다.
