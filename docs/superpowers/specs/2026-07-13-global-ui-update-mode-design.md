# 전역 UI 업데이트 모드 설계

이 문서는 [`2026-07-13-websocket-throttled-minimal-stock-card-design.md`](./2026-07-13-websocket-throttled-minimal-stock-card-design.md)의 화면 스로틀 정책을 대체하는 후속 설계다. 이전 문서의 2·5·10초 서술은 당시 결정을 설명하는 역사 기록이며, 현재 정책은 이 문서를 따른다.

## 목표와 비목표

목표는 모든 KIS WebSocket 시세 tick을 기존 상태 머신과 액션 컨트롤러에서 빠짐없이 처리하면서, Stream Deck UI 반영 경계에서만 버튼별 trailing last-write-wins(LWW)를 적용하는 것이다. 한 경계 안에 여러 화면 의도가 제출되면 가장 최근의 완성된 의도만 SVG 생성과 `setImage()` 후보가 된다.

WebSocket 원문 수신, 파싱, 구독 fan-out 또는 액션의 시세 상태 갱신을 스로틀하지 않는다. 데이터 모드, WebSocket 연결·재연결, 구독·재구독, REST 최초 조회·백업 폴링·수동 새로고침 정책도 이 변경의 대상이 아니다.

## 전역 설정 계약과 이전

`GlobalPreferencesV2`는 다음 두 필드로 UI 정책을 표현한다.

- `uiUpdateMode: "realtime" | "throttled"`
- `renderIntervalMs: 500 | 600 | 700 | 800 | 900 | 1000`

`realtime`의 유효 간격은 항상 50ms다. `throttled`의 유효 간격은 사용자가 저장한 `renderIntervalMs`이며 500~1000ms 범위에서 100ms 단위만 허용한다. `realtime`에서도 스로틀 간격 저장값은 유지하여 모드를 왕복할 때 이전 값을 복원한다.

`schemaVersion`은 2를 유지한다. 신규 설정, UI 필드 쌍이 손상되거나 불완전한 설정, 과거 2초·5초·10초 `renderIntervalMs`를 가진 v2 설정은 모두 `uiUpdateMode: "throttled"`, `renderIntervalMs: 1000`으로 정규화한다. 모드와 간격이 둘 다 유효할 때만 그 쌍을 보존한다. 기존 `updateMode`와 `pollIntervalSec`의 데이터 모드·백업 폴링 이전 규칙은 유지하지만, 구형 `throttleMs`나 2·5·10초 값을 새 UI 간격으로 환산하지 않는다.

## 유효 간격과 RenderScheduler 불변식

`src/core/ui-update-policy.ts`가 허용값과 `effectiveRenderIntervalMs()` 계산의 단일 출처다. 액션을 활성화할 때와 전역 설정을 실행 중 반영할 때 모두 이 함수의 결과를 `RenderScheduler`에 전달한다. 스케줄러의 버튼별 `normalIntervalMs`가 일반 시세 화면에 실제 적용되는 경계다.

`RenderScheduler`는 다음 불변식을 지킨다.

- `normal` 요청은 버튼별 유효 간격의 trailing LWW 창에서 최신 요청만 반영한다.
- `control` 요청은 UI 모드와 무관하게 기존 1초 trailing LWW 창을 유지한다.
- `immediate` 요청은 대기 시간을 우회하고 일반·제어 요청보다 우선한다. 수동 새로고침과 치명적 설정 오류 같은 즉시 화면의 의미는 바뀌지 않는다.
- 동일 의미 키와 동일 최종 이미지는 각각 렌더와 IPC 단계에서 건너뛴다.
- 버튼 lifecycle generation으로 사라졌거나 재설정된 타깃의 비동기 결과를 폐기하고, 같은 버튼의 commit은 generation을 넘어 직렬화한다.
- `updateInterval()`은 호출자가 소유한 현재 generation의 일반 간격만 바꾼다. 대기 중인 `normal` 요청이 있으면 변경 시점을 새 창의 시작으로 삼아 타이머를 다시 건다. `control`과 `immediate` 경계는 바꾸지 않는다.

## Property Inspector UX

각 국내·미국 주식 버튼의 Property Inspector에서 **고급 설정 → 화면 반영 방식**으로 전역 모드를 선택한다.

- `실시간 (50ms 최신값 병합)`을 선택하면 스로틀 간격 number input을 비활성화한다. input의 값은 지우거나 50으로 덮지 않는다.
- `스로틀링`을 선택하면 `min=500`, `max=1000`, `step=100`인 number input을 사용한다.
- 저장 시 비어 있지 않은 500~1000ms 범위의 100ms 단위 정수인지 검사한다. `realtime`에서 input이 비활성화되어 있어도 보존할 스로틀 값은 유효해야 한다.
- 선택 변경만으로 전역 설정을 쓰지 않는다. 사용자가 **고급 설정 저장**을 눌렀을 때만 명시적으로 저장하며, 저장된 값은 모든 활성·향후 국내 및 미국 주식 버튼에 전역 적용된다.

## 실행 중 설정 변경

UI 설정만 변경되면 `StockActionController`는 현재 활성화된 국내·미국 세션 각각에 대해 `RenderScheduler.updateInterval()`을 호출한다. 이후 활성화되는 세션은 최신 전역 설정에서 유효 간격을 계산한다.

`uiUpdateMode`, `renderIntervalMs`와 단순 `settingsRevision` 변화는 정책 재구성 signature에 포함하지 않는다. 따라서 UI 설정만 바꿀 때 WebSocket 연결을 끊거나 다시 연결하지 않고, 구독을 해제·재구독하지 않으며, REST 최초 조회·백업 폴링·grace 정책을 재시작하지 않는다. 데이터 모드나 백업 폴링 등 다른 정책 필드를 같은 저장에서 함께 바꾸면 그 필드의 기존 재구성 규칙은 그대로 적용한다.

## PI revision 동시성

PI는 전체 설정용 `settingsRevision`과 별도로 preference 저장의 기준인 `preferencesRevision`, 마지막으로 폼에 적용한 `lastAppliedPreferences` baseline을 추적한다.

- 편집하지 않은 폼에는 최신 안전 스냅샷을 적용하고 baseline과 preference revision을 함께 전진시킨다.
- 사용자가 preference를 편집 중이면 push가 입력을 덮지 않는다. 원격 preference가 baseline과 같으면 토큰 갱신처럼 preference와 무관한 쓰기로 판단해 preference revision만 전진시킨다.
- 원격 preference가 baseline과 다르면 원격 변경 충돌로 취급한다. 로컬 입력과 기존 preference revision을 유지하므로 stale 저장이 원격 값을 조용히 덮지 않고 revision conflict로 실패한다.
- 각 저장 명령은 해당 preference revision을 포함한다. 플러그인은 직렬화된 repository update 안에서 최신 저장소 revision과 비교하고, 충돌 시 최신 정제 스냅샷을 ACK에 돌려준다.
- PI는 섹션별 최신 request ID, 지금까지 본 최고 revision의 안전 스냅샷과 편집 version을 함께 사용한다. 더 최신 push 뒤에 도착한 오래된 ACK, 이전 저장의 늦은 ACK/오류 또는 낮은 revision 스냅샷은 최신 입력·baseline·진단을 되돌리지 않는다. 성공 ACK가 이미 본 최신 push보다 오래되었으면 캐시한 최신 안전 스냅샷으로 재조정한다.

PI와 플러그인 양쪽의 스냅샷 경계는 data-only로 정제한다. plain object/array의 own data property만 읽고 accessor, symbol, 비표준 prototype, 순환 참조와 유한하지 않은 수를 거부한다. PI에는 allowlist된 설정과 정제된 진단만 보내며 App Secret, access token, approval key 같은 민감 값이나 실행 capability를 포함하지 않는다.

## 진단 의미

PI 스냅샷에서 간격은 다음 세 관점으로 확인한다.

| 관점 | 필드 | 의미 |
| --- | --- | --- |
| 저장값(stored) | `snapshot.preferences.renderIntervalMs` | 모드 전환 후에도 유지되는 스로틀 간격 |
| 설정값(configured) | `snapshot.diagnostics.render.configuredIntervalMs` | 현재 전역 설정에 구성된 스로틀 간격으로, 저장값과 같아야 함 |
| 유효값(effective) | `snapshot.diagnostics.render.effectiveIntervalMs` | 스케줄러에 적용되는 일반 화면 간격. `realtime`은 50ms, `throttled`는 설정값 |

같은 진단 객체의 `uiUpdateMode`와 `submitted`, `coalesced`, `renders`, `commits`, 중복·stale skip, failure 카운터로 LWW와 IPC 생략 동작을 함께 확인한다.

## 테스트와 완료 기준

다음 조건을 자동 테스트와 정적 검사로 보장한다.

1. 정책 단위 테스트가 두 모드, 50ms 유효값, 500~1000ms/100ms 허용 집합과 그 밖의 값 거부를 검증한다.
2. 설정 테스트가 신규·손상·불완전 설정과 구형 2초·5초·10초를 `throttled + 1000ms`로 이전하고, 유효한 모드·간격 쌍과 `schemaVersion: 2`를 보존하는지 검증한다.
3. 스케줄러 테스트가 각 유효 간격의 `normal` LWW, 고정 1초 `control`, 대기 우회 `immediate`, 실행 중 간격 재예약, generation fencing과 비동기 commit 직렬화를 검증한다.
4. 컨트롤러·런타임 테스트가 국내·미국 버튼에 같은 전역 유효 간격을 적용하고, UI 설정만 바꿀 때 활성 타깃의 간격만 갱신하며 재연결·재구독·REST 정책 작업을 만들지 않는지 검증한다.
5. PI 테스트가 number input 속성, `realtime` 비활성화와 값 보존, 명시 저장, 입력 검증, 전역 안내 문구를 검증한다.
6. PI protocol/UI 테스트가 preference baseline과 revision, 원격 diff 충돌, push/ACK 역순 도착, 편집 보존, data-only 스냅샷 정제를 검증한다.
7. 진단 테스트가 저장·설정·유효 간격의 관계와 모드별 값을 검증한다.
8. `npm run typecheck`, 관련 Vitest 전체 세트와 `git diff --check`가 통과하고 README 및 프로젝트 지침이 이 후속 정책과 일치하면 완료다.
