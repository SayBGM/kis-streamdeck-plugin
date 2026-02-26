# KIS StreamDeck 플러그인 - 기술 스택 및 개발 환경

## 기술 스택 개요

```
Runtime Environment
  └─ Node.js 20 (LTS, ESM 완전 지원)
      └─ npm 10.x (패키지 관리)

Language & Tooling
  └─ TypeScript 5.7.0 (Strict Mode)
      ├─ Rollup 4.28.0 (번들링)
      └─ ESM 모듈 (ECMAScript Modules)

Core Frameworks
  └─ @elgato/streamdeck 1.1.0 (Stream Deck SDK)
      ├─ 플러그인 생명주기 관리
      ├─ Action 등록 및 실행
      ├─ Property Inspector 통신
      └─ SVG 렌더링 지원

Real-Time Data
  └─ ws 8.18.0 (WebSocket 클라이언트)
      ├─ KIS Open API 스트리밍 연결
      ├─ 이진 데이터 처리
      └─ 자동 재연결 로직

UI Rendering
  └─ SVG 1.1 (144x144 픽셀)
      ├─ 동적 차트 생성
      ├─ LRU 캐싱
      └─ Data URL 변환
```

## 주요 의존성 선택 근거

### @elgato/streamdeck 1.1.0 (Stream Deck SDK)

**선택 이유:**
- 공식 Stream Deck 플러그인 SDK
- 타입 안전성 (TypeScript 지원)
- 자동 생명주기 관리 (willAppear, didDisappear 등)
- Property Inspector와의 자동 통신 처리

**핵심 기능:**
```
주요 클래스:
  - StreamDeck: 플러그인 메인 클래스
  - Action: 액션 기본 클래스 (domestic-stock, overseas-stock 상속)
  - SingletonAction: Singleton 패턴 지원

주요 이벤트:
  - willAppear: 버튼이 화면에 표시될 때
  - didDisappear: 버튼이 화면에서 사라질 때
  - didReceiveSettings: 설정 변경 시
  - sendToPlugin: Property Inspector에서 메시지 수신
```

**대안 검토:**
- 공식 SDK 없이 직접 구현: 복잡도 증가, 유지보수 어려움
- 다른 SDK(streamdeck-cli 등): 커뮤니티 운영, 지원 부족

### ws 8.18.0 (WebSocket 클라이언트)

**선택 이유:**
- 가볍고 빠른 WebSocket 구현
- Node.js 표준 라이브러리와의 호환성
- 이진 데이터(Buffer) 처리 최적화
- 자동 재연결 지원 가능

**핵심 기능:**
```
주요 메서드:
  - new WebSocket(url): 연결 생성
  - on('message'): 메시지 수신 이벤트
  - on('error'): 에러 처리
  - on('close'): 연결 종료 이벤트
  - send(data): 메시지 전송

특징:
  - 동기적 에러 처리 (try-catch 가능)
  - Buffer 객체 직접 처리 (KIS API 이진 데이터)
  - 메모리 효율적 (최소 의존성)
```

**사용 패턴:**
- KIS Open API WebSocket 연결 (`wss://hts.koreainvestment.com:21443`)
- 실시간 주식 데이터 수신 (H0UNCNT0, HDFSCNT0)
- 구독/구독 해제 메시지 전송

**대안 검토:**
- SockJS: 폴백 지원 필요하지 않음 (Web-only 환경이 아님)
- Socket.io: 과도한 기능, 불필요한 의존성 증가
- native WebSocket API: Node.js 20에서 지원하지만 ws가 더 안정적

### TypeScript 5.7.0 (Strict Mode)

**선택 이유:**
- 타입 안전성: 런타임 에러 사전 방지
- IDE 자동완성: 개발 생산성 향상
- 유지보수성: 코드 의도 명확화
- 대규모 프로젝트 대비

**Strict Mode 설정:**
```
tsconfig.json 주요 옵션:
  - strict: true (모든 엄격한 검사 활성화)
  - noImplicitAny: true (암시적 any 금지)
  - strictNullChecks: true (null/undefined 검사)
  - strictFunctionTypes: true (함수 타입 검사)
  - strictBindCallApply: true (bind/call/apply 검사)
```

**타입 예시:**
```typescript
// StockData 타입 정의 (types/index.ts)
interface StockData {
  code: string;           // 종목 코드
  name: string;           // 종목명
  price: number;          // 현재가
  changePercent: number;  // 변동률 (%)
  volume: number;         // 거래량
  timestamp: number;      // 데이터 시간
}

// WebSocket 메시지 타입
interface WebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'data';
  data: Buffer | StockData;
}
```

### Rollup 4.28.0 (번들러)

**선택 이유:**
- 가벼운 번들링: 플러그인 파일 크기 최소화
- ESM 최적화: 트리 쉐이킹으로 불필요한 코드 제거
- 빠른 빌드: 개발 속도 향상
- Stream Deck과의 호환성

**빌드 과정:**
```
src/plugin.ts (진입점)
  ├─ src/actions/*.ts
  ├─ src/kis/*.ts
  ├─ src/renderer/*.ts
  └─ src/utils/*.ts
         ↓ (TypeScript 컴파일)
       JavaScript
         ↓ (의존성 포함)
       Bundled Code
         ↓ (트리 쉐이킹)
       Optimized Code
         ↓
       bin/plugin.js (최종 산물)
```

**rollup.config.js 핵심 설정:**
```javascript
export default {
  input: 'src/plugin.ts',
  output: {
    file: 'bin/plugin.js',
    format: 'esm'  // ESM 포맷 (Stream Deck 호환)
  },
  external: [
    '@elgato/streamdeck',  // 외부 라이브러리
    'ws'
  ]
};
```

**빌드 성능:**
- Clean build: ~2-3초
- Watch mode (incremental): ~100-500ms
- 번들 크기: ~50-100KB (gzip 압축 포함)

**대안 검토:**
- webpack: 설정 복잡도 높음, 플러그인에는 과도함
- esbuild: 빠르지만 ESM 최적화 부족
- tsc 직접 사용: 번들링 불가, 의존성 관리 어려움

## 개발 환경 요구사항

### 필수 소프트웨어

#### Node.js 20 LTS
```bash
# 설치 확인
node --version  # v20.x.x 이상
npm --version   # 10.x.x 이상
```

**왜 Node.js 20인가:**
- ESM 모듈 완전 지원 (네이티브)
- TypeScript 최신 문법 지원
- ws 라이브러리 최신 버전 호환성
- LTS 버전으로 장기 지원 보장

#### TypeScript 5.7.0
```bash
# 전역 설치 (선택)
npm install -g typescript@5.7.0

# 또는 프로젝트 로컬 설치 (권장)
npm install
```

#### Git (버전 관리)
```bash
git --version  # 2.x.x 이상
```

### 개발 도구

#### 추천 IDE: Visual Studio Code
```json
// .vscode/settings.json 권장 설정
{
  "typescript.tsdk": "node_modules/typescript/lib",
  "typescript.enablePromptUseWorkspaceTsdk": true,
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  }
}
```

**권장 확장:**
- ESLint: 코드 품질 검사
- Prettier: 자동 포맷팅
- TypeScript Vue Plugin: TypeScript 지원 강화
- Stream Deck Extension (비공식): 플러그인 개발 지원

#### Stream Deck 공식 도구
```bash
# Stream Deck Software (필수)
# https://www.elgato.com/stream-deck

# Stream Deck SDK 설치 (통합 개발)
npm install -D @elgato/streamdeck-dev-cli
```

### 네트워크 요구사항

#### 외부 API 접근
- **KIS Open API 서버**: `api.koreainvestment.com` (HTTPS 443)
- **KIS WebSocket**: `wts.koreainvestment.com` (TLS 21443)
- **npm Registry**: `https://registry.npmjs.org` (의존성 설치)
- **GitHub API**: `https://api.github.com` (리포지토리 작업)

#### 로컬 네트워크
- **Stream Deck Device**: USB 연결 또는 네트워크 연결
- **개발 서버**: localhost:3000+ (로컬 테스트)

## 빌드 및 배포 설정

### 빌드 스크립트

**package.json의 주요 스크립트:**

```json
{
  "scripts": {
    "build": "rollup -c",                    // 프로덕션 빌드
    "watch": "rollup -c -w",                 // 개발 모드 (감시 모드)
    "local:install": "npm run build && cp -r bin/* ~/Library/Application\\ Support/Elgato/StreamDeck/Plugins/com.kis.streamdeck.sdPlugin/bin/",
    "package:plugin": "npm run build && mkdir -p release && zip -r release/com.kis.streamdeck.sdPlugin.zip bin/ ui/ manifest.json",
    "release:patch": "npm version patch",    // 패치 버전 업데이트 (1.1.0 → 1.1.1)
    "release:minor": "npm version minor",    // 마이너 버전 업데이트 (1.1.0 → 1.2.0)
    "release:major": "npm version major"     // 메이저 버전 업데이트 (1.1.0 → 2.0.0)
  }
}
```

### 빌드 워크플로우

#### 1. 개발 중 (Watch Mode)
```bash
npm run watch
# Rollup이 파일 변경을 감시하고 자동 재빌드
# bin/plugin.js가 실시간 업데이트됨
```

#### 2. 로컬 테스트 설치
```bash
npm run local:install
# 빌드 + Stream Deck 플러그인 디렉토리에 복사
# macOS: ~/Library/Application Support/Elgato/StreamDeck/Plugins/
# Windows: %APPDATA%\Elgato\StreamDeck\Plugins\
```

#### 3. 프로덕션 배포
```bash
npm run package:plugin
# release/com.kis.streamdeck.sdPlugin.zip 생성
# 이 파일을 Stream Deck Marketplace에 제출
```

#### 4. 버전 관리
```bash
npm run release:patch   # 버그 수정 배포
npm run release:minor   # 새 기능 배포
npm run release:major   # 주요 변경 배포
# package.json과 git 태그 자동 업데이트
```

### 배포 구조

```
플러그인 패키지 구조:
com.kis.streamdeck.sdPlugin/
├── bin/
│   └── plugin.js              # 번들된 플러그인 (필수)
├── ui/
│   ├── domestic-stock-pi.html
│   ├── overseas-stock-pi.html
│   ├── sdpi.js
│   └── sdpi.css
├── manifest.json              # 플러그인 메타데이터 (필수)
├── imgs/                       # 플러그인 아이콘 (선택)
│   ├── action-icon.png
│   └── plugin-icon.png
└── README.md
```

## GitHub Actions CI/CD 파이프라인

### 예상 워크플로우 (선택 사항)

```yaml
name: Build and Test
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: plugin-build
          path: bin/
```

## 개발 워크플로우

### 1단계: 환경 설정
```bash
# 저장소 클론
git clone https://github.com/SayBGM/kis-streamdeck.git
cd com.kis.streamdeck.sdPlugin

# 의존성 설치
npm install

# TypeScript 컴파일러 확인
npx tsc --version  # 5.7.0 이상
```

### 2단계: 개발 시작
```bash
# Watch 모드로 실시간 빌드
npm run watch

# 다른 터미널에서: 로컬에 설치
npm run local:install

# Stream Deck 앱 열어서 테스트
```

### 3단계: 코드 수정 및 테스트
```bash
# src/ 디렉토리의 파일 수정
# → 자동으로 bin/plugin.js 재생성
# → Stream Deck에서 플러그인 자동 리로드

# 버튼 테스트:
# 1. Stream Deck에서 "국내 주식" 또는 "미국 주식" 액션 추가
# 2. 종목 코드 입력 (예: 005930, AAPL)
# 3. API 키 설정
# 4. 실시간 시세 확인
```

### 4단계: 커밋 및 릴리즈
```bash
# 변경사항 커밋
git add .
git commit -m "feat: 새로운 기능 추가"

# 버전 업데이트 및 태그 생성
npm run release:patch   # 버그 수정
npm run release:minor   # 새 기능
npm run release:major   # 주요 변경

# 원격 저장소에 푸시
git push origin main --tags
```

## TypeScript 설정 상세

### tsconfig.json 주요 설정

```json
{
  "compilerOptions": {
    "target": "ES2020",              // Node.js 20 지원
    "module": "ESNext",              // ESM 모듈 출력
    "lib": ["ES2020"],               // 최신 JavaScript 라이브러리
    "strict": true,                  // 모든 엄격한 검사 활성화
    "esModuleInterop": true,         // CommonJS/ESM 호환성
    "skipLibCheck": true,            // 라이브러리 타입 검사 생략 (빌드 속도)
    "forceConsistentCasingInFileNames": true,  // 파일명 대소문자 일관성
    "declaration": true,             // .d.ts 선언 파일 생성
    "outDir": "./dist",              // 컴파일 출력 디렉토리
    "rootDir": "./src",              // 소스 루트
    "resolveJsonModule": true,       // JSON 파일 import 허용
    "moduleResolution": "node"       // Node.js 모듈 해석
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "bin"]
}
```

## 성능 최적화

### 번들 크기 최적화
```javascript
// rollup.config.js에서 외부 라이브러리 제외
external: [
  '@elgato/streamdeck',  // Stream Deck이 제공
  'ws'                   // Node.js 환경에 포함
]
```

### 런타임 최적화
```typescript
// 1. Singleton 패턴으로 불필요한 인스턴스 생성 제거
class WebSocketManager {
  private static instance: WebSocketManager;
  static getInstance() {
    if (!this.instance) {
      this.instance = new WebSocketManager();
    }
    return this.instance;
  }
}

// 2. LRU 캐싱으로 SVG 재렌더링 방지
class StockCardRenderer {
  private cache = new LRUCache<string, string>(100);  // 최대 100개 항목

  render(stockData: StockData): string {
    const key = `${stockData.code}:${stockData.price}`;
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    // ... SVG 생성 로직
    this.cache.set(key, svg);
    return svg;
  }
}

// 3. WebSocket 이진 데이터 효율적 처리
ws.on('message', (data: Buffer) => {
  // Buffer를 직접 파싱 (String 변환 불필요)
  const parser = new DomesticStockParser();
  const stockData = parser.parse(data);
  // ...
});
```

## 문제 해결 가이드

### 빌드 실패
```bash
# 1. Node.js 버전 확인
node --version  # v20.x.x 이상이어야 함

# 2. 의존성 재설치
rm -rf node_modules package-lock.json
npm install

# 3. 캐시 초기화
npm cache clean --force

# 4. 빌드 재시도
npm run build
```

### TypeScript 컴파일 에러
```bash
# 1. tsconfig.json 검증
npx tsc --noEmit  # 컴파일 없이 검사만 수행

# 2. 타입 정의 파일 확인
npm ls @types/*  # 설치된 타입 패키지 확인

# 3. VSCode 재로드
# Cmd+Shift+P → "TypeScript: Restart TS Server"
```

### Stream Deck 플러그인 로드 실패
```bash
# 1. 플러그인 경로 확인
# macOS: ~/Library/Application Support/Elgato/StreamDeck/Plugins/com.kis.streamdeck.sdPlugin/
# Windows: %APPDATA%\Elgato\StreamDeck\Plugins\com.kis.streamdeck.sdPlugin\

# 2. bin/plugin.js 존재 확인
ls -la bin/plugin.js

# 3. manifest.json 확인
cat manifest.json | grep -E '"uuid"|"version"'

# 4. Stream Deck 재시작
pkill "Stream Deck"  # macOS/Linux
```

## 다음 단계

1. **로컬 개발 시작**: `npm install` → `npm run watch`
2. **첫 번째 빌드**: `npm run build`
3. **로컬 테스트**: `npm run local:install` → Stream Deck에서 플러그인 로드
4. **기능 개발**: src/ 디렉토리의 파일 수정
5. **배포**: `npm run release:patch/minor/major` → `npm run package:plugin`
