# Stock Card Change Amount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KIS가 제공한 전일 대비 등락폭을 canonical `Quote`에 보존하고, 국내·미국 144×144 시세 카드 하단에 등락폭과 등락률을 함께 표시한다.

**Architecture:** `MarketAdapter`가 시장별 WS/REST 원문 change 필드를 strict parsing하고 sign code로 `change`와 `changeRate`를 canonical signed number로 정규화한다. REST coordinator와 renderer의 exact-key 안전 경계, controller semantic key가 새 필드를 전달하며, `renderStockActionView`만 하단 2열 표현으로 변경한다. 레거시 `StockData`/`renderStockCard` 계약과 PI·통신·스케줄러 정책은 유지한다.

**Tech Stack:** TypeScript, Vitest, happy-dom SVG parsing, Stream Deck SVG renderer, npm scripts

---

## 파일 구조

- Modify: `src/markets/market-adapter.ts` — 필수 `Quote.change`, API-native change parsing, sign 기반 canonical 정규화
- Modify: `src/markets/__tests__/market-adapter.test.ts` — 국내·해외 WS/REST change와 malformed payload 테스트
- Modify: `src/kis/rest-coordinator.ts` — REST quote exact-key/finite 검증과 frozen copy에 change 포함
- Modify: `src/kis/__tests__/rest-coordinator.http-cache.test.ts` — REST boundary의 change 전달·거부 테스트와 fixtures
- Modify: `src/kis/__tests__/rest-coordinator.scheduler.test.ts` — 국내 REST payload fixture에 `prdy_vrss` 추가
- Modify: `src/actions/stock-action-controller.ts` — 가시 semantic key에 change 포함
- Modify: `src/actions/__tests__/stock-action-controller.policy.test.ts` — change-only tick 렌더와 quote fixtures
- Modify: `src/renderer/stock-card.ts` — safe quote boundary, signed formatter, 2열 SVG, 긴 문자열 font-size/폭 제한
- Modify: `src/renderer/__tests__/stock-card.stock-action-view.test.ts` — 국내·해외·보합·경계·data-role 레이아웃 테스트
- Modify: `src/renderer/__tests__/stock-card.rendering.test.ts` — 필수 quote fixture 영향 없이 레거시 renderer 회귀 확인
- Modify: `README.md` — 시세 카드가 등락폭·등락률을 함께 표시한다고 안내
- Modify as required by `npm run typecheck`: 그 외 `QuoteSample` test fixtures — 필수 `change`를 명시

새 production module이나 schema migration은 만들지 않는다.

**실행 전제:** 승인된 설계와 이 계획은 구현 시작 전에 `docs: design stock card change amount` 커밋으로 이미 추적돼 있어야 한다. 실행자는 시작 시 두 문서가 `git ls-files`에 나타나는지 확인하고, untracked라면 구현을 시작하지 말고 문서 커밋부터 복구한다.

### Task 1: API-native change를 canonical Quote와 안전 경계에 전달

**Files:**
- Modify: `src/markets/__tests__/market-adapter.test.ts`
- Modify: `src/kis/__tests__/rest-coordinator.http-cache.test.ts`
- Modify: `src/kis/__tests__/rest-coordinator.scheduler.test.ts`
- Modify: `src/markets/market-adapter.ts`
- Modify: `src/kis/rest-coordinator.ts`
- Modify: `src/renderer/stock-card.ts`
- Modify: `src/actions/__tests__/stock-action-controller.policy.test.ts`
- Modify: `src/renderer/__tests__/stock-card.stock-action-view.test.ts`
- Modify as reported by `npm run typecheck`: `QuoteSample` fixtures under `src/**/__tests__/*.test.ts`

- [ ] **Step 1: 국내·해외 WS/REST parsing 실패 테스트 작성**

`src/markets/__tests__/market-adapter.test.ts`의 canonical quote 기대값에 다음을 추가한다.

```ts
expect(domesticStockAdapter.parseWebSocket(
  ["005930", "100000", "71200", "5", "1200", "-1.66"],
  domesticInstrument,
  context,
)).toMatchObject({ change: -1_200, changeRate: -1.66, sign: "fall" });

expect(domesticStockAdapter.parseRest({
  output: {
    stck_prpr: "71200",
    prdy_vrss_sign: "2",
    prdy_vrss: "1200",
    prdy_ctrt: "-1.66",
  },
}, domesticInstrument, context)).toMatchObject({
  change: 1_200,
  changeRate: 1.66,
  sign: "rise",
});

expect(overseasStockAdapter.parseWebSocket(
  overseasFields(), overseasInstrument, context,
)).toMatchObject({ change: 1.5, changeRate: 0.72, sign: "rise" });

expect(overseasStockAdapter.parseRest({
  output: { last: "209.50", sign: "5", diff: "+1.50", rate: "+0.72" },
}, overseasInstrument, context)).toMatchObject({
  change: -1.5,
  changeRate: -0.72,
  sign: "fall",
});
```

보합 sign code `3`에서는 raw change/rate가 non-zero여도 canonical `change === 0`, `changeRate === 0`인지 별도 검증한다.

- [ ] **Step 2: malformed change 실패 테스트 작성**

국내 `fields[4]`/`prdy_vrss`, 해외 `fields[13]`/`diff` 각각에 대해 `undefined`, `null`, `"NaN"`, `"Infinity"`, `"1e3"`, `"0x10"`, `"12px"`를 넣고 `PROTOCOL` 오류인지 검증한다. 기존 accessor/proxy 안전 테스트에도 필수 change 필드를 빠뜨리지 않는다.

- [ ] **Step 3: adapter 테스트가 RED인지 확인**

Run: `npx vitest run src/markets/__tests__/market-adapter.test.ts`

Expected: FAIL — `Quote`에 `change`가 없고 REST parser가 `prdy_vrss`/`diff`를 읽지 않는다.

- [ ] **Step 4: Quote와 sign 정규화 helper 최소 구현**

`src/markets/market-adapter.ts`에 필수 필드와 공통 helper를 추가한다.

```ts
export interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly change: number;
  readonly changeRate: number;
  // existing fields unchanged
}

function signedValue(value: number, sign: PriceSign): number {
  if (sign === "fall") return -Math.abs(value);
  if (sign === "rise") return Math.abs(value);
  return 0;
}
```

`quote()`는 `(instrument, price, change, rate, sign, source, context)` 순서로 받고 frozen object에 다음을 넣는다.

```ts
change: signedValue(change, sign),
changeRate: signedValue(rate, sign),
```

각 parser는 설계 표의 필드에서 `change`를 `parseKisDecimal()`로 읽어 `quote()`에 전달한다. `requirePositive`는 가격에만 적용하고 change/rate는 0과 signed 문자열을 허용한다.

- [ ] **Step 5: adapter GREEN 확인**

Run: `npx vitest run src/markets/__tests__/market-adapter.test.ts`

Expected: PASS — 국내·해외 WS/REST, sign 정규화, malformed change가 모두 통과한다.

- [ ] **Step 6: REST coordinator exact-key 실패 테스트 작성**

`successfulResponse()`의 output과 성공 기대 quote에 `prdy_vrss: "1200"`, `change: 1_200`을 추가한다. custom quote도 `change: 0`을 포함한다.

기존 `customQuote()`와 `customAdapter()`를 이용해 `change`가 잘못된 adapter들을 만들고 다음을 검증한다.

```ts
const invalidChangeAdapter = customAdapter(
  "invalid-change",
  (_payload, instrumentValue, context) => ({
    ...customQuote(instrumentValue, context, 71_000),
    change: Number.NaN,
  }),
);

const missingChangeAdapter = customAdapter(
  "missing-change",
  (_payload, instrumentValue, context) => {
    const { change: _change, ...quoteWithoutChange } =
      customQuote(instrumentValue, context, 71_000);
    return quoteWithoutChange as QuoteSample;
  },
);
```

`Infinity`, accessor descriptor, extra key도 기존 table-driven validation에 추가한다.

- [ ] **Step 7: REST boundary RED 확인**

Run: `npx vitest run src/kis/__tests__/rest-coordinator.http-cache.test.ts src/kis/__tests__/rest-coordinator.scheduler.test.ts`

Expected: FAIL — `validateQuoteSample()`의 exact keys/copy에 `change`가 없다.

- [ ] **Step 8: REST coordinator와 renderer safe snapshot에 change 추가**

`validateQuoteSample()`의 key 목록, finite-number 조건, frozen 반환 object에 `change`를 추가한다.

`src/renderer/stock-card.ts`는 이 Task에서 출력 레이아웃을 바꾸지 않고 다음 안전 전달만 추가한다.

```ts
const MAX_ABSOLUTE_CHANGE = MAX_PRICE;
const QUOTE_KEYS = new Set([
  "symbol", "price", "change", "changeRate", "sign",
  "source", "receivedAt", "sessionEpoch",
]);
```

`snapshotStockActionView()`에서 `change`가 finite이고 `Math.abs(change) <= MAX_ABSOLUTE_CHANGE`인지 검사한 뒤 frozen quote copy에 포함한다. sign 일관성 검사는 Task 3의 renderer RED/GREEN에서 추가한다.

- [ ] **Step 9: 모든 required Quote fixture 갱신과 typecheck**

Run: `rg -n "changeRate:" src --glob '*.ts'`

각 canonical `QuoteSample`/`StockActionView.quote` fixture에 의미 있는 `change`를 추가한다. `rise` fixture는 양수, `fall` fixture는 음수, `flat` fixture만 0을 사용한다. 레거시 `StockData` fixture의 기존 `change`는 바꾸지 않는다.

Run: `npm run typecheck`

Expected: exit 0 — 필수 `change` 누락 없음.

- [ ] **Step 10: Task 1 전체 회귀 확인**

Run: `npx vitest run src/markets/__tests__/market-adapter.test.ts src/kis/__tests__/rest-coordinator.http-cache.test.ts src/kis/__tests__/rest-coordinator.scheduler.test.ts src/renderer/__tests__/stock-card.stock-action-view.test.ts src/actions/__tests__/stock-action-controller.policy.test.ts`

Expected: PASS

Run: `npm test`

Expected: 모든 test file과 test 통과.

- [ ] **Step 11: canonical change 커밋**

```bash
git add src/markets/market-adapter.ts src/markets/__tests__/market-adapter.test.ts \
  src/kis/rest-coordinator.ts src/kis/__tests__/rest-coordinator.http-cache.test.ts \
  src/kis/__tests__/rest-coordinator.scheduler.test.ts src/renderer/stock-card.ts \
  src/actions/__tests__/stock-action-controller.policy.test.ts \
  src/renderer/__tests__/stock-card.stock-action-view.test.ts
git commit -m "feat: carry native quote change amount"
```

`npm run typecheck`가 위 목록 밖의 `QuoteSample` fixture 누락을 보고하면 해당 정확한 test path를 같은 커밋의 `git add` 목록에 추가한다.

### Task 2: change-only 시세를 새 렌더 요청으로 구분

**Files:**
- Modify: `src/actions/__tests__/stock-action-controller.policy.test.ts`
- Modify: `src/actions/stock-action-controller.ts`

- [ ] **Step 1: change-only semantic key 실패 테스트 작성**

controller policy fixture가 동일 price/rate/sign에서 change만 다르게 보낼 수 있게 한다. `quote()`에 `change` 인자를 추가하고, `FakeSubscriptions.data(price, change = 1_000)`가 `[String(price), String(change)]`을 전달하며, fake adapter가 `fields[1]`을 canonical quote에 사용하게 한다. 두 WS tick 뒤 일반 렌더 요청의 semantic key가 다른지 검증한다.

```ts
test.subscriptions.data(70_000, 1_000);
test.subscriptions.data(70_000, 1_100);

const normal = test.scheduler.requests.filter(({ category }) => category === "normal");
expect(normal.at(-2)?.semanticKey).not.toBe(normal.at(-1)?.semanticKey);
```

기존 `receivedAt`만 바뀌는 동일 가시 시세 테스트는 같은 semantic key인지 계속 검증한다.

- [ ] **Step 2: controller test RED 확인**

Run: `npx vitest run src/actions/__tests__/stock-action-controller.policy.test.ts -t "등락폭|receivedAt"`

Expected: FAIL — 현재 semantic key에 `change`가 없다.

- [ ] **Step 3: semantic key 최소 구현**

`semanticKey(view)` 배열에서 `price` 바로 뒤에 다음을 추가한다.

```ts
view.quote?.change ?? null,
```

- [ ] **Step 4: controller test GREEN 확인**

Run: `npx vitest run src/actions/__tests__/stock-action-controller.policy.test.ts -t "등락폭|receivedAt"`

Expected: PASS

- [ ] **Step 5: controller 전체 회귀 확인**

Run: `npx vitest run src/actions/__tests__/stock-action-controller.policy.test.ts`

Expected: PASS

Run: `npm run typecheck`

Expected: exit 0

- [ ] **Step 6: semantic key 커밋**

```bash
git add src/actions/stock-action-controller.ts \
  src/actions/__tests__/stock-action-controller.policy.test.ts
git commit -m "feat: render change-only quote updates"
```

### Task 3: 등락폭·등락률 2열 카드

**Files:**
- Modify: `src/renderer/__tests__/stock-card.stock-action-view.test.ts`
- Modify: `src/renderer/__tests__/stock-card.rendering.test.ts`
- Modify: `src/renderer/stock-card.ts`

- [ ] **Step 1: 국내·해외·보합 SVG 실패 테스트 작성**

`src/renderer/__tests__/stock-card.stock-action-view.test.ts`는 happy-dom으로 data-role별 text를 검증한다.

```ts
expect(document.querySelector('[data-role="quote-change"]')?.textContent)
  .toBe("▲ +1,200");
expect(document.querySelector('[data-role="quote-rate"]')?.textContent)
  .toBe("+1.25%");
```

해외 하락은 `▼ -$1.25`/`-0.68%`, 국내 보합은 `0`/`0.00%`, 해외 보합은 `$0.00`/`0.00%`를 검증한다. 두 node의 `y="116"`, 왼쪽 `x="12"`, 오른쪽 `x="132"`, 각 anchor도 검증한다. 등락률에 `▲`/`▼`가 중복되지 않아야 한다.

`src/renderer/__tests__/stock-card.rendering.test.ts`에는 레거시 `renderStockCard()` exact regression assertion을 추가한다. 국내 상승은 `▲ 1,200`, 해외 하락은 `▼ 0.50`, 등락률은 `0.68%`를 유지하며 새 canonical formatter의 `+`/`-`/`$`가 레거시 변동량 문자열에 유입되지 않아야 한다.

- [ ] **Step 2: 긴 값과 안전 경계 실패 테스트 작성**

표시 길이별로 다음 exact contract를 검증한다.

- 7자 이하: font-size 14, `textLength` 없음
- 8~9자: font-size 14, `textLength="58"`, `lengthAdjust="spacingAndGlyphs"`
- 10~12자: font-size 12와 같은 강제 폭 속성
- 13~16자: font-size 10과 같은 강제 폭 속성
- 17자 이상: font-size 8과 같은 강제 폭 속성

대표 국내 상승 `▲ +1,200`도 8자이므로 폭 58을 강제해 왼쪽 `x=12..70`, 오른쪽 `x=74..132` 사이의 중앙 4px 여백을 보장한다.

invalid table에 다음을 추가한다.

```ts
{ change: Number.NaN },
{ change: Number.POSITIVE_INFINITY },
{ change: 1_000_000_000_000_001 },
{ change: -1, changeRate: 1.25, sign: "rise" },
{ change: 1, changeRate: 1.25, sign: "fall" },
{ change: 1, changeRate: -1.25, sign: "rise" },
{ change: -1, changeRate: 1.25, sign: "fall" },
{ change: 1, changeRate: 0, sign: "flat" },
```

`change` property를 생략한 quote와 `change`를 enumerable accessor로 만든 quote도 추가한다. accessor 호출 횟수는 0이어야 한다. 모두 안전한 `표시 오류`이며 원문 `NaN`/`Infinity`를 출력하지 않아야 한다.

- [ ] **Step 3: renderer test RED 확인**

Run: `npx vitest run src/renderer/__tests__/stock-card.stock-action-view.test.ts`

Expected: FAIL — `quote-change`/`quote-rate` 2열과 sign consistency 검증이 없다.

- [ ] **Step 4: signed formatter와 font-size helper 구현**

레거시 `formatChangeWithArrow()`와 `formatChangeRate()`는 그대로 두고 canonical 경로 전용 helper를 만든다.

```ts
function formatActionChange(change: number, sign: QuoteSample["sign"], market: Market): string {
  if (sign === "flat") return market === "domestic" ? "0" : "$0.00";
  const arrow = sign === "rise" ? ARROW_UP : ARROW_DOWN;
  const prefix = sign === "rise" ? "+" : "-";
  const amount = market === "domestic"
    ? KR_INT_FORMAT.format(Math.abs(change))
    : `$${Math.abs(change).toFixed(2)}`;
  return `${arrow} ${prefix}${amount}`;
}

function formatActionRate(rate: number, sign: QuoteSample["sign"]): string {
  if (sign === "flat") return "0.00%";
  return `${sign === "rise" ? "+" : "-"}${Math.abs(rate).toFixed(2)}%`;
}

function getMetricFontSize(text: string): number {
  if (text.length <= 9) return 14;
  if (text.length <= 12) return 12;
  if (text.length <= 16) return 10;
  return 8;
}
```

8자 이상인 metric에 `textLength="58" lengthAdjust="spacingAndGlyphs"` 속성을 추가하고 7자 이하는 빈 속성을 반환하는 작은 helper를 사용한다. `getMetricFontSize()`의 14px 구간 안에서도 8~9자는 강제 폭을 사용하고 7자 이하는 사용하지 않는다는 점을 별도로 테스트한다.

- [ ] **Step 5: renderer sign consistency와 2열 SVG 구현**

safe snapshot에서 `change`와 `changeRate`가 sign과 일치하는지 검사한다.

```ts
function matchesSign(value: number, sign: QuoteSample["sign"]): boolean {
  if (sign === "rise") return value >= 0;
  if (sign === "fall") return value <= 0;
  return value === 0;
}
```

`renderStockActionQuote()`의 기존 중앙 rate node를 다음 두 node로 교체한다.

```xml
<text data-role="quote-change" x="12" y="116" text-anchor="start">...</text>
<text data-role="quote-rate" x="132" y="116" text-anchor="end">...</text>
```

두 node는 같은 `changeColor`와 각 문자열에 맞는 font-size를 사용한다.

- [ ] **Step 6: renderer GREEN과 전체 회귀 확인**

Run: `npx vitest run src/renderer/__tests__/stock-card.stock-action-view.test.ts src/renderer/__tests__/stock-card.rendering.test.ts`

Expected: PASS — canonical 2열 출력과 레거시 renderer 회귀가 모두 통과.

Run: `npm run typecheck`

Expected: exit 0

Run: `npm test`

Expected: 모든 test file과 test 통과.

- [ ] **Step 7: 렌더 커밋**

```bash
git add src/renderer/stock-card.ts \
  src/renderer/__tests__/stock-card.stock-action-view.test.ts \
  src/renderer/__tests__/stock-card.rendering.test.ts
git commit -m "feat: show quote change amount and rate"
```

### Task 4: 문서 조정, 독립 리뷰, v2.2.0 통합 검증

**Files:**
- Modify: `README.md`
- Review: 모든 feature branch 변경

- [ ] **Step 1: README 카드 설명 갱신**

`README.md`의 “큰 현재가와 등락률”을 “큰 현재가와 등락폭·등락률”로 바꾸고 국내·미국 모두 API-native 등락폭을 표시한다고 적는다.

이 통합 브랜치에서는 Property Inspector 정보 구조 계획의 Task 6이 README/AGENTS의 PI 설명을 먼저 소유하고 커밋한다. 그 뒤 이 Task는 해당 내용을 보존하고 README의 시세 카드 문구만 최소 수정한다. Stock change 기능을 이유로 AGENTS를 다시 stage하거나 PI 문서 커밋을 중복 만들지 않는다.

- [ ] **Step 2: 구형·중복 문구 검색**

Run: `rg -n "큰 현재가와 등락률|등락률만|등락폭.*역산" README.md AGENTS.md docs/superpowers`

Expected: 현재 동작과 충돌하는 문구 0건. 설계에서 역산을 비목표로 설명하는 문구는 허용.

- [ ] **Step 3: 문서 커밋**

```bash
git add README.md
git commit -m "docs: describe quote change amount"
```

- [ ] **Step 4: 변경 범위와 레거시 계약 검사**

Run: `git diff --check main...HEAD`

Expected: 출력 없음

Run: `git diff --name-only main...HEAD`

Expected: 승인된 PI B안 파일, 이 설계·계획, canonical quote/REST/controller/renderer/test/README/AGENTS 파일만 포함.

Run: `git status --short`

Expected: 출력 없음 — 설계·계획을 포함한 모든 승인 파일이 추적·커밋됐고 untracked 작업 파일이 없음.

Run: `npx vitest run src/renderer/__tests__/stock-card.rendering.test.ts`

Expected: PASS — 레거시 `renderStockCard` 등락폭·등락률 계약 유지.

- [ ] **Step 5: 독립 코드 리뷰**

`superpowers:requesting-code-review`로 다음을 중점 검토한다.

- 등락폭이 price/rate에서 역산되지 않는가
- 국내·해외 WS/REST 네 경로가 API-native 필드를 읽는가
- sign code가 change/rate 부호의 단일 출처인가
- REST와 renderer 경계가 hostile/malformed 값을 거부하는가
- change-only update가 semantic dedupe에 사라지지 않는가
- 144×144 카드의 두 metric이 겹치지 않고 레거시 renderer가 유지되는가

유효한 이슈는 `superpowers:systematic-debugging`과 TDD로 수정하고 targeted/전체 검증을 반복한다.

- [ ] **Step 6: 최종 검증**

Run: `npm run typecheck`

Expected: exit 0

Run: `npm test`

Expected: 모든 test file과 test 통과

Run: `npm run test:coverage`

Expected: coverage gate 통과

Run: `npm run build`

Expected: `bin/plugin.js` 생성 및 검증 통과

Run: `npm run package:plugin`

Expected: 현재 package version의 `.streamDeckPlugin` archive 생성

Run: `npm run package:smoke`

Expected: 실제 archive smoke 검증 통과

- [ ] **Step 7: PI B안과 함께 v2.2.0 릴리스**

Property Inspector 구현 계획의 main 병합·v2.2.0 release Task와 한 번만 수행한다. 기존 `npm run release:minor`로 package.json, package-lock.json, manifest.json을 2.2.0으로 동기화하고 `v2.2.0` 태그를 push한다. GitHub Actions 완료 후 GitHub Release가 non-draft/non-prerelease이며 `com.kis.streamdeck-v2.2.0.streamDeckPlugin` asset을 포함하는지 확인한다.
