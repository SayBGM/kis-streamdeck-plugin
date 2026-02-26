# KIS StreamDeck Plugin Architecture Overview

## Project Overview

The plugin displays real-time Korean and U.S. stock quotes on Stream Deck keys using KIS Open API. The architecture favors low-latency streaming, controlled failover, and shared connection management.

## Architecture Patterns

### 1. Singleton + Observer
- A singleton WebSocket manager owns the physical socket lifecycle.
- Actions subscribe/unsubscribe by symbol-specific keys.
- Updates are delivered through callback-style observer registration.

### 2. Dual Data Source
- Primary source: WebSocket streaming feed.
- Secondary source: REST snapshot fallback when stream becomes stale.
- State transitions: `LIVE` -> `BACKUP` -> `BROKEN`.

### 3. Timezone-Aware Session Logic
- Korean market sessions are interpreted in KST.
- U.S. market sessions are interpreted in ET with DST awareness.
- Session labels are reflected in rendering state.

### 4. Settings Propagation
- Global credentials live in plugin-level settings.
- Action-level settings store symbol/ticker-specific configuration.
- Runtime waits for required settings before live operations.

## System Boundaries

### External Systems
- KIS Open API (OAuth2 + REST + WebSocket)
- Stream Deck runtime and SDK layer

### Internal Systems
- `plugin.ts`: application bootstrap and action registration
- `actions/*`: action lifecycle orchestration
- `kis/*`: auth, stream, parser, and fallback API modules
- `renderer/*`: SVG generation and cache
- `types/*`, `utils/*`: shared contracts and helpers

## Key Design Decisions (ADRs)

### 1. Shared WebSocket vs per-action sockets
A singleton connection was selected to reduce network overhead and avoid excessive connection churn.

### 2. Token Caching + Global Settings
OAuth tokens and approval metadata are centrally managed to prevent repeated authentication bursts.

### 3. WebSocket + REST Hybrid
Fallback REST quote retrieval keeps the UI usable when streaming is delayed or unavailable.

### 4. Session-aware Subscription Keying
Subscription routing reflects market/session differences for domestic and overseas symbols.

## Structural View

### Layer Model
1. Presentation (`renderer` + Stream Deck button UI)
2. Application (`actions`, lifecycle orchestration)
3. Integration (`kis` clients and parsers)
4. Infrastructure (`types`, `utils`, settings)

### Communication Flow
1. Action appears on device.
2. Settings are validated.
3. Initial data is loaded.
4. Streaming subscription starts.
5. Parser transforms incoming payload.
6. Renderer updates SVG image.

## Performance Considerations

### Memory
- LRU cache for repeated card states
- Shared stream state to avoid duplicate in-memory socket structures

### Network
- Centralized subscriptions minimize redundant connections
- REST fallback only when stream freshness degrades

### Responsiveness
- Immediate first render with snapshot + stream takeover
- Controlled update cadence to avoid unnecessary icon churn

## Security Considerations

### Credentials
- Keep credentials and access tokens out of persisted plaintext files
- Restrict logging of sensitive fields

### API Compliance
- Respect KIS authentication and request policies
- Handle token expiry and reconnect paths explicitly

## Extensibility

### New Action Types
- Add action settings schema
- Implement lifecycle action class
- Reuse existing stream manager where possible

### New Settings
- Extend global/action settings contracts
- Preserve backward compatibility for existing keys

### Cache Strategy Enhancements
- Expand semantic cache keys
- Tune capacity and eviction policy by usage profile

## Glossary
- `TR_ID`: KIS transaction ID defining payload schema.
- `tr_key`: Symbol/subscription key routed through stream manager.
- `Approval Key`: WebSocket authorization credential.
- `Access Token`: OAuth2 token for REST API calls.
- `LIVE/BACKUP/BROKEN`: Connection/data-source state model.
