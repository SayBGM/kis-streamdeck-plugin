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
- `setImage()` 호출은 50ms 디바운스로 일괄 처리 (IPC 부하 감소).
- SVG LRU 캐시 키는 `ticker|name|price|change|rate|sign|state|stale` 조합.
- 미국주식 `trKey`는 시간대에 따라 주간(`R`접두사) / 야간(`D`접두사)이 다름 (`isOverseasDayTrading()`).

**에러 타입** (`ErrorType` enum): `NO_CREDENTIAL` | `AUTH_FAIL` | `NETWORK_ERROR` | `INVALID_STOCK`
각각 버튼에 구별 가능한 에러 카드로 표시.

**`stock-card.ts` 시각적 상태 표시**:
- 카드 하단 4px 컬러 바: LIVE=초록, BACKUP=노랑, BROKEN=빨강
- stale 상태(마지막 데이터 수신 후 20초 경과): 종목명 노랑 표시
- BROKEN→LIVE 회복 시 2초간 회복 알림 카드 표시 후 일반 카드 복원
- `renderStockCard`, `renderWaitingCard`, `renderConnectedCard`, `renderSetupCard`, `renderErrorCard`, `renderRecoveryCard` 함수 제공

**`settings-store.ts` 타이밍 처리**: `kisGlobalSettings.waitUntilReady(timeout)` — 플러그인 시작 직후 Global Settings 수신 전에 REST 호출이 발생할 수 있어, 최대 15초 대기하는 패턴 사용 (특히 `rest-price.ts`에서 활용).

**스펙 어노테이션**: 코드베이스 전반에 `@MX:NOTE`, `@MX:SPEC`, `@MX:ANCHOR`, `@MX:REASON`, `@MX:WARN` 주석이 사용됨. SPEC-PERF-001(성능), SPEC-UI-001(UI) 규격을 코드와 연결하는 트레이서빌리티 마커임.

**Property Inspector** (UI): `ui/*.html`은 순수 HTML/JS. `sdpi.js` 커스텀 이벤트로 플러그인과 통신.
PI → Plugin 메시지는 `sendToPlugin()`, Plugin → PI는 `sendToPropertyInspector()`.

### Key Constraints

- KIS 실전투자 Open API 전용 (모의투자 엔드포인트 다름).
- `access_token`은 Global Settings에 캐싱해 재시작 후 재사용, 만료 시 자동 재발급.
- `manifest.json`의 Version은 `npm version` 실행 시 `scripts/sync-manifest-version.mjs`가 자동 동기화.
- 테스트는 `src/plugin.ts`를 커버리지에서 제외 (Stream Deck 런타임 의존).

---
