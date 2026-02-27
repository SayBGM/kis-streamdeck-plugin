# CHANGELOG

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
