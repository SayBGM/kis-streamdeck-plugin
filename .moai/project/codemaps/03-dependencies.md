# Dependency Analysis

## External Dependencies

### Production Dependencies

#### `@elgato/streamdeck@1.1.0`
Role:
- Official runtime SDK for Stream Deck plugin lifecycle and action wiring.

Key usage areas:
- Plugin bootstrap and registration
- Action event handling (`willAppear`, `didDisappear`, etc.)
- Property Inspector communication

Risk profile:
- Low to medium (SDK version changes may require migration work)

#### `ws@8.18.0`
Role:
- Node.js WebSocket client for KIS real-time feeds.

Key usage areas:
- Socket connection management
- Message receive/send handling
- Error/close/reconnect flow

Risk profile:
- Medium (real-time reliability and reconnect behavior are critical)

### Development Dependencies

#### `typescript@5.7.0`
- Strict typing and compile-time safety.

#### `rollup@4.28.0`
- ESM-oriented bundling and output generation.

#### `@rollup/plugin-typescript`, `@rollup/plugin-node-resolve`
- TS transpile integration and module resolution.

#### `@types/ws`, `tslib`
- Type declarations and runtime helpers.

## Internal Module Dependencies

### High-Level Dependency Tree
```text
plugin.ts
  -> actions/domestic-stock.ts
  -> actions/overseas-stock.ts
      -> kis/websocket-manager.ts
      -> kis/rest-price.ts
      -> kis/auth.ts
      -> renderer/stock-card.ts
      -> utils/*
      -> types/index.ts
```

### Layered Dependency Model
1. Entry layer: `plugin.ts`
2. Action layer: `actions/*`
3. Integration layer: `kis/*`
4. Presentation layer: `renderer/*`
5. Shared contracts/utilities: `types/*`, `utils/*`

## Circular Dependency Check

Status:
- No intentional circular dependency design.
- Module boundaries are mostly directional from entry/action -> integration -> helpers.

Operational recommendation:
- Keep parser modules stateless.
- Keep renderer isolated from transport/auth logic.

## Version Compatibility

### `@elgato/streamdeck@1.1.0`
- Compatible with Node.js/TypeScript setup in this project.
- Validate against SDK release notes before major upgrades.

### `ws@8.18.0`
- Compatible with Node.js 20 runtime.
- Validate reconnect behavior after upgrades.

### Compatibility Matrix (summary)
- Node.js 20 + TypeScript 5.7 + Rollup 4 + SDK 1.1 + ws 8.18: expected-compatible baseline.

## License Review

### Production Dependencies
- `@elgato/streamdeck`: check upstream license terms before distribution changes.
- `ws`: permissive OSS license (verify exact package metadata in lockfile).

### Development Dependencies
- Mostly permissive OSS tooling licenses.
- Keep a periodic lockfile/license audit in CI.

## Security Considerations

### Known Vulnerability Handling
- Run dependency audits regularly.
- Review vulnerable transitive dependencies before release.

### Security Recommendations
- Pin and review lockfile updates.
- Prefer minimal production dependency surface.
- Avoid exposing credentials in logs/config exports.

### Migration Path Guidance
- Test major dependency upgrades in a dedicated branch.
- Validate runtime behavior under reconnect/failure scenarios.

## Maintenance Strategy

### Version Pinning Policy
- Pin production-critical libs.
- Upgrade intentionally with changelog review.

### Routine Checks
- Monthly dependency review.
- Pre-release audit (`npm audit`, lockfile diff).

### Major Upgrade Checklist
1. Read changelog and breaking changes.
2. Update dependency and lockfile.
3. Run build and local Stream Deck smoke tests.
4. Validate WebSocket reconnect and fallback paths.
5. Update architecture docs if behavior changes.

## Dependency Size Notes

### Bundle Size Focus
- Keep transport/auth/render boundaries clean to maximize tree-shaking.
- Avoid adding broad utility frameworks for small tasks.

### Optimization Opportunities
- Review SVG/render helper imports for dead-code elimination.
- Reduce duplicate formatting/parsing helpers across action modules.

## Documentation Mapping

### Where Each Dependency Is Used
- `@elgato/streamdeck`: plugin entry and action classes
- `ws`: WebSocket manager/integration layer
- `typescript`, `rollup`: build and development workflow

### In-Plugin Usage Examples
- See `src/plugin.ts` for SDK lifecycle integration.
- See `src/kis/websocket-manager.ts` for `ws` usage patterns.
