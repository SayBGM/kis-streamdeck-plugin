# KIS StreamDeck 주식 시세 플러그인

![Preview](https://github.com/user-attachments/assets/e6d074fa-1227-4d36-a9fd-d5af7da1efc0)

한국투자증권(KIS) Open API의 국내 주식·ETF와 미국 주식 시세를 Stream Deck 키에 표시합니다. 여러 키가 인증, REST 조정기, WebSocket 연결과 렌더 큐를 공유하며, 연결 장애가 발생하면 정책에 따라 REST 백업으로 자동 전환합니다. 한국투자증권 **실전투자** Open API 전용입니다.

## 지원 환경

- Stream Deck 7.1 이상
- Stream Deck 플러그인 Node.js 24 런타임
- Stream Deck SDK 2 (`@elgato/streamdeck 2.1.0`)
- macOS 10.15 이상 또는 Windows 10 이상

Stream Deck 6.x와 7.0은 지원하지 않습니다. 기존 국내·미국 액션 UUID(`com.kis.streamdeck.domestic-stock`, `com.kis.streamdeck.overseas-stock`)는 유지되므로 업데이트 후에도 배치한 키와 액션 설정이 이어집니다.

## 키 화면과 액션

- 국내 주식·ETF: 6자리 종목코드, 표시 이름, 주식/ETF 구분
- 미국 주식: 1~6자 티커, 거래소(`NAS`/`NYS`/`AMS`), 표시 이름
- 종목명·장 상태, 큰 현재가, 등락률과 작은 연결 상태를 144×144 SVG 카드에 표시
- 실시간은 `LIVE`, REST 백업은 `BACKUP`, 연결 실패는 `BROKEN`, 오래된 시세는 지연 상태로 구분
- 키를 누르면 현재 연결 정책을 바꾸지 않고 고우선순위 REST 새로고침을 한 번 실행

## 시세 정책

전역 환경설정에서 데이터 모드, 렌더 간격, REST 백업 간격을 선택합니다.

| 모드·상태 | 동작 |
| --- | --- |
| 자동·장중 시작 | WebSocket을 먼저 시작하고 5초간 데이터가 없을 때 즉시 REST 1회 후 백업 폴링 |
| 자동·연결 끊김/지연/구독 대기·거절 | 즉시 REST 1회 후 15초·30초·60초 중 선택한 간격으로 반복, 유효한 WebSocket 데이터에서 중단 |
| 자동·장 마감 | WebSocket 없이 종목·세션·자격증명 세대별 REST 1회 |
| REST 전용·장중 | 즉시 REST 1회 후 15초·30초·60초 중 선택한 간격으로 반복 |
| REST 전용·장 마감 | 세션별 REST 1회 |
| 수동 새로고침 | 음수 캐시를 우회하는 고우선순위 REST 1회 |

일반 체결 렌더는 선택한 **2초·5초·10초** trailing last-write-wins 창으로 합쳐집니다. 연결이나 지연 같은 제어 상태는 1초 창으로 합치고, 치명적인 설정 오류와 수동 요청은 즉시 표시합니다. 화면 의미와 최종 SVG가 모두 같으면 SVG 생성 또는 Stream Deck IPC를 생략합니다.

## 안정성 구조

```text
Stream Deck App
  └─ plugin.ts
      ├─ SettingsRepository       직렬화된 v2 설정, readiness barrier, 재시도
      ├─ CredentialSession        자격증명 세대, 토큰 singleflight, 401 CAS
      ├─ RestCoordinator          동시 4개/초당 10개, 우선순위, 공유 취소·캐시
      ├─ ConnectionSupervisor     WebSocket 상태 머신, heartbeat, 재연결
      ├─ SubscriptionSupervisor   desired/live/stale/parked/rejected, 41개 순환
      ├─ MarketAdapter/Clock      국내 주식·ETF·미국 변환, 세션·DST 판정
      ├─ StockActionController    모든 액션의 공통 정책과 세대 fencing
      ├─ RenderScheduler          렌더 LWW, 버튼 세대, SVG LRU
      └─ PiController             allowlist 명령, 정제된 설정·진단 응답
```

### 인증과 REST

- App Key/Secret의 fingerprint와 generation으로 이전 발급 결과가 새 자격증명에 섞이지 않게 합니다.
- access token은 fingerprint와 version을 함께 저장하며, fingerprint가 없는 기존 토큰은 재사용하지 않습니다.
- 같은 자격증명 세대의 토큰 발급은 singleflight로 합치고, 401 무효화는 token-version CAS로 최신 토큰을 보호합니다.
- 인증 HTTP 시도는 10초 제한이며 KIS `EGW00133`은 60초 후 한 번만 재시도합니다.
- REST는 `manual > initial > fallback` 순서, 최대 동시 4개·초당 실제 fetch 10개로 조정합니다.
- 장 마감 성공 결과는 세션 안에서 재사용하며 실패는 30초만 음수 캐시합니다.

### WebSocket과 구독

- 연결은 `idle → connecting → open → reconnect_wait` 상태 머신이며 파괴할 때만 `stopped`가 됩니다.
- 재연결은 5초·10초·20초·40초·60초와 지터를 사용하고, 30초간 정상 liveness 후 백오프를 초기화합니다.
- KIS `PINGPONG` 원문 echo와 15초 유휴 ping/5초 timeout을 함께 검사합니다.
- subscribe/unsubscribe는 최소 100ms 간격으로 한 건씩 전송하고, 제어 결과가 5초 동안 불명확하면 소켓을 재생성합니다.
- 동시 LIVE 구독은 41개입니다. 초과 종목은 60초 lease마다 가장 오래된 LIVE와 parked를 교체하며, 미국 주간/야간 키 전환도 해제 확인 후 새 구독을 시작합니다.

## Property Inspector와 진단

Property Inspector(PI)는 버튼 종목 설정, 공통 연결 상태, 자격증명 저장, 접힌 고급 설정, 상세 진단 순서로 구성됩니다. PI는 Global Settings를 직접 읽거나 쓰지 않고 allowlist 기반 명령을 플러그인에 보냅니다.

- App Secret, access token, approval key는 PI 응답과 진단 이벤트에 포함되지 않습니다.
- 저장 결과는 요청 ID와 설정 revision으로 확인하며, 오래된 응답이 최신 입력을 덮지 않습니다.
- 고급 설정에서 `자동`/`REST 전용`, 렌더 2초·5초·10초, 백업 15초·30초·60초를 선택합니다.
- 진단은 인증, 토큰 만료, WebSocket·heartbeat, 구독 순환, REST 백업, 렌더 큐·캐시, 최근 오류를 보여줍니다.
- 정제된 진단 이벤트는 최대 100개를 보관하고 PI가 열린 동안에만 2초마다 전송합니다.

## 설정 자동 이전

처음 읽은 설정은 `schemaVersion: 2`로 자동 이전됩니다. 설정 읽기에 실패한 상태에서는 쓰지 않으며, 이전 저장 실패 시 원본을 보존하고 1초·2초·4초 간격으로 세 번 재시도합니다.

| v1 값 | v2 결과 |
| --- | --- |
| 모드 누락 또는 `websocket` | 자동, 렌더 2초 |
| `hybrid`, throttle ≤ 2초 | 자동, 렌더 2초 |
| `hybrid`, throttle 2~5초 | 자동, 렌더 5초 |
| `hybrid`, throttle > 5초 | 자동, 렌더 10초 |
| `poll` | REST 전용, 렌더 2초 |
| poll ≤ 15초 / 16~30초 / > 30초 | 백업 15초 / 30초 / 60초 |

버튼별 `stockCode`, `instrumentType`, `ticker`, `exchange`, `stockName` 키는 그대로 유지하고 `schemaVersion: 2`만 추가합니다.

## 사용 준비

1. 한국투자증권 Open API 포털에서 실전투자 App Key와 App Secret을 발급합니다.
2. Stream Deck에 플러그인을 설치하고 국내 또는 미국 주식 액션을 배치합니다.
3. Property Inspector에서 자격증명을 저장합니다.
4. 종목코드/티커, 거래소와 표시 이름을 설정합니다.
5. 필요하면 고급 설정에서 데이터·렌더·백업 정책을 조정합니다.

## 개발과 검증

개발과 CI는 Node.js 24를 사용합니다.

```bash
npm ci
npm run typecheck        # TypeScript strict 검사
npm test                 # Vitest 전체 테스트
npm run test:coverage    # 전체 line 80% + 핵심 그룹 branch 80% 게이트
npm run build            # Rollup 빌드와 bundle/source map 검증
npm run verify           # typecheck + coverage + build + production audit
npm run local:install    # 로컬 Stream Deck 플러그인 설치
npm run package:plugin   # 실제 archive 생성 + 안전 추출/모듈 resolve smoke
npm run package:smoke    # 이미 생성된 archive만 다시 smoke 검증
```

패키지 smoke는 `.streamDeckPlugin`을 격리된 임시 디렉터리에 안전하게 추출해 manifest, 번들, UI/이미지, package와 production `node_modules` 구조를 검사합니다. archive 안에서 `@elgato/streamdeck`, `@elgato/utils`, `@elgato/schemas`, `zod`, `ws`가 실제로 resolve되어야 통과합니다. 경로 탈출, 심볼릭 링크, 중복 경로, 10MB 초과 archive 또는 50MB 초과 설치 크기는 거부하고 임시 파일은 항상 삭제합니다.

SDK 2.x의 비번들 런타임 의존성 때문에 이전 버전보다 패키지 크기가 증가합니다. 기준 환경의 예상 크기는 압축 약 1.2MB, 설치 약 7.8MB이며 OS와 npm 잠금 해석에 따라 조금 달라질 수 있습니다.

## 제한 사항

- KIS 실전투자 엔드포인트만 사용합니다. 모의투자 키와 엔드포인트는 지원하지 않습니다.
- 시장 시계는 평일, 시간대, 미국 DST, 절전 복귀와 시스템 시계 변경을 처리하지만 거래소 **공휴일** 캘린더는 판정하지 않습니다. 공휴일에는 REST 결과 또는 시장 응답을 기준으로 표시될 수 있습니다.
- 미국 주간/야간 WebSocket 키는 KIS 세션 시간에 맞춰 자동 전환합니다.
- `src/plugin.ts`는 Stream Deck 런타임 진입점이라 테스트 coverage 대상에서 제외하지만, 빌드 source map과 archive smoke로 포함 여부를 검증합니다.
