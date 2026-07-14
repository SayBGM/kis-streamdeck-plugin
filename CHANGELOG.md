# CHANGELOG

## [Unreleased]

## [2.2.2] - 2026-07-14

### Changed
- 시세 카드 하단의 등락폭은 왼쪽 끝, 등락률은 오른쪽 끝에 같은 행으로 배치해 정보를 한눈에 비교할 수 있도록 변경

### Fixed
- 등락폭·등락률의 합산 예상 폭에 따라 글꼴을 함께 축소하고 극단적으로 긴 값만 비례 폭 제한을 적용해 양끝 배치에서도 중앙 간격이 유지되도록 보강

## [2.2.1] - 2026-07-14

### Changed
- 시세 카드의 등락폭과 등락률을 중앙 정렬된 세로 2행으로 배치하고, 등락률에서는 중복되는 `+`/`-` 부호를 생략
- 국내·미국 시세 방향 색상을 한국 사용자 관례에 맞춰 상승=빨강, 하락=파랑, 보합=회색으로 변경

### Fixed
- 다섯 자리 이상 등락폭과 등락률이 같은 행에서 겹쳐 144×144 카드 레이아웃이 깨지던 문제 수정

## [2.2.0] - 2026-07-14

### Added
- Property Inspector를 상단 공통 연결 상태와 `이 버튼`·`KIS 계정`·`전체 버튼 환경설정`·`문제 해결` 목적별 accordion으로 재구성하고, 적용 범위 badge와 명시적 chevron, 닫힌 영역의 동적 요약을 추가
- 국내·미국 WebSocket과 REST가 제공하는 전일 대비 등락폭을 보존해 시세 카드 하단에 등락폭과 등락률을 2열로 함께 표시

### Changed
- 화면 반영 방식을 접근 가능한 실시간/스로틀링 선택 UI로 바꾸고, 실시간에서는 스로틀 간격을 숨기되 마지막 유효값은 보존해 스로틀링 복귀 시 복원
- 전체 버튼 환경설정은 실제 변경이 있을 때만 저장할 수 있고 저장 중 중복 요청을 막으며, 저장 응답을 기다리는 동안의 추가 편집을 보존하도록 개선
- 자격증명 삭제 전에 모든 국내·미국 버튼의 시세 중단을 확인하고, 문제 해결 안의 상세 진단은 처음 펼칠 때만 자동으로 불러오도록 변경

### Fixed
- 늦거나 충돌한 설정 응답과 무관한 진단 snapshot이 최신 환경설정 편집·저장 결과·문제 해결 피드백을 덮거나 KIS 계정 영역을 잘못 여는 문제 수정
- REST 시세를 단일 exact-key snapshot으로 검증하고 KIS sign code로 등락폭·등락률 부호를 함께 정규화해 누락·손상·모순된 값이 렌더 경계를 통과하지 않도록 보강
- 가격과 등락률은 같고 등락폭만 바뀐 tick이 렌더 중복 제거에서 누락되던 문제 수정

## [2.1.0] - 2026-07-14

### Added
- 모든 주식 버튼에 공유되는 전역 화면 반영 방식으로 50ms 최신값 병합 `실시간`과 500~1000ms(100ms 단위) `스로틀링` 모드 추가

### Changed
- 신규 설치, 손상·누락된 UI 설정, 기존 2·5·10초 렌더 설정을 `스로틀링 + 1000ms`로 정규화
- 실행 중 화면 반영 설정 변경은 활성 국내·미국 버튼의 렌더 간격에 즉시 적용하되 WebSocket 재연결·재구독과 REST 정책 재시작은 하지 않도록 변경

### Fixed
- Property Inspector의 request/revision/epoch/sequence 경계를 강화해 오래되거나 안전하지 않은 snapshot과 플러그인 재시작이 최신 입력을 덮지 않도록 수정

## [2.0.2] - 2026-07-13

### Changed
- 모든 WebSocket 시세를 처리하면서 일반 체결 화면은 선택한 2·5·10초 창마다 최신값만 반영하도록 화면 갱신 제한을 명확히 적용
- 일반 시세 카드의 하단 연결·지연·새로고침 상태 텍스트를 제거하고 종목명 색상과 앞쪽 점으로 상태를 간결하게 표시

### Fixed
- KIS WebSocket 구독 응답의 header subscription key를 인식하지 못해 정상 구독 결과가 연결 상태에 반영되지 않던 문제 수정

## [2.0.1] - 2026-07-11

### Changed
- `LIVE`·`BACKUP`·`BROKEN`·대기 상태를 종목명 색상과 앞쪽 점으로 구분하고 stale·refreshing 상태가 연결 상태 색상을 덮지 않도록 개선

### Fixed
- 긴 종목명이 상태 표시와 겹치던 레이아웃을 보정하고 v2·레거시 카드의 저하 상태 표시를 일관되게 정리

## [2.0.0] - 2026-07-11

### Added
- 국내 ETF 현재가 조회와 실시간 시세 표시 지원
- `SettingsRepository`, `CredentialSession`, `RestCoordinator`, `ConnectionSupervisor`, `SubscriptionSupervisor`, `MarketAdapter`, `StockActionController`, `RenderScheduler`, `DiagnosticsStore` 기반 v2 런타임 구조
- 국내 주식·ETF·미국 주식의 공통 상태 머신 액션 엔진과 버튼 lifecycle generation fencing
- allowlist 명령만 처리하고 Secret·token·approval key를 노출하지 않는 Property Inspector 설정·진단 프로토콜
- Node.js 24 CI, 전체 line 80%와 핵심 런타임 그룹 branch 80% coverage 게이트
- 실제 `.streamDeckPlugin`을 안전하게 추출하고 SDK 전이 의존성을 resolve하는 archive smoke test

### Changed
- `@elgato/streamdeck`을 정확히 2.1.0, `ws`를 정확히 8.21.0으로 고정
- 최소 지원 버전을 Stream Deck 7.1과 플러그인 Node.js 24로 상향하고 SDKVersion 2 유지
- 설정을 v2 스키마로 자동 이전하고 자동/REST 전용, 렌더 2·5·10초, 백업 15·30·60초 프리셋으로 단순화
- WebSocket을 재연결·heartbeat·구독 제어·41개 lease 순환 상태 머신으로 교체
- REST를 동시 4개·초당 10개 제한, 호출 우선순위, 공유 취소, 세션 캐시 기반 조정기로 교체
- 일반 렌더를 trailing last-write-wins로 제한하고 실제 SVG 문자열 기반 LRU와 semantic 중복 제거 적용
- release workflow가 공통 verify/package 스크립트를 재사용하도록 통합
- forced-exit Rollup 종료와 파일시스템 반영 사이를 bounded readiness barrier로 동기화

### Security
- 취약한 이전 `ws` 잠금 버전을 제거하고 `npm audit --omit=dev`를 검증 게이트에 추가
- fingerprint가 없는 legacy access token 폐기, 자격증명 세대 및 token-version CAS 적용
- archive path traversal, 심볼릭 링크, Windows 예약 경로, Unicode·대소문자 충돌, 깨진 manifest asset 참조와 비정상 크기 차단
- coverage report를 실제 production TypeScript source allowlist와 정확히 대조해 누락·주입 차단

## [1.3.4] - 2026-03-15

### Added
- 초기화 중, 데이터 대기, 수동 새로고침 상태에 로딩 아이콘 표시

### Changed
- 주말에는 국내/미국 장 상태를 `마감`으로 표시하도록 세션 판별 보정
- 미국 주간거래 `tr_key` 선택이 주말에는 주간 세션으로 오판하지 않도록 수정

### Fixed
- Stream Deck 시작 직후 글로벌 설정보다 버튼이 먼저 뜰 때 `설정 필요` 카드로 잘못 떨어지던 문제 수정
- `npm run local:install` 설치본에 런타임 의존성이 빠져 플러그인이 즉시 종료되던 문제 수정

### Removed
- Property Inspector `연결 테스트` 버튼 및 관련 플러그인 메시지 처리
- PI 연결 테스트 전용 모듈/테스트 코드
- `연결 확인 중...` 상태 메시지 흐름

## [1.3.0] - 2026-02-27

### Added
- 에러 타입별 버튼 카드 표시 (인증 실패, 네트워크 오류, 종목 오류, 자격증명 미설정)
- WebSocket 데이터 지연 시 "지연" 텍스트 표시 (BACKUP 상태, 20초 이상 미수신)
- 연결 회복 알림 카드 (BROKEN/BACKUP→LIVE 전환 시 2초간 표시)
- Property Inspector 종목코드 실시간 검증 (국내: 6자리 숫자, 해외: 1~6자 영문)
- Property Inspector "연결 테스트" 버튼 (KIS API 자격증명 즉시 검증)

### Changed
- `renderErrorCard()`: 문자열 메시지 파라미터에서 ErrorType enum으로 변경
- `rest-price.ts`: null 반환에서 ErrorType throw로 변경 (에러 전파 개선)

### Fixed
- 인증 실패 시 버튼이 무한 로딩 상태로 남는 문제 수정
- 유효하지 않은 종목코드 입력 시 피드백 없던 문제 수정
