# KIS StreamDeck 플러그인 - 프로젝트 구조

## 디렉토리 트리

```
com.kis.streamdeck.sdPlugin/
├── src/
│   ├── plugin.ts                  # 플러그인 진입점 및 초기화
│   ├── actions/                   # Stream Deck 액션 구현
│   │   ├── domestic-stock.ts      # 국내 주식 액션 (513줄)
│   │   └── overseas-stock.ts      # 미국 주식 액션 (512줄)
│   ├── kis/                       # KIS Open API 통합 모듈
│   │   ├── auth.ts               # OAuth2 토큰 관리 (235줄)
│   │   ├── websocket-manager.ts  # WebSocket 중앙 관리 (486줄)
│   │   ├── rest-price.ts         # REST API 폴백 가격 조회 (194줄)
│   │   ├── domestic-parser.ts    # H0UNCNT0 데이터 파싱 (70줄)
│   │   ├── overseas-parser.ts    # HDFSCNT0 데이터 파싱 (74줄)
│   │   └── settings-store.ts     # 글로벌 설정 저장소 (48줄)
│   ├── renderer/                  # UI 렌더링 모듈
│   │   └── stock-card.ts         # SVG 카드 렌더링 엔진 (332줄)
│   ├── types/                     # 타입 정의 및 상수
│   │   └── index.ts              # TypeScript 타입 및 상수 (113줄)
│   └── utils/                     # 유틸리티 모듈
│       ├── logger.ts             # 로거 래퍼 (21줄)
│       └── timezone.ts           # KST/ET 시간대 유틸 (78줄)
├── ui/                            # 속성 검사기(Property Inspector) 및 UI
│   ├── domestic-stock-pi.html    # 국내 주식 속성 검사기
│   ├── overseas-stock-pi.html    # 미국 주식 속성 검사기
│   ├── sdpi.js                   # 속성 검사기 JavaScript
│   └── sdpi.css                  # 속성 검사기 스타일
├── bin/                           # 빌드 결과물 (배포 아티팩트)
│   └── plugin.js                 # 번들된 플러그인 코드
├── package.json                  # npm 패키지 정의
├── tsconfig.json                 # TypeScript 설정
├── rollup.config.js              # Rollup 빌드 설정
├── .moai/                        # MoAI ADK 설정 및 문서
│   ├── project/                 # 프로젝트 문서 (본 파일 포함)
│   └── specs/                   # SPEC 문서 디렉토리
├── .claude/                      # Claude Code 설정
│   ├── rules/                   # 프로젝트 규칙
│   ├── skills/                  # 커스텀 스킬
│   ├── agents/                  # 커스텀 에이전트
│   ├── hooks/                   # 이벤트 훅
│   └── commands/                # 커스텀 명령
├── CLAUDE.md                     # MoAI 실행 지침
├── README.md                     # 프로젝트 개요 및 사용 설명서
├── CHANGELOG.md                  # 버전 히스토리
└── .gitignore                   # Git 무시 파일 목록
```

## 디렉토리별 설명

### src/ - 소스 코드 디렉토리

TypeScript로 작성된 플러그인의 핵심 로직을 포함합니다. ESM(ECMAScript Modules) 형식으로 작성되며 Rollup으로 번들링됩니다.

#### src/plugin.ts - 플러그인 진입점
- **용도**: 플러그인 초기화 및 액션 등록
- **책임**:
  - Stream Deck 플러그인 초기화
  - 국내 주식 액션 등록 (com.kis.streamdeck.domestic)
  - 미국 주식 액션 등록 (com.kis.streamdeck.overseas)
  - 글로벌 설정 저장소 초기화
- **의존성**: KIS/websocket-manager.ts, kis/settings-store.ts

#### src/actions/ - 액션 구현
Stream Deck 플러그인의 핵심 비즈니스 로직을 구현합니다.

**domestic-stock.ts** (513줄)
- 국내 주식 조회 및 모니터링 액션
- 책임:
  - 종목 코드 설정 (Property Inspector에서 수신)
  - WebSocket 구독/구독 해제 관리
  - SVG 카드 렌더링 및 업데이트
  - 에러 처리 및 상태 표시
- 인터페이스: Stream Deck 메시지 수신/송신

**overseas-stock.ts** (512줄)
- 미국 주식 조회 및 모니터링 액션
- 책임:
  - 미국 주식 코드 설정 (예: AAPL, TSLA)
  - WebSocket 스트리밍 데이터 처리
  - SVG 렌더링 (미국 시장 시간 표시)
  - 시간대 변환 (ET/EDT 처리)
- 공통: domestic-stock.ts와 동일 구조, 파서만 다름

#### src/kis/ - KIS Open API 통합

KIS Open API 연동을 위한 모든 기능을 구현합니다. OAuth2 인증, WebSocket 스트리밍, REST API 폴백을 관리합니다.

**websocket-manager.ts** (486줄) - 핵심 모듈
- **패턴**: Singleton 패턴 (전역 인스턴스 단일화)
- **책임**:
  - 단일 WebSocket 연결 생성 및 관리
  - OAuth2 토큰 기반 인증
  - 모든 버튼의 구독 요청 중앙 처리
  - 데이터 수신 및 Observer 패턴으로 구독자에게 전달
  - 연결 상태 추적 (LIVE/BACKUP/BROKEN)
  - 자동 재연결 로직
- **핵심 메서드**:
  - `getInstance()`: Singleton 인스턴스 반환
  - `subscribe(stockCode)`: 종목 구독
  - `unsubscribe(stockCode)`: 구독 해제
  - `on(event, callback)`: 이벤트 리스너 등록
  - `getConnectionState()`: 현재 연결 상태 반환
- **상태 관리**: LIVE(WebSocket 스트리밍), BACKUP(REST API), BROKEN(오류)

**auth.ts** (235줄)
- **책임**:
  - OAuth2 승인 키 기반 접근 토큰 획득
  - 토큰 캐싱 및 자동 갱신 (24시간 만료)
  - 레이트 리미팅 처리
  - 안전한 토큰 관리 (파일 저장 금지)
- **핵심 메서드**:
  - `getAccessToken(appKey, appSecret)`: 토큰 획득/갱신
  - `isTokenExpired()`: 만료 여부 확인
  - `refreshToken()`: 수동 토큰 갱신

**rest-price.ts** (194줄)
- **책임**:
  - WebSocket 데이터 수신 불가 시 REST API를 통한 현재가 조회
  - 20초 이상 WebSocket 데이터 미수신 시 자동 전환
  - 현재가, 고가, 저가, 거래량 조회
- **핵심 메서드**:
  - `getPrice(stockCode)`: REST API를 통한 현재가 조회

**domestic-parser.ts** (70줄)
- **책임**: H0UNCNT0 국내 주식 실시간 데이터 필드 파싱
- **추출 필드**:
  - 현재가, 변동률, 거래량
  - 고가, 저가, 시가
  - 거래대금, 호가 정보
- **사용**: WebSocket에서 수신한 데이터 구조화

**overseas-parser.ts** (74줄)
- **책임**: HDFSCNT0 미국 주식 실시간 데이터 필드 파싱
- **추출 필드**:
  - 현재가, 변동률, 거래량
  - 고가, 저가, 시가
- **사용**: WebSocket에서 수신한 해외 데이터 구조화

**settings-store.ts** (48줄)
- **패턴**: Promise 기반 초기화 대기
- **책임**:
  - 글로벌 설정(API 키 등) 저장소 관리
  - 플러그인 전체에서 공유되는 설정
  - 비동기 초기화 완료 대기 기능
- **핵심 메서드**:
  - `getInstance()`: 설정 저장소 인스턴스 반환
  - `waitForReady()`: 초기화 완료까지 대기
  - `get(key)`: 설정값 조회
  - `set(key, value)`: 설정값 저장

#### src/renderer/ - UI 렌더링

Stream Deck 버튼에 표시될 SVG 카드를 동적으로 생성합니다.

**stock-card.ts** (332줄)
- **책임**:
  - 144x144 픽셀 SVG 카드 동적 생성
  - 현재가, 변동률, 거래량 표시
  - 연결 상태 아이콘 (LIVE/BACKUP/BROKEN)
  - 시장 세션 표시 (국내: PRE/REG/AFT/CLOSED, 해외: 영업시간 표시)
  - LRU 캐싱으로 성능 최적화
- **핵심 메서드**:
  - `render(stockData, connectionState)`: SVG 문자열 생성
  - `getSVGDataUrl(svg)`: SVG를 Data URL로 변환 (Stream Deck 전송용)
  - 캐시 관리: 자주 사용되는 SVG 재사용
- **색상 규칙**:
  - 상승: 빨강색 (#FF0000)
  - 하락: 파랑색 (#0000FF)
  - 보합: 검정색 (#000000)

#### src/types/ - 타입 정의

**index.ts** (113줄)
- **내용**:
  - `StockData`: 주식 데이터 타입 (현재가, 변동률, 거래량 등)
  - `ConnectionState`: 연결 상태 타입 (LIVE/BACKUP/BROKEN)
  - `MarketSession`: 시장 세션 타입 (국내/해외)
  - 상수: 시장 시간, API 엔드포인트, 데이터 필드명
- **용도**: 전체 프로젝트에서 사용하는 공통 타입 정의

#### src/utils/ - 유틸리티

**logger.ts** (21줄)
- **책임**: 로깅 기능 래퍼
- **용도**: 개발/디버깅 시 콘솔 출력

**timezone.ts** (78줄)
- **책임**: 시간대 변환 및 시장 세션 판단
- **기능**:
  - KST(한국 표준시): UTC+9 고정
  - ET(Eastern Time): EDT(UTC-4) / EST(UTC-5) 자동 전환 (DST)
  - 국내 시장 세션 판단: 별도시간(04:00-08:30), 정규시간(09:00-15:30), 시간외(15:40-23:30), 폐장
  - 미국 시장 세션 판단: ET 기준 영업 시간(09:30-16:00)

### ui/ - 속성 검사기(Property Inspector)

Stream Deck에서 버튼 설정 시 나타나는 UI 폴더입니다.

**domestic-stock-pi.html**
- 국내 주식 액션의 설정 화면
- 입력 항목: 종목 코드(예: 005930 삼성전자), API 키 설정

**overseas-stock-pi.html**
- 미국 주식 액션의 설정 화면
- 입력 항목: 주식 코드(예: AAPL), API 키 설정

**sdpi.js**
- 속성 검사기 JavaScript 로직
- 책임:
  - HTML 폼 입력 처리
  - Stream Deck 플러그인과의 메시지 송수신
  - 유효성 검사

**sdpi.css**
- 속성 검사기 스타일링
- Elgato Stream Deck 공식 스타일 적용

### bin/ - 빌드 아티팩트

**plugin.js**
- Rollup으로 번들링된 최종 플러그인 코드
- ESM 모듈 형식으로 모든 의존성 포함
- Stream Deck이 로드하고 실행하는 파일
- 생성: `npm run build` 실행 시

### 설정 파일

**package.json**
- npm 패키지 정의
- 의존성: @elgato/streamdeck 1.1.0, ws 8.18.0
- 스크립트: build, watch, local:install, package:plugin, release:patch/minor/major

**tsconfig.json**
- TypeScript 컴파일러 설정
- Strict 모드 활성화
- ESM 모듈 대상

**rollup.config.js**
- Rollup 번들러 설정
- 입력: src/plugin.ts
- 출력: bin/plugin.js (ESM 형식)

## 모듈 간 의존성

```
plugin.ts (진입점)
  ├→ actions/domestic-stock.ts
  │   └→ kis/websocket-manager.ts
  │       ├→ kis/auth.ts
  │       ├→ kis/domestic-parser.ts
  │       └→ kis/rest-price.ts
  ├→ actions/overseas-stock.ts
  │   └→ kis/websocket-manager.ts
  │       ├→ kis/auth.ts
  │       ├→ kis/overseas-parser.ts
  │       └→ kis/rest-price.ts
  ├→ kis/settings-store.ts
  ├→ renderer/stock-card.ts
  │   └→ types/index.ts
  └→ utils/
      ├→ logger.ts
      └→ timezone.ts
```

## 핵심 파일 위치

| 기능 | 파일 | 줄 수 |
|------|------|------|
| 플러그인 초기화 | src/plugin.ts | - |
| 국내 주식 액션 | src/actions/domestic-stock.ts | 513 |
| 미국 주식 액션 | src/actions/overseas-stock.ts | 512 |
| WebSocket 관리 | src/kis/websocket-manager.ts | 486 |
| SVG 렌더링 | src/renderer/stock-card.ts | 332 |
| OAuth2 인증 | src/kis/auth.ts | 235 |
| REST API 폴백 | src/kis/rest-price.ts | 194 |
| 시간대 유틸 | src/utils/timezone.ts | 78 |
| 해외 파서 | src/kis/overseas-parser.ts | 74 |
| 국내 파서 | src/kis/domestic-parser.ts | 70 |
| 타입 정의 | src/types/index.ts | 113 |
| 설정 저장소 | src/kis/settings-store.ts | 48 |
| 로거 | src/utils/logger.ts | 21 |

## 데이터 흐름

### 초기화 흐름
1. Stream Deck이 bin/plugin.js 로드
2. plugin.ts 실행 → kis/settings-store.ts 초기화
3. actions/domestic-stock.ts, overseas-stock.ts 등록
4. kis/websocket-manager.ts Singleton 인스턴스 생성 (아직 연결 안 함)

### 런타임 흐름 (사용자가 버튼 추가 시)
1. 사용자가 Stream Deck에서 액션 추가 (국내 또는 해외 주식)
2. Property Inspector (ui/*.html) 로드, 종목 코드 입력
3. 액션 인스턴스 생성, willAppear 이벤트 발생
4. kis/websocket-manager.ts.subscribe() 호출 → WebSocket 연결 및 구독
5. WebSocket 데이터 수신 → kis/*-parser.ts로 파싱
6. renderer/stock-card.ts로 SVG 생성
7. Stream Deck 버튼 업데이트

### 폴백 흐름 (WebSocket 데이터 20초 이상 미수신)
1. 자동 감지 → kis/rest-price.ts 호출
2. REST API로 현재가 조회
3. SVG에 "BACKUP" 상태 표시
4. WebSocket 복구 → "LIVE" 상태로 복귀

## 개발 시 주의사항

1. **WebSocket 관리**: 모든 버튼이 kis/websocket-manager.ts를 통해야 함 (직접 생성 금지)
2. **토큰 보안**: auth.ts에서 발급한 토큰을 파일에 저장하지 말 것 (메모리만 사용)
3. **SVG 렌더링**: stock-card.ts의 캐싱 로직을 유지하여 성능 최적화
4. **시간대 처리**: timezone.ts를 통해 세션 판단 (하드코딩 금지)
5. **에러 처리**: 네트워크 에러 시 상태를 BROKEN으로 설정하고 자동 재연결 시도
