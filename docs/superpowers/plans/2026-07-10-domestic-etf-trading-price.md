# Domestic ETF Trading Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `0210A0` 같은 6자리 영숫자 국내 ETF/ETN 코드를 입력하고, ETF 전용 REST 스냅샷과 기존 통합 웹소켓을 조합해 실제 거래가격을 표시한다.

**Architecture:** 상품 유형과 종목코드 정규화를 작은 도메인 헬퍼에 모으고, REST 계층에서만 일반 주식과 ETF/ETN 엔드포인트를 분기한다. 국내 액션은 정규화된 코드를 모든 REST 갱신 경로와 기존 `H0UNCNT0` 구독에 전달하며, 웹소켓 매처는 영문 코드도 대소문자에 안전하게 매칭한다.

**Tech Stack:** TypeScript 5.7, Vitest 3, Rollup, Stream Deck Property Inspector HTML/JavaScript, KIS REST/WebSocket API

---

## 파일 구조

- Create: `src/kis/domestic-instrument.ts` — 국내 상품 유형 기본값과 종목코드 정규화만 담당한다.
- Create: `src/kis/__tests__/domestic-instrument.test.ts` — 정규화와 하위 호환 기본값을 검증한다.
- Create: `src/kis/__tests__/rest-price.domestic-instrument.test.ts` — 주식/ETF REST URL, TR ID, 종목코드 전달을 검증한다.
- Create: `src/actions/__tests__/domestic-stock.etf-routing.test.ts` — 액션의 초기, 재시도, 폴링, 수동 갱신과 웹소켓 구독을 검증한다.
- Create: `src/__tests__/domestic-stock-pi.test.ts` — 모듈화되지 않은 PI 설정의 상품 유형과 영숫자 검증 규칙을 정적 회귀 테스트한다.
- Modify: `src/types/index.ts` — 국내 상품 유형, 선택적 설정, ETF REST TR ID를 정의한다.
- Modify: `src/kis/rest-price.ts` — 상품 유형별 REST 엔드포인트와 TR ID를 선택하고 코드를 정규화한다.
- Modify: `src/actions/domestic-stock.ts` — 설정을 한 번 정규화하고 모든 REST 갱신 경로에 상품 유형을 전달한다.
- Modify: `src/kis/websocket-manager.ts` — 국내 수신 코드를 대문자로 정규화해 영문 구독 키와 매칭한다.
- Modify: `src/kis/__tests__/websocket-manager.handleMessage.test.ts` — 영숫자 ETF 코드 매칭 회귀 테스트를 추가한다.
- Modify: `ui/domestic-stock-pi.html` — 상품 유형 선택과 6자리 영숫자 입력을 지원한다.

## Task 1: 국내 상품 유형과 종목코드 정규화

**Files:**
- Create: `src/kis/domestic-instrument.ts`
- Create: `src/kis/__tests__/domestic-instrument.test.ts`
- Modify: `src/types/index.ts:28-33,120-123`

@superpowers:test-driven-development

- [ ] **Step 1: 정규화와 기본 상품 유형의 실패 테스트 작성**

```ts
import { describe, expect, it } from "vitest";
import {
  normalizeDomesticStockCode,
  resolveDomesticInstrumentType,
} from "../domestic-instrument.js";

describe("domestic instrument settings", () => {
  it("normalizes a six-character alphanumeric code", () => {
    expect(normalizeDomesticStockCode(" 0210a0 ")).toBe("0210A0");
  });

  it("defaults missing or unknown instrument types to stock", () => {
    expect(resolveDomesticInstrumentType(undefined)).toBe("stock");
    expect(resolveDomesticInstrumentType("unknown")).toBe("stock");
    expect(resolveDomesticInstrumentType("etf")).toBe("etf");
  });
});
```

- [ ] **Step 2: 테스트가 올바르게 실패하는지 확인**

Run: `npx vitest run src/kis/__tests__/domestic-instrument.test.ts`

Expected: FAIL — `../domestic-instrument.js` 모듈이 아직 존재하지 않는다.

- [ ] **Step 3: 타입과 최소 정규화 헬퍼 구현**

`src/types/index.ts`:

```ts
export type DomesticInstrumentType = "stock" | "etf";

export type DomesticStockSettings = {
  stockCode: string;
  stockName: string;
  instrumentType?: DomesticInstrumentType;
  [key: string]: string | undefined;
};

export const REST_TR_DOMESTIC_PRICE = "FHKST01010100";
export const REST_TR_DOMESTIC_ETF_PRICE = "FHPST02400000";
```

`src/kis/domestic-instrument.ts`:

```ts
import type { DomesticInstrumentType } from "../types/index.js";

export function normalizeDomesticStockCode(value?: string): string {
  return value?.trim().toUpperCase() ?? "";
}

export function resolveDomesticInstrumentType(
  value?: string,
): DomesticInstrumentType {
  return value === "etf" ? "etf" : "stock";
}
```

- [ ] **Step 4: 단위 테스트 통과 확인**

Run: `npx vitest run src/kis/__tests__/domestic-instrument.test.ts`

Expected: PASS — 2 tests.

- [ ] **Step 5: 타입 검사 역할의 빌드 확인**

Run: `npm run build`

Expected: Rollup exit 0, `bin/plugin.js` 생성.

- [ ] **Step 6: 변경 커밋**

```bash
git add src/types/index.ts src/kis/domestic-instrument.ts src/kis/__tests__/domestic-instrument.test.ts
git commit -m "feat: add domestic instrument normalization"
```

## Task 2: 상품 유형별 국내 REST 현재가 분기

**Files:**
- Create: `src/kis/__tests__/rest-price.domestic-instrument.test.ts`
- Modify: `src/kis/rest-price.ts:1-170`

@superpowers:test-driven-development

- [ ] **Step 1: 주식 기본 분기와 ETF 분기의 실패 테스트 작성**

테스트는 `getAccessToken`을 고정 토큰으로 mock하고 `fetchDomesticPriceForSettings`를 직접 호출한다.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REST_TR_DOMESTIC_ETF_PRICE,
  REST_TR_DOMESTIC_PRICE,
  type GlobalSettings,
} from "../../types/index.js";

vi.mock("../auth.js", () => ({
  getAccessToken: vi.fn().mockResolvedValue("access-token"),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const credentials: GlobalSettings = {
  appKey: "app-key",
  appSecret: "app-secret",
};

function okPriceResponse(): Response {
  return new Response(JSON.stringify({
    output: {
      stck_prpr: "12345",
      prdy_vrss: "100",
      prdy_vrss_sign: "2",
      prdy_ctrt: "0.82",
    },
  }), { status: 200 });
}

describe("fetchDomesticPriceForSettings instrument routing", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okPriceResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses the stock API when instrument type is omitted", async () => {
    const { fetchDomesticPriceForSettings } = await import("../rest-price.js");

    await fetchDomesticPriceForSettings(credentials, "005930", "삼성전자");

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(
      "/uapi/domestic-stock/v1/quotations/inquire-price",
    );
    expect((init.headers as Record<string, string>).tr_id).toBe(
      REST_TR_DOMESTIC_PRICE,
    );
  });

  it("uses the ETF API and normalizes an alphanumeric code", async () => {
    const { fetchDomesticPriceForSettings } = await import("../rest-price.js");

    const result = await fetchDomesticPriceForSettings(
      credentials,
      " 0210a0 ",
      "ETF",
      "etf",
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/uapi/etfetn/v1/quotations/inquire-price");
    expect(parsedUrl.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe("UN");
    expect(parsedUrl.searchParams.get("FID_INPUT_ISCD")).toBe("0210A0");
    expect((init.headers as Record<string, string>).tr_id).toBe(
      REST_TR_DOMESTIC_ETF_PRICE,
    );
    expect(result?.ticker).toBe("0210A0");
  });
});
```

- [ ] **Step 2: 테스트가 시그니처와 ETF 분기 부재로 실패하는지 확인**

Run: `npx vitest run src/kis/__tests__/rest-price.domestic-instrument.test.ts`

Expected: FAIL — ETF 호출이 일반 주식 URL/TR ID를 사용하거나 네 번째 인자를 받지 못한다.

- [ ] **Step 3: REST 함수에 상품 유형 인자와 공통 분기 구현**

다음 import를 추가한다.

```ts
import { normalizeDomesticStockCode } from "./domestic-instrument.js";
import type { DomesticInstrumentType } from "../types/index.js";
```

두 공개 함수에 기본 인자를 추가한다.

```ts
export async function fetchDomesticPrice(
  stockCode: string,
  displayName: string,
  instrumentType: DomesticInstrumentType = "stock",
): Promise<StockData | null> {
  const settings = await getSettingsWithWait();
  if (!settings) return null;
  return fetchDomesticPriceForSettings(
    settings,
    stockCode,
    displayName,
    instrumentType,
  );
}
```

```ts
export async function fetchDomesticPriceForSettings(
  settings: GlobalSettings,
  stockCode: string,
  displayName: string,
  instrumentType: DomesticInstrumentType = "stock",
): Promise<StockData | null> {
```

요청 생성 직전에 코드와 API 정보를 결정한다.

```ts
const normalizedStockCode = normalizeDomesticStockCode(stockCode);
const isEtf = instrumentType === "etf";
const apiPath = isEtf
  ? "/uapi/etfetn/v1/quotations/inquire-price"
  : "/uapi/domestic-stock/v1/quotations/inquire-price";
const trId = isEtf
  ? REST_TR_DOMESTIC_ETF_PRICE
  : REST_TR_DOMESTIC_PRICE;

const url = new URL(`${KIS_REST_BASE}${apiPath}`);
url.searchParams.set("FID_COND_MRKT_DIV_CODE", "UN");
url.searchParams.set("FID_INPUT_ISCD", normalizedStockCode);
```

헤더의 `tr_id`를 `trId`로 바꾸고 반환 `ticker`도 `normalizedStockCode`로 바꾼다. 응답 필드 파싱과 기존 `ErrorType` 처리는 공유한다.

- [ ] **Step 4: REST 분기 테스트 통과 확인**

Run: `npx vitest run src/kis/__tests__/rest-price.domestic-instrument.test.ts`

Expected: PASS — 2 tests.

- [ ] **Step 5: 기존 전체 KIS 테스트 회귀 확인**

Run: `npx vitest run src/kis/__tests__`

Expected: PASS, failures 0.

- [ ] **Step 6: 변경 커밋**

```bash
git add src/types/index.ts src/kis/rest-price.ts src/kis/__tests__/rest-price.domestic-instrument.test.ts
git commit -m "feat: route ETF snapshots to KIS ETF API"
```

## Task 3: Property Inspector 영숫자 ETF 설정

**Files:**
- Create: `src/__tests__/domestic-stock-pi.test.ts`
- Modify: `ui/domestic-stock-pi.html:14-40`

@superpowers:test-driven-development

- [ ] **Step 1: PI 설정의 실패 회귀 테스트 작성**

PI가 인라인 스크립트라 DOM 실행 테스트 대신 사용자 동작을 결정하는 설정 조각을 정적 검증한다.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(
  new URL("../../ui/domestic-stock-pi.html", import.meta.url),
  "utf8",
);

describe("domestic stock property inspector", () => {
  it("offers stock and ETF instrument types", () => {
    expect(html).toContain('id: "instrumentType"');
    expect(html).toContain('{ value: "stock", label: "주식" }');
    expect(html).toContain('{ value: "etf", label: "ETF/ETN" }');
  });

  it("accepts and uppercases six-character alphanumeric codes", () => {
    expect(html).toContain('return /^[0-9A-Z]{6}$/i.test(value);');
    expect(html).toContain('return value.trim().toUpperCase();');
    expect(html).toContain("0210A0");
  });
});
```

- [ ] **Step 2: 테스트가 현재 숫자 전용 PI 때문에 실패하는지 확인**

Run: `npx vitest run src/__tests__/domestic-stock-pi.test.ts`

Expected: FAIL — `instrumentType`, ETF 옵션, 영숫자 정규식이 없다.

- [ ] **Step 3: 상품 유형 select와 영숫자 코드 규칙 구현**

`fields`의 첫 항목으로 다음 설정을 추가한다.

```js
{
  id: "instrumentType",
  type: "select",
  label: "상품 유형",
  defaultValue: "stock",
  options: [
    { value: "stock", label: "주식" },
    { value: "etf", label: "ETF/ETN" }
  ]
},
```

종목코드 설정은 다음 동작으로 바꾼다.

```js
placeholder: "005930 또는 0210A0",
help: "6자리 영숫자 종목코드를 입력하세요 (예: 삼성전자 005930, ETF 0210A0)",
errorMessage: "6자리 영숫자를 입력하세요 (예: 005930, 0210A0)",
invalidStatusMessage: "종목코드는 6자리 영숫자여야 합니다.",
validate: function (value) {
  return /^[0-9A-Z]{6}$/i.test(value);
},
serialize: function (value) {
  return value.trim().toUpperCase();
}
```

- [ ] **Step 4: PI 회귀 테스트 통과 확인**

Run: `npx vitest run src/__tests__/domestic-stock-pi.test.ts`

Expected: PASS — 2 tests.

- [ ] **Step 5: 변경 커밋**

```bash
git add ui/domestic-stock-pi.html src/__tests__/domestic-stock-pi.test.ts
git commit -m "feat: accept alphanumeric ETF codes in property inspector"
```

## Task 4: 국내 액션의 ETF 경로 전달

**Files:**
- Create: `src/actions/__tests__/domestic-stock.etf-routing.test.ts`
- Modify: `src/actions/domestic-stock.ts:98-151,240-307,377-493,579-595`

@superpowers:test-driven-development

- [ ] **Step 1: ETF 초기 조회와 실시간 구독의 실패 테스트 작성**

기존 액션 테스트와 동일하게 Stream Deck, 렌더러, 설정 저장소를 mock한다. `fetchDomesticPrice`와 `kisWebSocket.subscribe`는 최상위 mock 함수로 선언한다.

```ts
it("normalizes an ETF code, routes its snapshot, and keeps unified live trades", async () => {
  const action = new DomesticStockAction();
  const setImage = vi.fn().mockResolvedValue(undefined);

  await action.onWillAppear({
    action: { id: "etf-1", setImage },
    payload: {
      settings: {
        stockCode: " 0210a0 ",
        stockName: "테스트 ETF",
        instrumentType: "etf",
      },
    },
  } as never);

  expect(fetchDomesticPrice).toHaveBeenCalledWith(
    "0210A0",
    "테스트 ETF",
    "etf",
  );
  expect(subscribe).toHaveBeenCalledWith(
    TR_ID_DOMESTIC,
    "0210A0",
    expect.any(Function),
    expect.any(Function),
    expect.any(Function),
  );
});
```

- [ ] **Step 2: 누락 상품 유형의 하위 호환과 수동 새로고침 실패 테스트 작성**

```ts
it("defaults legacy settings to stock on manual refresh", async () => {
  const action = new DomesticStockAction();

  await action.onKeyDown({
    action: { id: "stock-1", setImage: vi.fn() },
    payload: { settings: { stockCode: "005930", stockName: "삼성전자" } },
  } as never);

  expect(fetchDomesticPrice).toHaveBeenCalledWith(
    "005930",
    "삼성전자",
    "stock",
  );
});
```

- [ ] **Step 3: ETF 재시도와 폴링 전달의 실패 테스트 작성**

재시도 테스트는 첫 조회가 `null`을 반환하게 한 뒤 fake timer를 4초 진행해 두 번째 호출도 `"etf"`인지 확인한다. 폴링 테스트는 글로벌 설정을 `updateMode: "poll", pollIntervalSec: "30"`으로 바꾸고 30초 진행해 두 번째 호출이 `"etf"`인지 확인한다.

```ts
expect(fetchDomesticPrice).toHaveBeenNthCalledWith(
  2,
  "0210A0",
  "테스트 ETF",
  "etf",
);
```

- [ ] **Step 4: 테스트가 코드 정규화와 상품 유형 전달 부재로 실패하는지 확인**

Run: `npx vitest run src/actions/__tests__/domestic-stock.etf-routing.test.ts`

Expected: FAIL — REST mock이 세 번째 인자를 받지 않고 웹소켓 구독 키가 소문자다.

- [ ] **Step 5: 액션 설정 해석을 한 함수로 모으기**

```ts
import {
  normalizeDomesticStockCode,
  resolveDomesticInstrumentType,
} from "../kis/domestic-instrument.js";
import type { DomesticInstrumentType } from "../types/index.js";

function resolveDomesticActionSettings(settings: DomesticStockSettings): {
  stockCode: string;
  stockName: string;
  instrumentType: DomesticInstrumentType;
} {
  const stockCode = normalizeDomesticStockCode(settings.stockCode);
  return {
    stockCode,
    stockName: settings.stockName?.trim() || stockCode,
    instrumentType: resolveDomesticInstrumentType(settings.instrumentType),
  };
}
```

`onWillAppear`, `onDidReceiveSettings`, `onKeyDown`은 직접 `trim()`하지 않고 이 함수를 사용한다.

- [ ] **Step 6: 모든 REST 갱신 경로에 상품 유형 전달**

`fetchAndShowPrice`, `scheduleInitialPriceRetry`, `startPolling`에 `instrumentType: DomesticInstrumentType` 인자를 추가한다. 각 함수 내부와 모든 호출부에서 다음 형태를 유지한다.

```ts
await this.fetchAndShowPrice(
  ev,
  stockCode,
  stockName,
  instrumentType,
  force,
);
```

```ts
const data = await fetchDomesticPrice(
  stockCode,
  stockName,
  instrumentType,
);
```

초기 조회 실패 재시도와 폴링 타이머 클로저도 같은 `instrumentType` 값을 캡처한다. 웹소켓은 TR ID를 바꾸지 않고 `TR_ID_DOMESTIC`과 정규화된 `stockCode`를 계속 사용한다.

- [ ] **Step 7: 액션 경로 테스트 통과 확인**

Run: `npx vitest run src/actions/__tests__/domestic-stock.etf-routing.test.ts`

Expected: PASS — 초기, 기존 설정, 수동, 재시도, 폴링 경로의 failures 0.

- [ ] **Step 8: 기존 액션 테스트 회귀 확인**

Run: `npx vitest run src/actions/__tests__`

Expected: PASS, failures 0.

- [ ] **Step 9: 변경 커밋**

```bash
git add src/actions/domestic-stock.ts src/actions/__tests__/domestic-stock.etf-routing.test.ts
git commit -m "feat: propagate ETF settings through domestic action"
```

## Task 5: 영숫자 코드 실시간 매칭

**Files:**
- Modify: `src/kis/websocket-manager.ts:427-437`
- Modify: `src/kis/__tests__/websocket-manager.handleMessage.test.ts:56-65`

@superpowers:test-driven-development

- [ ] **Step 1: 영문 코드의 대소문자 안전 매칭 실패 테스트 작성**

```ts
it("dispatches alphanumeric ETF trades case-insensitively", async () => {
  const onData = vi.fn();

  await manager.subscribe("H0UNCNT0", "0210A0", onData);
  manager.handleMessage("0|H0UNCNT0|1|0210a0^10120^unused");

  expect(onData).toHaveBeenCalledWith(
    "H0UNCNT0",
    "0210A0",
    ["0210a0", "10120", "unused"],
  );
});
```

- [ ] **Step 2: 테스트가 현재 대소문자 민감 매칭 때문에 실패하는지 확인**

Run: `npx vitest run src/kis/__tests__/websocket-manager.handleMessage.test.ts`

Expected: FAIL — `onData`가 호출되지 않는다.

- [ ] **Step 3: 국내 수신 코드 매칭 정규화 구현**

```ts
case TR_ID_DOMESTIC: {
  const stockCode = fields[0]?.trim().toUpperCase();
  if (!stockCode) return [];
  const sub = this.subscriptions.get(this.makeKey(trId, stockCode));
  if (sub) matches.set(this.makeKey(sub.trId, sub.trKey), sub);
  return [...matches.values()];
}
```

- [ ] **Step 4: 웹소켓 테스트 통과 확인**

Run: `npx vitest run src/kis/__tests__/websocket-manager.handleMessage.test.ts`

Expected: PASS — 기존 숫자 코드와 ETF 영숫자 코드 2 tests.

- [ ] **Step 5: 변경 커밋**

```bash
git add src/kis/websocket-manager.ts src/kis/__tests__/websocket-manager.handleMessage.test.ts
git commit -m "fix: match alphanumeric domestic trade codes"
```

## Task 6: 전체 검증과 요구사항 대조

**Files:**
- Verify only; 기능 변경 없음

@superpowers:verification-before-completion

- [ ] **Step 1: 포맷 오류와 작업 범위 확인**

Run: `git diff --check`

Expected: 출력 없음, exit 0.

- [ ] **Step 2: 전체 단위 테스트 실행**

Run: `npm test`

Expected: 모든 Vitest 파일과 테스트 통과, failures 0.

- [ ] **Step 3: 프로덕션 빌드 실행**

Run: `npm run build`

Expected: Rollup exit 0, TypeScript 오류 없음.

- [ ] **Step 4: 완료 조건을 코드와 테스트에 대조**

- PI에서 `0210A0` 저장 가능.
- ETF REST가 `/uapi/etfetn/v1/quotations/inquire-price`, `FHPST02400000`, `UN` 사용.
- 실시간 체결은 기존 `H0UNCNT0` 유지.
- 기존 설정의 누락 `instrumentType`은 `stock`으로 처리.
- 실제 거래가격 카드 렌더링은 기존 `StockData`와 렌더러 유지.

- [ ] **Step 5: 최종 상태 확인**

Run: `git status --short && git log --oneline -6`

Expected: 의도한 파일만 변경 또는 커밋되어 있고, 최근 커밋이 Task 1~5 변경을 설명한다.
