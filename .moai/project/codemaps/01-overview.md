# KIS StreamDeck 플러그인 아키텍처 개요

## 프로젝트 개요

**KIS StreamDeck 플러그인**은 한국투자증권(KIS) OpenAPI를 통해 실시간 주식 시세를 Stream Deck에 표시하는 플러그인입니다.

- **언어**: TypeScript 5.7.0
- **런타임**: Node.js (via @elgato/streamdeck)
- **주요 프레임워크**: @elgato/streamdeck 1.1.0, ws 8.18.0
- **빌드 도구**: Rollup, TypeScript
- **버전**: 1.1.0

## 아키텍처 패턴

### 1. 싱글톤 + 옵저버 패턴

이 플러그인은 다음과 같은 구조적 특징을 가집니다:

**Singleton Manager**
- `KISWebSocketManager` (싱글톤): WebSocket 연결을 중앙에서 관리
- `kisGlobalSettings` (싱글톤): 전역 설정 저장소
- 토큰 캐시 및 인증 상태를 공유 메모리에서 관리

**Observer Pattern**
- 각 액션(버튼)은 WebSocket Manager에 콜백을 등록
- 서버로부터 데이터 수신 시 등록된 콜백들이 호출됨
- 구독 성공, 연결 상태 변화 등도 콜백으로 통지

**분리된 데이터 계층**
- 토큰 관리 (auth.ts): REST API 인증
- 실시간 데이터 (websocket-manager.ts): WebSocket 스트림
- 스냅샷 조회 (rest-price.ts): 초기값 및 대체 경로

### 2. 이중 데이터 소스 (Dual Data Source)

플러그인은 두 가지 데이터 경로를 동시에 관리합니다:

**Primary: WebSocket (Live)**
- KIS WebSocket API를 통한 실시간 주식 시세
- 지연: 국내 H0UNCNT0 (실시간), 해외 HDFSCNT0 (지연)
- 연결 상태: LIVE (정상), BROKEN (끊김)

**Fallback: REST API (Backup)**
- 초기 가격 로딩 (onWillAppear 시)
- WebSocket 미연결 시 정기적 갱신
- 대체 경로로 BACKUP 상태 표시

**Connection State Management**
- LIVE: WebSocket에서 실시간 데이터 수신 중
- BACKUP: REST API 스냅샷으로 표시 중
- BROKEN: 모든 연결 경로 실패

### 3. 타임존 인식 설계

플러그인은 한국 장과 미국 장의 거래시간을 자동으로 판단합니다:

**국내주식 (KST 기준)**
- PRE: 08:30 ~ 09:00
- REG (정규장): 09:00 ~ 15:30
- AFT: 15:40 ~ 18:00
- CLOSED: 나머지 시간

**해외주식 (ET 기준, DST 자동 반영)**
- PRE: 04:00 ~ 09:30
- REG: 09:30 ~ 16:00
- AFT: 16:00 ~ 20:00
- CLOSED: 나머지 시간

거래시간별로 다른 데이터 구독 키를 사용합니다.

### 4. 설정 전파 흐름

```
Global Settings 변경
  ↓
applyGlobalSettings() 호출
  ↓
[토큰 Hydrate] ← 기존 캐시된 토큰 복원
  ↓
[Credentials 검증] ← appKey/appSecret 확인
  ↓
[WebSocket 업데이트] ← kisWebSocket.updateSettings()
  ↓
[Approval Key 발급] ← REST API 호출
  ↓
[기존 구독 재연결] ← 활성 구독들 다시 연결
```

## 시스템 경계

### 외부 시스템

**KIS OpenAPI**
- REST API 기저: https://openapi.koreainvestment.com:9443
- WebSocket: ws://ops.koreainvestment.com:21000
- 인증: OAuth2 클라이언트 자격증명 (appKey/appSecret)

**Stream Deck SDK**
- 플러그인 호스트와의 통신
- 액션(버튼) 라이프사이클 관리
- 설정 저장소 관리

### 내부 시스템

**플러그인 수준**: src/plugin.ts에서 모든 액션을 등록하고 전역 설정을 처리

**액션 수준**: 각 액션(DomesticStockAction, OverseasStockAction)은 독립적인 인스턴스지만 공유 WebSocket 사용

**유틸리티 수준**: 파싱, 렌더링, 로깅 등 횡단 관심사

## 주요 설계 결정 (ADRs)

### 1. WebSocket 싱글톤 vs 액션별 인스턴스

**결정**: 싱글톤 KISWebSocketManager 사용

**근거**
- KIS API 제약: 1분당 1회 토큰 발급 제한 (EGW00133)
- 복수 액션 동시 구독 시 효율성 (1개 연결 vs N개 연결)
- 구독 상태 중앙 관리로 메모리 효율성 증가

### 2. 토큰 캐싱 및 Global Settings 저장

**결정**: accessToken과 accessTokenExpiry를 Global Settings에 함께 저장

**근거**
- Stream Deck 재시작 후에도 토큰 재사용 가능 (24시간 유효)
- API 호출 감소로 rate limit 여유 확보
- 만료 1시간 전에 자동 갱신

### 3. 이중 데이터 소스 (WebSocket + REST)

**결정**: 실시간은 WebSocket, 초기값/대체는 REST API

**근거**
- WebSocket 연결 실패 시에도 최신 가격 표시 (BACKUP 상태)
- 초기 로딩 시 REST API로 빠른 가격 표시 후 WebSocket 연결
- 사용자 경험 개선 (항상 데이터 표시 가능)

### 4. 거래시간별 다중 구독 키

**결정**: isOverseasDayTrading() 함수로 시간 판단 후 다른 tr_key 사용

**근거**
- 미국 주간거래(09:00~15:30 KST)와 야간거래의 시세 소스가 다름
- 정확한 거래 시간대의 데이터만 수신 가능
- 장 종료 후 자동으로 차트 회색 처리

## 체계

### 계층 구조

```
Stream Deck 플러그인 (plugin.ts)
  ├── 액션 계층 (DomesticStockAction, OverseasStockAction)
  │   ├── WebSocket 구독/해제
  │   ├── REST API 초기 로딩
  │   └── 렌더링 요청
  │
  ├── 데이터 계층 (kis/ 디렉토리)
  │   ├── Auth (OAuth2 토큰 관리)
  │   ├── WebSocket Manager (실시간 스트림)
  │   ├── REST Price (스냅샷 조회)
  │   ├── Parsers (데이터 필드 파싱)
  │   └── Settings Store (설정 영속화)
  │
  └── 프레젠테이션 계층 (renderer/)
      └── Stock Card (SVG 렌더링)
```

### 통신 흐름

**초기화 흐름 (onWillAppear)**
```
Action 출현
  → REST API로 초기 가격 로드
  → WebSocket 구독 요청
  → Waiting 카드 표시
  → 구독 성공 시 연결 상태 업데이트
```

**실시간 데이터 흐름**
```
WebSocket 메시지 수신
  → WebSocket Manager 파싱
  → 등록된 콜백 호출
  → 액션의 데이터 처리 콜백 실행
  → 파서로 필드 추출
  → SVG 렌더링
  → Stream Deck에 이미지 설정
```

**재연결 흐름**
```
WebSocket 연결 끊김
  → 모든 액션에 BROKEN 상태 통지
  → 5초 후 자동 재연결 시도
  → 재연결 성공 시 모든 구독 다시 전송
  → REST API로 대체 가격 표시 (BACKUP)
```

## 성능 고려사항

### 메모리 최적화

- **SVG 캐싱**: 동일한 렌더링은 캐시하여 재사용 (200개 항목까지 보관)
- **토큰 캐싱**: 발급된 토큰을 메모리에 캐시하여 API 호출 감소
- **싱글톤 관리자**: 여러 액션이 1개의 WebSocket 연결 공유

### 네트워크 최적화

- **동시 요청 제한**: 토큰 발급 중복 요청을 1개로 통합 (EGW00133 회피)
- **재연결 전략**: 지수 백오프 대신 고정 5초 간격 재시도
- **stale 데이터 감지**: 20초 이상 데이터 미수신 시 표시 변경

### 응답성 최적화

- **비동기 처리**: 모든 API 호출과 렌더링은 비동기 Promise 기반
- **콜백 체인**: 실시간 데이터 처리는 동기 콜백으로 지연 최소화
- **타이머 관리**: 타이머를 액션별로 추적하여 메모리 누수 방지

## 보안 고려사항

### 자격증명 관리

- **appKey/appSecret**: Global Settings에 평문 저장 (Stream Deck의 제약)
- **accessToken 캐싱**: 발급받은 토큰은 메모리에만 저장
- **토큰 만료 검증**: 만료 1시간 전에 자동 갱신하여 정보 유지

### API 제약 준수

- **토큰 발급 제한**: 1분당 1회 제한 회피 (동시 요청 통합, 캐싱)
- **구독 수 제한**: 웹소켓 연결당 최대 구독 수 관리
- **Rate Limiting**: API 호출 빈도 모니터링 (로깅으로 추적)

## 확장 가능성

### 추가 액션 유형

현재 2가지 액션 (국내, 해외)이 SingletonAction 기반으로 구현되어 있습니다.
추가 액션 유형 (지수, 옵션, 선물 등)을 추가하려면:
1. 해당 TR_ID와 파서 추가
2. 새로운 Action 클래스 상속
3. plugin.ts에 등록

### 설정 추가

사용자가 원하는 포맷(연분수, 통화, 소수점)을 설정하려면:
1. GlobalSettings 또는 ActionSettings에 필드 추가
2. 파서에서 설정값 참고하여 변환
3. 렌더러에서 포맷 적용

### 캐시 전략 개선

현재 토큰 캐시와 SVG 캐시는 단순 메모리 기반입니다.
더 정교한 캐싱(LRU, TTL 기반)을 구현하려면:
1. 별도 Cache 클래스 생성
2. 웹소켓 메시지와 REST 응답에 적용
3. 메모리 사용량 모니터링

## 핵심 용어집

| 용어 | 설명 |
|------|------|
| TR_ID | KIS API의 거래 ID (H0UNCNT0, HDFSCNT0 등) |
| tr_key | 구독 대상 (주식코드, 실시간 키 조합) |
| Approval Key | WebSocket 접속용 인증 키 |
| Access Token | REST API 호출용 OAuth2 토큰 |
| LIVE | WebSocket에서 실시간 데이터 수신 중 |
| BACKUP | REST API 스냅샷으로 표시 중 |
| BROKEN | 모든 데이터 소스 실패 |
| Stale | 일정 시간 이상 새로운 데이터를 받지 못함 |

