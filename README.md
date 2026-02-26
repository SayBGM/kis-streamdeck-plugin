# KIS StreamDeck 실시간 주식 시세 플러그인

![Preview](https://github.com/user-attachments/assets/e6d074fa-1227-4d36-a9fd-d5af7da1efc0)

한국투자증권 Open API를 사용해 Stream Deck 키에 국내/미국 주식 시세를 실시간으로 표시하는 플러그인입니다.

## 주요 기능

- 국내주식 실시간 시세 표시 (통합)
  - TR_ID: `H0UNCNT0`
  - 입력값: 종목코드, 표시 종목명
- 미국주식 실시간 시세 표시
  - TR_ID: `HDFSCNT0`
  - 입력값: 티커, 거래소(`NAS`/`NYS`/`AMS`), 표시 종목명
- 최초 표시 속도 개선
  - 키가 나타날 때 REST 현재가를 먼저 조회해 즉시 표시
  - 이후 WebSocket 체결 데이터로 실시간 갱신
- 단일 WebSocket 연결 공유
  - 모든 버튼 구독을 하나의 연결에서 관리
  - 마지막 구독이 해제되면 자동 연결 종료
- **연결 안정성 강화** (v1.2.0)
  - `approval_key` 30분 자동 갱신 (만료로 인한 인증 실패 방지)
  - 지수 백오프 재연결: 5초→10초→20초…최대 60초 (±10% 지터)
- **렌더링 성능 최적화** (v1.2.0)
  - SVG DataURI LRU 캐시 키를 의미론적 키로 변경 (캐시 적중률 향상)
  - `setImage()` 호출 디바운싱 50ms (IPC 호출 횟수 대폭 감소)
  - LRU 캐시 크기 200 → 500개
- 장 상태 표시
  - `PRE` / `REG` / `AFT` / `CLOSED`
  - 국내(KST), 미국(ET) 기준으로 자동 판별
- 전역 API 설정 공유
  - `App Key`, `App Secret`을 전역 설정으로 저장
  - 모든 액션에서 공통 사용

## 화면 동작

- 상태 화면
  - 설정 필요: 종목 설정이 비어 있을 때
  - 연결중: 초기 연결/조회 중
  - 데이터 대기: 구독 완료 후 체결 대기
  - 장 마감: 시장 시간 외
- 시세 카드 표시 항목
  - 종목명
  - 현재가
  - 전일 대비(화살표 포함)
  - 등락률
  - 장 상태

## 구조

```text
com.kis.streamdeck.sdPlugin/
├── manifest.json
├── vitest.config.ts                  # 테스트 설정
├── src/
│   ├── plugin.ts                     # 진입점, 액션 등록, 전역 설정 반영
│   ├── actions/
│   │   ├── domestic-stock.ts         # 국내 액션 라이프사이클/구독 관리
│   │   ├── overseas-stock.ts         # 미국 액션 라이프사이클/구독 관리
│   │   └── __tests__/               # 액션 특성 테스트
│   ├── kis/
│   │   ├── auth.ts                   # approval_key / access_token 발급
│   │   ├── websocket-manager.ts      # 단일 WS 연결, 구독/해제, 재연결, PINGPONG
│   │   ├── rest-price.ts             # 초기 REST 현재가 조회
│   │   ├── domestic-parser.ts        # 국내 수신 데이터 파싱
│   │   ├── overseas-parser.ts        # 미국 수신 데이터 파싱
│   │   ├── settings-store.ts         # 전역 설정 저장/대기
│   │   └── __tests__/               # WebSocket 특성 테스트
│   ├── renderer/
│   │   ├── stock-card.ts             # 144x144 SVG 카드 렌더링
│   │   └── __tests__/               # 렌더러 특성 테스트
│   ├── types/
│   │   └── index.ts                  # 타입/상수/TR_ID 정의
│   └── utils/
│       ├── timezone.ts               # KST/ET 시간 계산
│       └── logger.ts                 # 로그 유틸
├── ui/
│   ├── domestic-stock-pi.html        # 국내 액션 설정 UI
│   ├── overseas-stock-pi.html        # 미국 액션 설정 UI
│   ├── sdpi.js
│   └── sdpi.css
└── imgs/
```

## 데이터 흐름

1. 액션이 키에 배치되면 `onWillAppear` 실행
2. 전역 설정(`App Key`, `App Secret`) 확인
3. REST 현재가 조회 후 카드 즉시 표시
4. WebSocket 구독 등록
5. 체결 데이터 수신 시 카드 갱신
6. 액션 제거(`onWillDisappear`) 시 구독 해제

## 설정 값

- 전역 설정
  - `appKey`
  - `appSecret`
- 국내 액션 설정
  - `stockCode` (예: `005930`)
  - `stockName` (예: `삼성전자`)
- 미국 액션 설정
  - `ticker` (예: `AAPL`)
  - `exchange` (`NAS`/`NYS`/`AMS`)
  - `stockName` (예: `Apple`)

## 개발

```bash
npm run build         # 프로덕션 빌드
npm run watch         # 변경 감지 빌드
npm test              # 유닛 테스트 실행
npm run test:watch    # 테스트 감지 모드
npm run test:coverage # 커버리지 리포트
```

## 제약 사항

- 한국투자증권 실전투자 Open API 기준으로 구현되어 있습니다.
- WebSocket 연결은 단일 인스턴스로 공유합니다.
