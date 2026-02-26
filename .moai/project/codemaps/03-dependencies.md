# 의존성 분석

## 외부 의존성 (Dependencies)

### 프로덕션 의존성

#### @elgato/streamdeck@1.1.0

**목적**: Stream Deck 플러그인 SDK

**주요 기능**
- Stream Deck 호스트와의 통신 프로토콜 구현
- 액션(버튼) 라이프사이클 관리 (onWillAppear, onWillDisappear, onDidReceiveSettings 등)
- 전역 설정 저장소 (streamDeck.settings)
- 로거 제공

**사용 위치**
```
src/plugin.ts
├── streamDeck.logger.setLevel()
├── streamDeck.actions.registerAction()
├── streamDeck.settings.onDidReceiveGlobalSettings()
├── streamDeck.settings.getGlobalSettings()
└── streamDeck.connect()

src/actions/domestic-stock.ts / overseas-stock.ts
├── SingletonAction 상속
├── WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent 타입
└── ev.action.setImage(), ev.action.showAlert() 등 API
```

**버전 호환성**
- 현재 1.1.0 사용 중
- TypeScript 5.7.0과 호환
- Node.js 모듈 기반 (ESM)

#### ws@8.18.0

**목적**: WebSocket 클라이언트

**주요 기능**
- WebSocket 연결 생성 (new WebSocket(url))
- 메시지 송수신
- 이벤트 기반 처리 (open, message, close, error)
- Node.js 기본 라이브러리 없이도 WebSocket 지원

**사용 위치**
```
src/kis/websocket-manager.ts
├── new WebSocket(KIS_WS_URL)
├── ws.on('open', 'message', 'close', 'error')
├── ws.send(JSON.stringify(message))
└── ws.readyState (WebSocket.OPEN 등 상수)
```

**네트워크 특성**
- KIS WebSocket 서버: ws://ops.koreainvestment.com:21000
- 메시지 포맷: JSON 제어 + 파이프 구분 데이터
- PINGPONG 핸들링: 서버 ping에 자동 응답

---

### 개발 의존성 (DevDependencies)

#### @rollup/plugin-typescript@12.1.0, @rollup/plugin-node-resolve@16.0.0

**목적**: TypeScript 번들링 및 Node 모듈 해석

**빌드 프로세스**
```
src/**/*.ts (TypeScript)
  ↓
TypeScript 컴파일러 (tsconfig.json)
  ↓
plugin-typescript 플러그인 (트랜스파일)
  ↓
plugin-node-resolve 플러그인 (의존성 해석)
  ↓
rollup 번들링
  ↓
bin/plugin.js (최종 번들)
```

#### typescript@5.7.0

**특징**
- 엄격한 타입 검사 (strict mode)
- 모듈 해석: ESNext/ES2022
- 명시적 반환 타입 제공

**설정** (tsconfig.json 기준)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": false,
    "moduleResolution": "bundler"
  }
}
```

#### rollup@4.28.0

**역할**
- 모듈 번들링
- Tree-shaking (사용되지 않는 코드 제거)
- 배포 가능한 단일 JavaScript 파일 생성

**출력**
- bin/plugin.js: @elgato/streamdeck에서 호출 가능한 진입점

#### @types/ws@8.5.13, tslib@2.8.0

**@types/ws**: TypeScript 타입 정의
- WebSocket 클래스와 메서드의 타입 지원

**tslib**: TypeScript 헬퍼 함수 라이브러리
- async/await 등의 트랜스파일 코드 최적화

---

## 내부 의존성 (Internal Modules)

### 의존성 트리

```
plugin.ts (최상위 진입점)
│
├─→ DomesticStockAction
│   ├─→ kis/websocket-manager
│   ├─→ kis/rest-price
│   ├─→ kis/auth
│   ├─→ kis/domestic-parser
│   ├─→ renderer/stock-card
│   ├─→ types/index
│   └─→ utils/logger
│
├─→ OverseasStockAction
│   ├─→ kis/websocket-manager
│   ├─→ kis/rest-price
│   ├─→ kis/auth
│   ├─→ kis/overseas-parser
│   ├─→ renderer/stock-card
│   ├─→ types/index
│   └─→ utils/logger
│
├─→ kis/websocket-manager (싱글톤)
│   ├─→ kis/auth
│   ├─→ types/index
│   └─→ utils/logger
│
├─→ kis/auth
│   ├─→ types/index
│   └─→ utils/logger
│
├─→ kis/settings-store (싱글톤)
│   └─→ types/index
│
└─→ utils/logger
    └─→ @elgato/streamdeck
```

### 레이어별 의존성

**L1: 기본 계층** (다른 모듈에 의존하지 않음)
```
types/index.ts
  ├─ 전역 설정 타입
  ├─ 액션 설정 타입
  ├─ 주식 데이터 타입
  ├─ KIS API 상수
  └─ 헬퍼 함수 (isOverseasDayTrading 등)

utils/
  ├─ logger.ts (streamDeck.logger만 사용)
  └─ timezone.ts (순수 함수)
```

**L2: 데이터 계층** (L1에 의존)
```
kis/auth.ts
  └─ types/index 사용

kis/domestic-parser.ts & kis/overseas-parser.ts
  └─ types/index 사용

kis/settings-store.ts
  └─ types/index 사용

renderer/stock-card.ts
  ├─ types/index 사용
  └─ utils/timezone 사용
```

**L3: 통합 계층** (L1, L2에 의존)
```
kis/websocket-manager.ts
  ├─ kis/auth 사용 (approval_key 발급)
  ├─ types/index 사용
  └─ utils/logger 사용

kis/rest-price.ts
  ├─ kis/auth 사용
  ├─ types/index 사용
  └─ utils/logger 사용
```

**L4: 액션 계층** (L1-L3에 의존)
```
DomesticStockAction / OverseasStockAction
  ├─ kis/websocket-manager 사용
  ├─ kis/rest-price 사용
  ├─ kis/parsers 사용
  ├─ renderer/stock-card 사용
  ├─ types/index 사용
  └─ utils/logger 사용
```

**L5: 플러그인 진입점**
```
plugin.ts
  ├─ DomesticStockAction 인스턴스화
  ├─ OverseasStockAction 인스턴스화
  ├─ kis/websocket-manager 사용
  ├─ kis/settings-store 사용
  ├─ kis/auth 사용
  ├─ types/index 사용
  └─ utils/logger 사용
```

---

## 순환 의존성 분석

### 순환 의존성 검사

**결론**: 순환 의존성 없음 ✓

**검증 로직**
```
types/index
  ← kis/auth, kis/parsers, kis/settings-store, utils
  ← kis/websocket-manager, kis/rest-price, renderer
  ← 액션들, plugin

plugin
  → 액션들 → kis/모듈들 → types/index (모두 일방향)
```

순환 의존성이 없으므로 모듈 로드 순서가 보장되며, 동적 로딩이나 지연 초기화(lazy initialization)가 필요 없습니다.

---

## 의존성 버전 호환성

### @elgato/streamdeck@1.1.0

**호환성 범위**
```
현재: 1.1.0
권장: ≥1.1.0, <2.0.0
```

**주요 메서드 안정성**
- `streamDeck.connect()`: v1.0.0+에서 안정적
- `streamDeck.logger`: v1.0.0+에서 안정적
- `streamDeck.actions.registerAction()`: v1.0.0+에서 안정적
- `streamDeck.settings`: v1.0.0+에서 안정적

### ws@8.18.0

**호환성 범위**
```
현재: 8.18.0
권장: ≥8.0.0, <9.0.0
```

**API 안정성**
- WebSocket 클래스: v7.0.0+에서 안정적
- 메시지 인코딩: UTF-8 지원 확실
- 재연결 불가: 새로운 인스턴스 필요

### 호환성 매트릭스

| 모듈 | 현재 버전 | 최소 버전 | 최대 버전 | Node.js |
|------|----------|----------|----------|---------|
| @elgato/streamdeck | 1.1.0 | 1.1.0 | <2.0.0 | ≥14 |
| ws | 8.18.0 | 8.0.0 | <9.0.0 | ≥14 |
| typescript | 5.7.0 | 5.0.0 | - | - |
| rollup | 4.28.0 | 4.0.0 | - | - |

---

## 의존성 라이선스 검사

### 프로덕션 의존성 라이선스

| 패키지 | 버전 | 라이선스 | 상태 |
|--------|------|---------|------|
| @elgato/streamdeck | 1.1.0 | MIT | ✓ 수용 가능 |
| ws | 8.18.0 | MIT | ✓ 수용 가능 |

**라이선스 호환성**: MIT 라이선스는 상업용, 개인용, 수정 사용 모두 가능

### 개발 의존성 라이선스

| 패키지 | 라이선스 |
|--------|---------|
| @rollup/plugin-typescript | MIT |
| @rollup/plugin-node-resolve | MIT |
| typescript | Apache 2.0 |
| rollup | MIT |
| @types/ws | MIT |
| tslib | 0BSD |

**개발 라이선스 영향**: 개발 의존성은 배포된 코드에 포함되지 않으므로 라이선스 제약 없음

---

## 의존성 보안 고려사항

### 알려진 취약점 확인

**ws@8.18.0**: 정상 ✓

최신 보안 패치 적용됨:
- CVE 수정: DNS rebinding 공격 방어 (v8.13.0+)
- URL 파싱 개선 (v8.14.0+)

**@elgato/streamdeck@1.1.0**: 정상 ✓

공식 Elgato 라이브러리로 정기 업데이트

**typescript@5.7.0**: 정상 ✓

최신 버전으로 보안 패치 포함

### 보안 권장사항

1. **정기 업데이트**: npm audit 실행
   ```bash
   npm audit
   npm audit fix
   ```

2. **자격증명 관리**:
   - appKey/appSecret는 Global Settings에 저장 (Stream Deck 제약)
   - 토큰은 메모리에만 저장 (평문 저장 금지)

3. **네트워크 보안**:
   - WebSocket: ws (비암호화) → wss로 업그레이드 가능
   - REST API: https (암호화) → 현재 사용 중

### 마이그레이션 경로

**ws를 wss로 변경하려면**:
```typescript
// 현재
export const KIS_WS_URL = "ws://ops.koreainvestment.com:21000";

// 변경 후
export const KIS_WS_URL = "wss://ops.koreainvestment.com:21000";
```

KIS가 wss 지원을 제공할 시 수정 가능

---

## 의존성 유지보수 전략

### 버전 고정 정책

**package.json 현재 설정**
```json
{
  "dependencies": {
    "@elgato/streamdeck": "^1.1.0",
    "ws": "^8.18.0"
  }
}
```

**정책**: Caret (^) 범위 사용
- 주 버전(1, 8) 고정
- 부 버전, 패치 자동 업그레이드
- 이점: 보안 패치 자동 적용
- 주의: 부 버전 변경 시 호환성 테스트 필요

### 정기 검사

**월 1회 권장**:
```bash
npm outdated          # 업데이트 가능한 패키지 확인
npm audit             # 취약점 확인
npm update            # 안전한 업데이트 적용
git commit -am "chore: update dependencies"
```

### 주 버전 업그레이드 가이드

**@elgato/streamdeck 2.0.0+ 검토**:
- API 변경 확인
- DomesticStockAction, OverseasStockAction 수정 필요 가능

**ws 9.0.0+ 검토**:
- WebSocket API 호환성 확인
- 메시지 처리 로직 재검증 필요

---

## 의존성 크기 분석

### 번들 크기 추정

| 의존성 | 크기 (KB) | 비고 |
|--------|----------|------|
| @elgato/streamdeck | ~50 | 최소 SDK |
| ws | ~100 | WebSocket 구현 |
| **합계** | **~150** | 압축 후 ~50KB |

### 최적화 기회

1. **ws 대체 검토**: 브라우저 내장 WebSocket 사용 가능한가?
   - Stream Deck 플러그인은 Node.js 환경 → ws 필수

2. **Tree-shaking**: rollup이 자동으로 처리
   - 사용되지 않는 코드 제거

3. **동적 로딩**: 현재 필요 없음 (총 크기 작음)

---

## 의존성 문서화

### 각 의존성의 문서화 위치

| 의존성 | 공식 문서 | 주요 참고점 |
|--------|---------|-----------|
| @elgato/streamdeck | npm 패키지 페이지 | SingletonAction, WillAppearEvent 타입 |
| ws | https://github.com/websockets/ws | WebSocket API, 이벤트 처리 |
| typescript | https://www.typescriptlang.org | 컴파일러 옵션, 타입 시스템 |

### 플러그인 내 의존성 사용 예시

**kis/websocket-manager.ts**에서 ws 사용:
```typescript
import WebSocket from "ws";

this.ws = new WebSocket(KIS_WS_URL);
this.ws.on('open', () => { /* ... */ });
this.ws.send(JSON.stringify(message));
```

**plugin.ts**에서 @elgato/streamdeck 사용:
```typescript
import streamDeck, { LogLevel } from "@elgato/streamdeck";

streamDeck.logger.setLevel(LogLevel.DEBUG);
streamDeck.actions.registerAction(new DomesticStockAction());
```

