# Property Inspector 전체 정보 구조 재설계

## 목적

국내·미국 주식 Property Inspector(PI)를 기능이 나열된 긴 설정 화면에서 사용 목적별 구조로 재편한다. 사용자는 접을 수 있는 영역을 즉시 알아보고, 현재 버튼에만 적용되는 값과 모든 버튼에 적용되는 값을 혼동하지 않아야 한다. 화면 반영 방식이 실시간일 때는 적용되지 않는 스로틀 간격을 화면에서 완전히 숨긴다.

이 설계는 사용자가 선택한 **B안: 설정 화면 전체 정보 구조 재구성**을 구현한다.

## 현재 문제

1. 고급 설정은 native details로 실제 접히지만 작은 기본 마커 외에 별도 chevron, 접힘 상태 요약, 열림 스타일이 없어 폴딩 여부가 명확하지 않다.
2. 실시간 모드에서도 스로틀 간격이 비활성화된 입력으로 남아 두 설정의 종속 관계가 불분명하다.
3. 현재 버튼 설정, 전역 자격증명, 전역 환경설정, 재연결 명령, 상세 진단이 같은 시각적 위계에 나열된다.
4. 현재 버튼 종목값은 자동 저장되지만 전역 설정은 명시적으로 저장해야 한다. 이 차이가 충분히 드러나지 않는다.
5. 재연결·진단 같은 문제 해결 기능이 일반 환경설정 안에 섞여 있다.
6. 자격증명 삭제는 모든 버튼에 영향을 주지만 별도 확인 없이 바로 실행된다.
7. 상세 진단이 항상 펼쳐져 있어 좁은 PI에서 일반 설정을 찾기 어렵다.

## 검토한 접근

### A. 고급 설정 중심 개선

기존 섹션 순서를 유지하고 고급 설정의 chevron, 조건부 간격 노출, 저장 상태만 개선한다. 변경 위험은 낮지만 전역/버튼 범위와 문제 해결 기능의 위계 혼란이 남는다.

### B. 전체 정보 구조 재구성 — 선택

연결 상태를 항상 보이는 요약으로 만들고, 나머지를 이 버튼, KIS 계정, 전체 버튼 환경설정, 문제 해결로 재구성한다. 적용 범위, 저장 방식, 문제 해결 기능이 목적별로 분리된다.

### C. 최소 수정

고급 설정에 chevron을 추가하고 실시간 모드에서 간격 행만 숨긴다. 가장 작지만 사용자가 요청한 전체 UI 연구 결과를 반영하지 못한다.

## 정보 구조

PI는 위에서 아래로 다음 순서를 사용한다.

1. **공통 연결 상태**
   - accordion이 아닌 상시 노출 상태 strip이다.
   - 연결 badge와 한 줄 요약을 표시한다.
2. **이 버튼**
   - 현재 액션의 종목 코드, 표시 이름 등 버튼별 필드를 포함한다.
   - 현재 버튼만 scope badge와 자동 저장 안내를 표시한다.
3. **KIS 계정**
   - App Key, App Secret, 저장된 Key 요약, 저장·삭제 버튼을 포함한다.
   - 모든 버튼 공통 scope badge를 표시한다.
4. **전체 버튼 환경설정**
   - 데이터 모드, 화면 반영 방식, 조건부 스로틀 간격, 백업 폴링을 포함한다.
   - 모든 버튼 공통 scope badge를 표시한다.
5. **문제 해결**
   - 인증 재시도, WebSocket 재연결, 현재 종목 새로고침을 포함한다.
   - 내부에 한 단계 더 접힌 상세 진단을 포함한다.

국내·미국 PI는 기존처럼 같은 shared UI를 사용하며 버튼별 종목 필드 구성만 다르다.

## Accordion 계약

이 버튼, KIS 계정, 전체 버튼 환경설정, 문제 해결, 상세 진단은 semantic details/summary를 사용한다.

- native 마커는 숨기고 chevron을 명시적으로 표시한다.
- chevron은 details open 상태에 맞춰 CSS로 회전한다.
- summary 전체가 클릭 영역이며 키보드 Enter/Space로 동작한다.
- 각 summary에는 제목, scope 또는 현재 상태 요약을 표시한다.
- accordion은 서로 독립적이며 하나를 열어도 다른 항목을 강제로 닫지 않는다.
- 이 버튼은 최초 렌더에서 열린다.
- KIS 계정은 epoch/sequence 검사를 통과해 처음 적용되는 설정 요청 응답 또는 settings/update snapshot에서 자격증명이 없으면 한 번만 자동으로 연다. 자격증명이 있으면 닫힌다.
- 전체 버튼 환경설정, 문제 해결, 내부 상세 진단은 최초에 닫힌다.
- snapshot 갱신은 사용자가 직접 바꾼 open 상태를 덮어쓰지 않는다.

닫힌 summary의 보조 요약은 다음 계약을 따른다.

- 이 버튼: 종목명 · 코드, 값이 없으면 종목 미설정
- KIS 계정: Key 저장됨, 값이 없으면 설정 필요
- 전체 버튼 환경설정: 자동 · 실시간 또는 자동 · 스로틀 700ms 형태
- 문제 해결: 재연결 · 진단
- 상세 진단: 필요할 때만 펼침

## 화면 반영 방식

두 옵션뿐인 화면 반영 방식은 select 대신 접근 가능한 segmented radio control로 표시한다.

- radio group label: 화면 반영 방식
- 값: realtime, throttled
- 실시간 설명: 50ms 최신값 병합
- 스로틀 설명: 선택한 간격마다 최신값 반영

스로틀 간격은 별도 container에 둔다.

- realtime이면 container에 hidden을 적용해 화면·탭 순서·접근성 트리에서 제거한다.
- throttled이면 number input을 표시한다.
- 기존 저장값은 input value에 유지해 실시간 → 스로틀링 왕복 시 마지막 값을 복원한다.
- 유효 범위는 기존 계약과 같이 500~1000ms, 100ms 단위다.
- 저장 payload는 실시간 모드에서도 보존된 유효 renderIntervalMs를 포함한다.

## 저장 상태와 피드백

### 현재 버튼

- 기존 자동 저장 동작을 유지한다.
- section note와 scope badge로 자동 저장·적용 범위를 알린다.
- 기존 유효성 오류와 debounce 정책은 유지한다.

### KIS 계정

- 기존 명시적 저장을 유지한다.
- 저장과 삭제 상태는 계정 section 안에서 표시한다.
- 자격증명 지우기는 모든 버튼에서 연결이 해제된다는 native confirmation을 통과한 뒤에만 명령을 보낸다.
- 취소하면 명령·상태 변경을 만들지 않는다.
- Secret input은 기존처럼 snapshot에서 채우지 않는다.

### 전체 버튼 환경설정

- 마지막으로 적용된 preference snapshot과 현재 control 값을 비교한다.
- 차이가 없으면 변경사항 저장 버튼을 비활성화한다.
- 차이가 있으면 버튼을 활성화하고 저장하지 않은 변경사항 상태를 표시한다.
- 사용자가 값을 원래 상태로 되돌리면 다시 비활성화한다.
- 저장 중에는 중복 저장을 막기 위해 버튼을 비활성화한다.
- 성공 snapshot이 적용되면 저장됨 상태로 돌아간다.
- 저장 중 추가 편집은 control에 보존한다. 응답 적용 뒤 현재 control이 새 snapshot과 같으면 clean/disabled, 다르면 dirty/enabled로 전환한다.
- 저장 오류는 기존 편집값을 유지하고 dirty/enabled로 돌아간다. 충돌 응답은 기존 복구 정책으로 authoritative snapshot을 적용한 뒤 현재 control과 비교해 clean 또는 dirty를 결정한다.
- 기존 settings revision, dirty edit protection, out-of-order acknowledgement, 충돌 복구 계약은 유지한다.
- 실시간 모드에서 숨겨진 간격도 유효성을 검사해 손상된 payload를 보내지 않는다.

## 문제 해결과 진단

- 인증 재시도, WebSocket 재연결, 현재 종목 새로고침을 문제 해결 section으로 옮긴다.
- 명령 payload와 플러그인 동작은 변경하지 않는다.
- 상세 진단은 문제 해결 내부 nested details로 옮긴다.
- 상세 진단을 처음 열 때 최신 진단 요청을 보낸다.
- 새로고침 버튼은 열린 진단 영역 안에 유지한다.
- snapshot 진단 데이터 적용과 sanitize/budget 정책은 변경하지 않는다.

## 연결 상태

공통 연결 상태는 화면 최상단의 compact strip으로 항상 표시한다.

- 기존 connection badge와 summary text를 재사용한다.
- 연결됨, 확인 중, 지연·오류 상태의 기존 class와 문구를 유지한다.
- strip은 버튼별·전역 설정 accordion과 시각적으로 구분한다.

## CSS와 접근성

- 좁은 Stream Deck PI 폭에서 단일 열을 유지한다.
- summary 최소 높이는 40px 이상이며 summary 전체를 클릭할 수 있다.
- scope badge와 상태 요약이 겹치면 보조 요약을 말줄임 처리한다.
- segmented control은 두 칸 동일 너비다.
- hidden 요소에는 layout 공간을 남기지 않는다.
- focus-visible outline을 summary, radio label, button, input에 제공한다.
- 색상만으로 열림·저장·연결 상태를 구분하지 않고 텍스트와 아이콘을 함께 쓴다.
- prefers-reduced-motion에서는 chevron과 상태 전환 애니메이션을 제거한다.

## 프로토콜·런타임 호환성

이 변경은 PI DOM·표시 로직 재구성이다.

- 설정 schema version은 2를 유지한다.
- preferences/save, credentials/save, credentials/clear, 재시도·재연결·새로고침·진단 요청 프로토콜을 유지한다.
- uiUpdateMode와 renderIntervalMs 저장 형식 및 런타임 정책을 유지한다.
- WebSocket 연결·구독, REST 정책, 렌더 스케줄러는 변경하지 않는다.
- 국내·미국 PI HTML 엔트리와 shared controller 구조를 유지한다.

## 테스트

PI JSDOM 테스트에 다음 계약을 추가하거나 갱신한다.

1. section 순서가 연결 상태 → 이 버튼 → KIS 계정 → 전체 버튼 환경설정 → 문제 해결인지 검증한다.
2. 모든 accordion에 명시적 chevron, summary, scope/상태 요약이 있는지 검증한다.
3. 이 버튼 기본 open, 나머지 기본 closed를 검증한다.
4. 자격증명이 없는 최초 snapshot에서 KIS 계정을 한 번만 자동 open하고 이후 사용자 toggle을 보존하는지 검증한다.
5. 실시간에서 스로틀 container가 hidden이고 input 값은 보존되는지 검증한다.
6. 스로틀링으로 변경하면 container가 나타나며 마지막 값이 복원되는지 검증한다.
7. radio group의 모드 왕복과 저장 payload를 검증한다.
8. preference가 깨끗할 때 저장 버튼 disabled, 변경 시 enabled, 원복 시 disabled인지 검증한다.
9. 저장 중 중복 제출 차단과 성공·오류·충돌 후 상태를 검증한다.
10. 자격증명 삭제 confirmation의 승인·취소를 검증한다.
11. 문제 해결 명령이 기존 payload를 보내는지 검증한다.
12. 상세 진단 최초 open과 수동 새로고침이 진단 요청을 보내는지 검증한다.
13. 늦은 snapshot, epoch 변경, dirty revision 보호가 새 control 구조에서도 유지되는지 회귀 검증한다.
14. 국내·미국 PI 양쪽이 같은 정보 구조와 동작을 사용하는지 검증한다.

최종 검증은 다음 순서로 실행한다.

1. npm run typecheck
2. npm test
3. npm run test:coverage
4. npm run build
5. npm run package:plugin
6. npm run package:smoke

## 문서와 릴리스

- README와 AGENTS의 PI 설명을 새 정보 구조와 조건부 스로틀 노출로 갱신한다.
- 기능 추가이므로 2.2.0 minor release로 발행한다.
- manifest, package.json, package-lock.json 버전을 기존 release script로 동기화한다.
- v2.2.0 태그로 GitHub Actions 릴리스 워크플로를 실행하고 실제 plugin archive가 GitHub Release에 첨부됐는지 확인한다.

## 비목표

- KIS 인증·WebSocket·REST·렌더링 정책 변경
- 전역 설정 schema version 변경
- 새 외부 UI 프레임워크 도입
- Stream Deck manifest action 또는 버전 호환 범위 변경
- 진단 payload 필드나 보안 budget 변경
