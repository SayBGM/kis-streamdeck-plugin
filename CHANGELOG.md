# CHANGELOG

## [Unreleased]

### Added
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
