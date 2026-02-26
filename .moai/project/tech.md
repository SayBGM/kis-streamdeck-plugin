# KIS StreamDeck Plugin - Tech Stack and Development Environment

## Tech Stack Overview

```text
Runtime
  - Node.js 20 (LTS, full ESM support)
  - npm 10.x (package management)

Language and Build
  - TypeScript 5.7.0 (strict mode)
  - Rollup 4.28.0 (bundling)
  - ECMAScript Modules (ESM)

Core Framework
  - @elgato/streamdeck 1.1.0
    - Plugin lifecycle handling
    - Action registration/execution
    - Property Inspector communication
    - SVG rendering integration

Real-time Data
  - ws 8.18.0
    - KIS Open API WebSocket stream
    - Binary message handling
    - Reconnect logic

Rendering
  - SVG 1.1 (144x144)
  - LRU cache for rendered cards
  - Data URL conversion
```

## Why These Dependencies

### `@elgato/streamdeck@1.1.0`
- Official SDK with stable plugin lifecycle support
- Good TypeScript compatibility
- Lower maintenance cost than custom protocol implementation
- Direct integration with Property Inspector messaging

### `ws@8.18.0`
- Lightweight and stable WebSocket client for Node.js
- Efficient binary payload handling
- Flexible reconnect/error handling model
- Good fit for KIS streaming protocol

### `typescript@5.7.0` (strict)
- Strong compile-time safety for long-lived integrations
- Better editor tooling and refactoring confidence
- Lower runtime regression risk

### `rollup@4.28.0`
- Fast incremental builds in watch mode
- Tree-shaking for smaller plugin output
- Straightforward ESM-oriented configuration

## Development Environment Requirements

### Required Software

#### Node.js 20 LTS
```bash
node --version
npm --version
```

#### TypeScript (project-local recommended)
```bash
npm install
```

#### Git
```bash
git --version
```

### Recommended Tools

#### IDE: Visual Studio Code
Recommended extensions:
- ESLint
- Prettier
- TypeScript tooling extensions

#### Stream Deck Tools
- Stream Deck desktop software
- Optional developer CLI for packaging workflows

### Network Requirements
- KIS Open API HTTPS endpoint access
- KIS WebSocket endpoint access
- npm registry access for dependency install

## Build and Deployment Setup

### Package Scripts
- `npm run build`: production build
- `npm run watch`: incremental watch build
- `npm run distribute`: package output for release

### Typical Workflow

#### 1. Development (watch mode)
```bash
npm run watch
```

#### 2. Local install/test
```bash
npm run build
# then copy plugin bundle into Stream Deck plugins directory
```

#### 3. Production package
```bash
npm run distribute
# creates release zip for distribution
```

## TypeScript Configuration Notes

Key `tsconfig` expectations:
- `strict: true`
- `noImplicitAny: true`
- `strictNullChecks: true`
- ESM-compatible module/target settings

## Performance Considerations

### Build-Time
- Keep plugin entrypoints small and tree-shakeable
- Prefer module boundaries that avoid broad recompile impact

### Runtime
- Reuse singleton network clients
- Avoid unnecessary re-render calls
- Cache SVG output where semantically equivalent

## Troubleshooting

### Build Failures
```bash
node --version
rm -rf node_modules package-lock.json
npm install
npm run build
```

### TypeScript Errors
```bash
npm run build
# validate tsconfig and type declarations
```

### Stream Deck Plugin Load Issues
- Verify plugin path and structure
- Verify `manifest.json`
- Verify generated `bin/plugin.js`
- Restart Stream Deck app if needed

## Next Steps
1. Read `product.md` for user-facing goals.
2. Read `structure.md` for module-level ownership.
3. Follow codemap docs for detailed architecture and flow.
