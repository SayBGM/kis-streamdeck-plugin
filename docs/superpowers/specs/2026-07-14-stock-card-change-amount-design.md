# 시세 카드 등락폭·등락률 동시 표시 설계

## 목적

국내·미국 주식의 현재 `StockActionView` 시세 카드에 등락률뿐 아니라 API가 제공한 전일 대비 등락폭을 함께 표시한다. 144×144 카드의 현재가 가독성은 유지하면서 사용자가 가격 변화의 비율과 실제 금액을 한눈에 비교할 수 있어야 한다.

이 기능은 사용자가 승인한 Property Inspector B안과 함께 v2.2.0에 포함한다. PI 정보 구조나 설정 프로토콜은 변경하지 않는다.

## 현재 문제

1. KIS 응답은 국내·해외 모두 전일 대비 등락폭을 제공하지만 canonical `Quote`가 `changeRate`만 보존해 새 액션 경로에서 등락폭이 소실된다.
2. `renderStockActionView`는 카드 하단 중앙에 화살표와 등락률만 표시한다.
3. 레거시 `StockData`와 `renderStockCard`는 이미 등락폭과 등락률을 2열로 표시하지만, canonical 액션 경로와 별도 계약이라 새 경로의 데이터 누락을 해결하지 못한다.
4. 현재 controller의 semantic key에 등락폭이 없으므로 가격·등락률이 같고 등락폭만 달라진 데이터는 렌더 중복 제거에서 누락될 수 있다.

## 검토한 접근

### A. 현재가와 등락률로 등락폭 역산

`price`와 `changeRate`를 이용해 등락폭을 계산하면 타입과 parser 변경이 작다. 그러나 KIS가 제공한 소수점·호가 단위·반올림 정책을 재현할 수 없어 실제 응답의 등락폭과 달라질 수 있다. 채택하지 않는다.

### B. API 원문 등락폭을 canonical Quote로 전달 — 선택

국내·해외 WS와 REST 응답의 등락폭 필드를 직접 파싱하고 `Quote.change`로 전달한다. parser, REST 안전 경계, controller semantic key, renderer 안전 경계가 같은 값을 공유하므로 정확성과 추적 가능성이 높다.

### C. 렌더 시 원문 payload를 별도 참조

렌더러가 시장별 원문 payload를 직접 읽으면 canonical 모델을 우회하고 WS/REST·국내/해외 분기가 UI에 누출된다. 격리성과 테스트 가능성이 낮아 채택하지 않는다.

## Canonical Quote 계약

`src/markets/market-adapter.ts`의 `Quote`에 필수 필드를 추가한다.

```ts
export interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly change: number;
  readonly changeRate: number;
  readonly sign: PriceSign;
  readonly source: QuoteSource;
  readonly receivedAt: number;
  readonly sessionEpoch: number;
}
```

`change`는 전일 종가 대비 가격 차이를 나타내는 canonical signed number다. 금액 단위는 시장 원문과 동일하다.

- 국내: 원 단위 숫자
- 해외: 해당 종목의 통화 단위 숫자. 현재 플러그인의 해외 표시는 달러 기호를 사용한다.
- 상승: `+abs(rawChange)`
- 하락: `-abs(rawChange)`
- 보합: `0`

부호는 KIS sign code를 단일 출처로 삼는다. 원문 등락폭과 등락률에 이미 `-`가 포함됐는지와 무관하게 `sign`을 기준으로 `change`와 `changeRate`를 함께 정규화한다. 가격과 등락률로 등락폭을 역산하거나, 원문 숫자 문자열의 부호만 신뢰하지 않는다.

## 시장별 데이터 수집

`MarketAdapter`는 기존 strict decimal parser와 protocol error 정책을 유지하며 다음 원문 필드를 읽는다.

| 시장·전송 | 가격 | 부호 | 등락폭 | 등락률 |
| --- | --- | --- | --- | --- |
| 국내 WS | `fields[2]` | `fields[3]` | `fields[4]` | `fields[5]` |
| 국내 REST | `stck_prpr` | `prdy_vrss_sign` | `prdy_vrss` | `prdy_ctrt` |
| 해외 WS | `fields[11]` | `fields[12]` | `fields[13]` | `fields[14]` |
| 해외 REST | `last` | `sign` | `diff` | `rate` |

등락폭 필드는 숫자 문자열만 허용한다. 누락, `NaN`, `Infinity`, 지수 표기, hexadecimal, 숫자 뒤 임의 문자가 포함된 응답은 기존 안전한 `PROTOCOL` 오류로 정규화한다.

## 안전 경계와 불변성

### REST coordinator

`validateQuoteSample()`의 exact enumerable data-key 계약에 `change`를 추가한다. 값은 유한한 number여야 한다. adapter가 반환한 객체에 필드가 누락되거나 accessor·proxy·추가 키가 있으면 기존처럼 안전한 protocol error로 거부한다. 반환되는 frozen quote에도 `change`를 포함한다.

### Renderer boundary

`QUOTE_KEYS`와 `snapshotStockActionView()`에 `change`를 추가한다.

- `change`는 finite number여야 한다.
- 절댓값은 기존 `MAX_PRICE`와 같은 안전 상한 이하여야 한다.
- `rise`이면 `change >= 0`, `fall`이면 `change <= 0`, `flat`이면 `change === 0`이어야 한다.
- 등락률도 같은 sign 방향 계약을 적용해 화면의 화살표·부호와 숫자가 모순되지 않게 한다.
- 경계를 통과하지 못하면 원문 값을 노출하지 않고 기존 `표시 오류` 카드로 대체한다.

`snapshotStockActionView()`가 만드는 frozen quote에는 `change`가 포함되며 원본 객체의 accessor를 실행하지 않는 기존 보안 계약을 유지한다.

### Controller semantic key

`semanticKey(view)`의 가격 다음에 `view.quote?.change`를 포함한다. 가격·등락률·상태가 같더라도 등락폭만 바뀌면 새 일반 렌더 요청을 제출한다. `source`, `receivedAt`, `sessionEpoch` 같은 비가시 메타데이터는 계속 key에서 제외한다.

RenderScheduler의 LWW, interval, generation fence, 직렬 `setImage()` 정책 자체는 변경하지 않는다.

## 카드 레이아웃과 포맷

현재 `renderStockActionView`의 종목명, 종목코드, 세션 badge, 현재가 기준선은 유지한다. 하단 `y=116` 행만 두 열로 나눈다.

- 왼쪽: `x=12`, `text-anchor=start`, `data-role="quote-change"`
- 오른쪽: `x=132`, `text-anchor=end`, `data-role="quote-rate"`
- 두 값은 같은 sign color를 사용한다.
- 등락폭에만 방향 화살표를 표시한다. 등락률에는 화살표를 반복하지 않는다.

표시 예시는 다음과 같다.

| 시장·상태 | 왼쪽 등락폭 | 오른쪽 등락률 |
| --- | --- | --- |
| 국내 상승 | `▲ +1,200` | `+1.25%` |
| 국내 하락 | `▼ -800` | `-0.68%` |
| 해외 상승 | `▲ +$1.25` | `+0.72%` |
| 해외 하락 | `▼ -$0.50` | `-0.68%` |
| 국내 보합 | `0` | `0.00%` |
| 해외 보합 | `$0.00` | `0.00%` |

국내 등락폭은 정수 천 단위 구분, 해외 등락폭은 달러 기호와 소수 둘째 자리, 등락률은 소수 둘째 자리로 표시한다. 상승에는 `+`, 하락에는 `-`를 명시한다.

각 열은 최대 58px를 사용하고 가운데 4px 여백을 남긴다. 문자열 길이는 formatter가 만든 최종 표시 문자열의 JavaScript `length`로 계산해 다음 font-size를 적용한다.

- 7자 이하: 14px, 강제 폭 없음
- 8~9자: 14px, 강제 폭 적용
- 10~12자: 12px, 강제 폭 적용
- 13~16자: 10px, 강제 폭 적용
- 17자 이상: 8px, 강제 폭 적용

8자 이상인 유효 값에는 `textLength="58"`와 `lengthAdjust="spacingAndGlyphs"`를 적용한다. 대표 국내 상승 문자열 `▲ +1,200`부터 폭을 정확히 58px로 제한하므로 왼쪽 열은 `x=12..70`, 오른쪽 열은 `x=74..132` 안에 머물고 가운데 4px 여백이 보장된다. 7자 이하만 natural width를 사용한다. 따라서 회귀 테스트는 표시 길이별 font-size, 강제 폭 58, 가운데 여백을 결정적으로 검증할 수 있다.

## 레거시 renderer 호환성

`StockData`와 `renderStockCard()`의 기존 입력·출력 계약은 변경하지 않는다. 레거시 카드의 등락폭·등락률 2열, cache key, 상태 색상 테스트를 회귀 검증한다. 특히 기존 formatter의 국내 상승 `▲ 1,200`, 해외 하락 `▼ 0.50`, 등락률 `0.68%` 형식과 좌표를 그대로 고정한다. 새 canonical renderer용 formatter 때문에 레거시 문자열에 새 `+`/`-` 또는 `$`를 추가하지 않는다.

## 데이터 흐름

```text
KIS WS/REST 원문
  -> MarketAdapter strict decimal parsing
  -> sign code 기반 change/changeRate 정규화
  -> frozen Quote
  -> RestCoordinator exact-key 검증 (REST)
  -> StockActionController lastQuote + semanticKey
  -> RenderScheduler 버튼별 LWW
  -> renderer safe snapshot
  -> quote-change / quote-rate 2열 SVG
```

## 테스트

### Market adapter

1. 국내 WS `fields[4]`와 REST `prdy_vrss`를 읽고 상승·하락·보합 부호를 정규화한다.
2. 해외 WS `fields[13]`와 REST `diff`를 읽고 상승·하락·보합 부호를 정규화한다.
3. 원문 change/rate에 반대 부호가 있더라도 sign code가 canonical 부호를 결정한다.
4. 누락·비문자열·비 KIS decimal 등락폭은 안전한 `PROTOCOL` 오류가 된다.

### REST coordinator

1. 정확한 `change`가 포함된 quote를 반환한다.
2. `change` 누락, 추가 키, accessor, `NaN`, `Infinity`를 거부한다.
3. 반환 quote가 frozen이고 context·source 검증이 유지된다.

### Controller와 scheduler

1. 가격·등락률이 같고 등락폭만 다른 두 tick이 서로 다른 semantic key를 제출한다.
2. `receivedAt`만 다른 동일 가시 시세는 계속 같은 semantic key를 제출한다.
3. 기존 realtime/throttled LWW와 immediate/control 정책은 변하지 않는다.

### Renderer

1. 국내 상승은 `▲ +1,200`과 `+1.25%`를 각 data-role에 표시한다.
2. 해외 하락은 `▼ -$1.25`와 `-0.68%`를 각 data-role에 표시한다.
3. 보합은 화살표 없이 `0` 또는 `$0.00`, `0.00%`를 표시한다.
4. 7자 이하는 14px/natural width, 8~9자는 14px/강제 폭 58, 10~12자는 12px/강제 폭 58, 13~16자는 10px/강제 폭 58, 17자 이상은 8px/강제 폭 58을 적용한다.
5. 누락, accessor, non-finite, 상한 초과, sign과 모순된 change/rate는 안전한 표시 오류가 된다.
6. 비가시 quote metadata만 바뀌면 SVG identity가 유지된다.
7. 레거시 `renderStockCard()`는 국내 상승 `▲ 1,200`, 해외 하락 `▼ 0.50`, 등락률 `0.68%`와 기존 좌표를 유지한다.

관련 `QuoteSample` fixture는 모두 필수 `change`를 명시하도록 갱신하고 `npm run typecheck`로 누락을 검출한다.

## 문서와 릴리스

- README의 “큰 현재가와 등락률” 설명을 “큰 현재가와 등락폭·등락률”로 갱신한다.
- Property Inspector 설계의 README/AGENTS 문서 Task와 같은 파일을 수정하므로 최종 문서 단계에서 한 번에 정리해 충돌을 피한다.
- 이 기능은 승인된 PI B안과 함께 v2.2.0 minor release에 포함한다.
- 기존 release script로 package/manifest/lockfile 버전을 동기화하고 GitHub Release archive를 검증한다.

## 비목표

- 가격과 등락률을 이용한 등락폭 역산
- KIS WebSocket 연결·구독·재연결 정책 변경
- REST poll·cache·retry 정책 변경
- RenderScheduler interval·LWW·generation 정책 변경
- PI 설정 schema나 프로토콜 변경
- 해외 통화별 symbol 자동 선택
- 레거시 `StockData` 또는 `renderStockCard()` API 재설계
