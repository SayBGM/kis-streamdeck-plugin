# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

---

## Project: KIS StreamDeck Plugin

한국투자증권(KIS) Open API를 통해 Stream Deck 키에 국내/미국 주식 실시간 시세를 표시하는 플러그인.

### Commands

```bash
npm run build           # Rollup 프로덕션 빌드 → bin/plugin.js
npm run watch           # 변경 감지 빌드
npm test                # Vitest 단위 테스트 실행
npm run test:watch      # 테스트 감지 모드
npm run test:coverage   # 커버리지 리포트 (coverage/)
npm run local:install   # 빌드 + Stream Deck 앱에 로컬 설치
npm run package:plugin  # 빌드 + .streamDeckPlugin 패키징
npm run release:patch   # 패치 버전 릴리스 (manifest.json 자동 동기화)
npm run release:minor   # 마이너 버전 릴리스
npm run release:major   # 메이저 버전 릴리스
```

단일 테스트 파일 실행:

```bash
npx vitest run src/kis/__tests__/websocket-manager.scheduleReconnect.test.ts
```

현재 테스트 파일:
- `src/kis/__tests__/websocket-manager.scheduleReconnect.test.ts`
- `src/kis/__tests__/websocket-manager.updateSettings.test.ts`
- `src/actions/__tests__/domestic-stock.renderStockData.test.ts`
- `src/renderer/__tests__/stock-card.svgToDataUri.test.ts`

### Architecture

**빌드 파이프라인**: `src/plugin.ts` → Rollup (TypeScript) → `bin/plugin.js` (ESM)
외부 패키지 `@elgato/streamdeck`과 `ws`는 번들링 제외 (dist의 node_modules에 존재).

**핵심 데이터 흐름**:

```
Stream Deck App
  └─ plugin.ts (진입점)
       ├─ kisGlobalSettings (settings-store.ts) — appKey/appSecret 보관
       ├─ auth.ts — approval_key (WS) + access_token (REST) 발급/캐싱
       ├─ kisWebSocket (websocket-manager.ts) — 단일 WS 연결, 구독 다중화
       │    └─ KIS WS: ws://ops.koreainvestment.com:21000
       ├─ DomesticStockAction / OverseasStockAction (actions/)
       │    ├─ onWillAppear → REST 스냅샷 즉시 표시 → WS 구독
       │    ├─ onWillDisappear → WS 구독 해제
       │    └─ onKeyDown → 수동 REST 새로고침
       └─ stock-card.ts (renderer/) — 144×144 SVG DataURI 렌더링 (LRU 캐시)
```

**중요 설계 원칙**:

- `kisWebSocket`은 싱글턴. 모든 버튼이 하나의 WS 연결을 공유, 구독 키는 `trId:trKey`.
- `approval_key`는 30분마다 자동 갱신 (`APPROVAL_KEY_REFRESH_INTERVAL_MS`).
- WS 재연결: 지수 백오프 5초→10초→20초…최대 60초 (±10% 지터).
- 모든 WS 시세 tick은 처리하고 `RenderScheduler`가 UI 경계에서 버튼별 LWW를 적용. 전역 `uiUpdateMode`의 실시간 모드는 50ms, 스로틀링 모드는 500~1000ms(100ms 단위)를 일반 시세 화면에 사용하며, 제어 상태는 1초·수동/치명 오류는 즉시 반영.
- 실행 중 UI 모드 변경은 활성 국내·미국 타깃의 렌더 간격만 갱신하며 WebSocket 재연결·재구독 또는 REST 정책 재시작을 유발하지 않음.
- canonical `Quote.change`는 가격·등락률로 역산하지 않고 국내·해외 WS/REST의 API-native 전일 대비 등락폭을 전달. KIS sign code가 `change`와 `changeRate` 부호의 단일 출처. REST coordinator는 canonical Quote의 exact-key 구조·유한값·요청 문맥 일치를 검증하고, renderer 안전 경계는 값의 범위와 `change`/`changeRate`-`sign` 부호 일관성을 추가 검증.
- `StockActionController`의 가시 semantic key에는 `change`가 포함되어 등락폭만 바뀐 tick도 렌더 요청에서 누락되지 않음.
- SVG LRU 캐시 키는 `ticker|name|price|change|rate|sign|state|stale` 조합.
- 미국주식 `trKey`는 시간대에 따라 주간(`R`접두사) / 야간(`D`접두사)이 다름 (`isOverseasDayTrading()`).

**에러 타입** (`ErrorType` enum): `NO_CREDENTIAL` | `AUTH_FAIL` | `NETWORK_ERROR` | `INVALID_STOCK`
각각 버튼에 구별 가능한 에러 카드로 표시.

**`stock-card.ts` 시각적 상태 표시**:
- 종목명과 앞쪽 작은 점: LIVE=초록, BACKUP=파랑, BROKEN=빨강, 대기=회색
- canonical 액션 카드는 하단을 `quote-change`/`quote-rate` 2열로 나눠 API-native 등락폭과 등락률을 함께 표시하며, 긴 값은 58px 열 안에서 단계적으로 축소
- 일반 시세 카드는 하단 연결·지연·새로고침 상태 텍스트를 표시하지 않음
- stale/refreshing 상태는 화면 모델과 렌더 의미 키에는 유지되며 종목명 상태색을 덮어쓰지 않음
- 하단 연결 상태 컬러 바는 사용하지 않음
- BROKEN→LIVE 회복 시 2초간 회복 알림 카드 표시 후 일반 카드 복원
- `renderStockCard`, `renderWaitingCard`, `renderConnectedCard`, `renderSetupCard`, `renderErrorCard`, `renderRecoveryCard` 함수 제공

**`settings-store.ts` 타이밍 처리**: `kisGlobalSettings.waitUntilReady(timeout)` — 플러그인 시작 직후 Global Settings 수신 전에 REST 호출이 발생할 수 있어, 최대 15초 대기하는 패턴 사용 (특히 `rest-price.ts`에서 활용).

**스펙 어노테이션**: 코드베이스 전반에 `@MX:NOTE`, `@MX:SPEC`, `@MX:ANCHOR`, `@MX:REASON`, `@MX:WARN` 주석이 사용됨. SPEC-PERF-001(성능), SPEC-UI-001(UI) 규격을 코드와 연결하는 트레이서빌리티 마커임.

**Property Inspector** (UI): `ui/*.html`은 순수 HTML/JS. `sdpi.js` 커스텀 이벤트로 플러그인과 통신.
PI → Plugin 메시지는 `sendToPlugin()`, Plugin → PI는 `sendToPropertyInspector()`.

- 최상단 공통 연결 상태 strip은 항상 노출하고, 이 버튼/KIS 계정/전체 버튼 환경설정/문제 해결/상세 진단은 semantic `details`/`summary` accordion을 사용. native marker 대신 explicit chevron을 표시하고 summary 전체가 40px 이상 클릭 영역이며, scope badge로 현재 버튼과 모든 버튼 공통 범위를 구분.
- 닫힌 summary는 종목명·코드, Key 저장 여부, 데이터·화면 반영 방식 같은 동적 요약을 표시. snapshot 갱신은 사용자가 직접 바꾼 accordion open 상태를 덮지 않으며, 자격증명이 없는 최초의 유효 settings snapshot에서만 KIS 계정을 자동으로 열음.
- 화면 반영 방식은 접근 가능한 segmented radio. 실시간이면 스로틀 간격 container를 `hidden`으로 접근성 트리와 탭 순서에서도 제거하되 마지막 유효값은 보존하고, 스로틀링이면 500~1000ms/100ms 단위 입력을 노출.
- 현재 버튼 종목 설정은 유효성 검사 후 디바운스 자동 저장. KIS 계정은 명시 저장하며 삭제 전에 모든 국내·미국 버튼 연결 중단 confirmation을 요구. 전역 환경설정은 authoritative snapshot과 control을 비교해 dirty일 때만 명시 저장을 허용하고, pending 중복 제출·늦은 응답·revision 충돌에도 최신 사용자 편집을 보호.
- 문제 해결 안에 상세 진단을 nested disclosure로 두고 최초 open에 한 번 자동 요청. 내부 새로고침은 클릭할 때마다 요청하며, 정제·budget·2초 snapshot 정책은 유지.

### Key Constraints

- KIS 실전투자 Open API 전용 (모의투자 엔드포인트 다름).
- `access_token`은 Global Settings에 캐싱해 재시작 후 재사용, 만료 시 자동 재발급.
- `manifest.json`의 Version은 `npm version` 실행 시 `scripts/sync-manifest-version.mjs`가 자동 동기화.
- 테스트는 `src/plugin.ts`를 커버리지에서 제외 (Stream Deck 런타임 의존).

---
