# CHANGELOG

## [Unreleased]

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
