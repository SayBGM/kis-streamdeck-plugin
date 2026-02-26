# KIS StreamDeck 플러그인 아키텍처 문서

이 디렉토리에는 KIS StreamDeck 플러그인의 완전한 아키텍처 문서가 포함되어 있습니다.

## 문서 목차

### 1. [01-overview.md](01-overview.md) - 아키텍처 개요 (8.7KB)

플러그인의 고수준 아키텍처, 설계 패턴, 주요 결정 사항을 설명합니다.

**주요 내용**
- 프로젝트 개요 및 기술 스택
- 싱글톤 + 옵저버 패턴 설명
- 이중 데이터 소스 (WebSocket + REST API)
- 타임존 인식 설계
- 시스템 경계 및 외부 시스템
- 주요 설계 결정 (ADRs)
- 아키텍처 계층 구조
- 성능 및 보안 고려사항

### 2. [02-modules.md](02-modules.md) - 모듈 구조 (14KB)

각 모듈의 책임, 인터페이스, 함수를 상세히 설명합니다.

**주요 내용**
- 디렉토리 구조 및 파일 목록
- 각 모듈의 책임과 역할
- 핵심 타입 및 인터페이스
- 주요 메서드 및 함수
- 모듈 간 의존성 그래프
- 공개 인터페이스 (Public APIs)

**모듈 목록**
- plugin.ts: 플러그인 진입점
- DomesticStockAction / OverseasStockAction: 액션 구현
- kis/auth.ts: OAuth2 토큰 관리
- kis/websocket-manager.ts: WebSocket 실시간 데이터
- kis/rest-price.ts: REST API 스냅샷 조회
- kis/*-parser.ts: 데이터 필드 파싱
- renderer/stock-card.ts: SVG 렌더링
- types/index.ts: 타입 정의

### 3. [03-dependencies.md](03-dependencies.md) - 의존성 분석 (11KB)

외부 및 내부 의존성, 버전 호환성, 보안을 분석합니다.

**주요 내용**
- 프로덕션 의존성: @elgato/streamdeck, ws
- 개발 의존성: TypeScript, Rollup, ESLint
- 내부 모듈 의존성 그래프
- 레이어별 의존성 구조
- 순환 의존성 검사 (무순환 확인)
- 버전 호환성 매트릭스
- 라이선스 검사
- 보안 고려사항
- 정기 업데이트 가이드

### 4. [04-entry-points.md](04-entry-points.md) - 진입점 및 라이프사이클 (15KB)

애플리케이션 진입점, 액션 라이프사이클, KIS API 통합을 설명합니다.

**주요 내용**
- 플러그인 진입점 (plugin.ts)
- 액션 라이프사이클 (onWillAppear → 운영 → onWillDisappear)
- 설정 변경 처리
- KIS API 진입점 (REST, WebSocket)
- 설정 저장소 관리
- 로거 통합
- 요청/응답 흐름 시각화

### 5. [05-data-flow.md](05-data-flow.md) - 데이터 흐름 (19KB)

모든 주요 데이터 흐름, 토큰 관리, 렌더링 파이프라인을 설명합니다.

**주요 내용**
- 실시간 주식 시세 흐름 (WebSocket 구독 → 파싱 → 렌더링)
- 초기 가격 로드 (REST API)
- OAuth2 토큰 발급 및 갱신
- WebSocket 연결 및 재연결
- 데이터 필드 파싱 (국내 vs 해외)
- SVG 렌더링 프로세스
- Stale 데이터 감지
- 연결 상태 전환
- 요청 동시성 관리

## 빠른 참조

### 파일 크기 요약

| 문서 | 크기 | 라인 수 |
|------|------|--------|
| 01-overview.md | 8.7KB | ~350 |
| 02-modules.md | 14KB | ~550 |
| 03-dependencies.md | 11KB | ~420 |
| 04-entry-points.md | 15KB | ~580 |
| 05-data-flow.md | 19KB | ~750 |
| **합계** | **68KB** | **~2,650** |

### 읽기 순서

**아키텍처 이해**
1. 01-overview.md (전체 그림)
2. 02-modules.md (각 부분)
3. 03-dependencies.md (모듈 관계)

**구현 이해**
4. 04-entry-points.md (프로그램 흐름)
5. 05-data-flow.md (데이터 이동)

### 핵심 개념

**설계 패턴**
- Singleton: WebSocket Manager, Settings Store
- Observer: 콜백 기반 데이터 배포
- Dual Source: WebSocket (Primary) + REST API (Fallback)

**주요 기술**
- Stream Deck SDK: 플러그인 라이프사이클
- WebSocket: 실시간 시세 수신
- OAuth2: 토큰 기반 인증
- SVG: 카드 렌더링

**성능 최적화**
- 토큰 캐싱: 24시간 재사용
- SVG 캐싱: 동일 렌더링 재사용
- 동시 요청 통합: 토큰 발급 제한 회피
- Stale 감지: 20초 미수신 시 상태 변경

## 아키텍처 핵심

### 시스템 경계

```
┌─────────────────────────────────────────────────────────┐
│  외부: KIS OpenAPI (REST + WebSocket)                  │
│  인증: OAuth2 (appKey/appSecret)                       │
└─────────────────────────────────────────────────────────┘
           ↑                       ↓
    (토큰, 시세)          (인증, 구독)
           │                       │
┌─────────────────────────────────────────────────────────┐
│  플러그인: src/                                         │
│  ├─ plugin.ts (진입점)                                 │
│  ├─ actions/ (액션 로직)                               │
│  ├─ kis/ (API 통합)                                    │
│  ├─ renderer/ (UI)                                     │
│  ├─ types/ (타입)                                      │
│  └─ utils/ (유틸)                                      │
└─────────────────────────────────────────────────────────┘
           ↑                       ↓
    (설정, 이벤트)        (아이콘)
           │                       │
┌─────────────────────────────────────────────────────────┐
│  외부: Stream Deck SDK                                  │
└─────────────────────────────────────────────────────────┘
```

### 데이터 흐름

```
WebSocket 서버
    ↓
ws 라이브러리
    ↓
KISWebSocketManager (싱글톤)
    ├─ 메시지 파싱
    ├─ 구독 매칭
    └─ 콜백 호출
    ↓
DomesticStockAction / OverseasStockAction
    ├─ 필드 파싱
    ├─ 데이터 변환
    └─ 렌더링 요청
    ↓
SVG 렌더링
    ├─ 포맷 변환
    ├─ 색상 선택
    └─ SVG 생성
    ↓
Stream Deck 아이콘 업데이트
```

## 주요 용어

| 용어 | 설명 |
|------|------|
| **TR_ID** | KIS API 거래 ID (H0UNCNT0: 국내, HDFSCNT0: 해외) |
| **tr_key** | 구독 대상 (주식코드 또는 실시간 키 조합) |
| **Approval Key** | WebSocket 접속 인증 토큰 |
| **Access Token** | REST API 호출 인증 토큰 (OAuth2) |
| **LIVE** | WebSocket 실시간 데이터 수신 중 |
| **BACKUP** | REST API 스냅샷으로 표시 중 |
| **BROKEN** | 모든 데이터 소스 실패 |

## 개발 가이드

### 새로운 액션 추가

1. ActionSettings 타입 정의 (types/index.ts)
2. Action 클래스 구현 (actions/ 디렉토리)
3. 파서 구현 (kis/ 디렉토리, 필요 시)
4. plugin.ts에 등록

### 새로운 데이터 소스 추가

1. TR_ID 및 필드 구조 파악
2. 파서 함수 구현
3. WebSocket Manager 연결
4. 액션에서 콜백 등록

### 성능 최적화

참고: 05-data-flow.md의 "요청 동시성 관리" 섹션

## 문제 해결

### WebSocket 연결 실패

1. approval_key 발급 확인 (kis/auth.ts)
2. 네트워크 연결 확인
3. KIS API 상태 확인
4. 로그 메시지 검토 (로거 출력)

### 토큰 발급 제한 (EGW00133)

자동으로 처리됨:
- in-flight 요청 통합 (중복 방지)
- 1분 대기 후 자동 재시도
- 캐싱으로 API 호출 최소화

### Stale 데이터 표시

WebSocket 연결이 끊겼을 가능성:
- 재연결 로그 확인
- REST API 대체 경로 동작 확인
- 네트워크 연결 상태 점검

## 참고 자료

- [KIS OpenAPI 문서](https://openapi.koreainvestment.com)
- [@elgato/streamdeck](https://www.npmjs.com/package/@elgato/streamdeck)
- [ws 라이브러리](https://github.com/websockets/ws)

## 문서 유지보수

마지막 업데이트: 2026-02-26
작성자: 아키텍처 분석 시스템

이 문서는 소스 코드와 동기화되어 있으며, 코드 변경 시 함께 업데이트됩니다.

