# KIS StreamDeck Plugin - Project Structure

## Directory Layout

```text
com.kis.streamdeck.sdPlugin/
  .moai/
    project/
    specs/
    docs/
    config/
  src/
    plugin.ts
    actions/
    kis/
    renderer/
    types/
    utils/
  ui/
  bin/
  release/
  manifest.json
  package.json
  tsconfig.json
  rollup.config.js
```

## Top-Level Responsibilities

- `.moai/`: project docs, codemaps, specs, and local workflow metadata
- `src/`: plugin source code
- `ui/`: Property Inspector HTML/JS assets
- `bin/`: compiled bundle output
- `release/`: packaged plugin artifacts

## Source Structure

### `src/plugin.ts`
- Plugin entrypoint
- Action registration
- Global settings initialization and propagation

### `src/actions/`
- Action lifecycle handlers for domestic and overseas stocks
- `willAppear` / `didDisappear` orchestration
- Symbol-level subscription management

### `src/kis/`
- `auth.ts`: OAuth2 and approval key management
- `websocket-manager.ts`: singleton stream connection + subscription routing
- `rest-price.ts`: snapshot fallback API calls
- parser modules: payload parsing and normalization

### `src/renderer/`
- SVG card generation
- status visuals and text layout
- render cache / memoization behavior

### `src/types/`
- shared interfaces and domain contracts
- market/connection enums

### `src/utils/`
- time/session helpers
- logging and generic helpers

## Runtime Flow by Module

1. `plugin.ts` boots and registers actions.
2. Action appears and validates settings.
3. Action requests initial snapshot data.
4. Action registers stream subscription through singleton manager.
5. Parser transforms raw payload to domain model.
6. Renderer generates SVG and action updates button icon.

## Design Boundaries

- Actions should not own independent WebSocket clients.
- Renderer should remain independent from auth/network details.
- Parsers should remain stateless.
- Shared types should stay transport-agnostic.

## Testing and Validation Focus

- Connection lifecycle and reconnect behavior
- Fallback switching and stale detection thresholds
- Rendering output consistency and cache hit ratio
- Session/timezone edge cases (KST/ET, DST)

## Maintenance Guidance

- Keep module boundaries strict to avoid circular dependencies.
- Update codemap docs when core flow changes.
- Keep spec docs aligned with delivered behavior.
