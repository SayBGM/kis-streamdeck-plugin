# Data Flow

## End-to-End Flow (High Level)

1. Action appears on Stream Deck.
2. Settings are validated (global + action-level).
3. Initial snapshot is loaded through REST.
4. Action subscribes to WebSocket stream.
5. Streaming payload is parsed and normalized.
6. Card renderer generates SVG output.
7. Icon image is pushed to Stream Deck runtime.

## Detailed Flows

### A. Initial Render Flow (REST)
1. Action lifecycle starts (`willAppear`).
2. Required credentials are checked.
3. Access token is requested/cached.
4. REST endpoint returns latest quote snapshot.
5. Normalized stock model is built.
6. Renderer outputs first card image.

Goal:
- Minimize time-to-first-meaningful-visual.

### B. Real-Time Update Flow (WebSocket)
1. Singleton WebSocket manager ensures active connection.
2. Action registers `(TR_ID, tr_key)` subscription.
3. Incoming payload arrives from KIS stream.
4. Parser maps payload to internal typed model.
5. Action receives callback and updates state.
6. Renderer builds updated card SVG.
7. Stream Deck key image is refreshed.

Goal:
- Keep low-latency updates with stable rendering behavior.

### C. Fallback Flow (Stale Detection)
1. No stream update arrives within stale threshold.
2. State transitions to `BACKUP`.
3. REST snapshots are used to keep data visible.
4. Reconnect/subscription recovery continues in background.
5. On successful stream recovery, state returns to `LIVE`.

Goal:
- Preserve usability during intermittent streaming failures.

## Authentication/Token Flow

### Access Token (REST)
- Issue through OAuth2 endpoint.
- Cache in memory with expiry tracking.
- Refresh on expiry or auth failure.

### Approval Key (WebSocket)
- Retrieve before stream connect/subscribe.
- Refresh when expired/invalid.
- Reconnect and re-subscribe after refresh.

## Subscription Routing Flow

1. Action computes unique subscription key.
2. Manager stores callback list for key.
3. Stream message is matched to key.
4. Matching callbacks are invoked.
5. On action removal, callback is detached.

## Parsing and Model Conversion Flow

- Transport payload -> parser module -> typed domain model
- Domain model includes price, delta, percent, volume, timestamp, and state metadata
- Invalid/partial payload handling should fail gracefully and log context

## Rendering Flow

1. Input view model assembled from latest quote + state.
2. Semantic render key computed.
3. LRU cache checked for reusable SVG.
4. Cache miss -> SVG generated and cached.
5. SVG converted to Data URL image.
6. Image sent via SDK update API.

## Concurrency and Deduplication

- In-flight token requests should be coalesced.
- Duplicate subscriptions should not multiply outbound subscribe packets.
- Re-render calls should be suppressed when semantic state does not change.

## Error Propagation Strategy

- Auth errors: refresh tokens and retry path.
- Network errors: reconnect with backoff.
- Parser errors: log payload context and skip invalid frame.
- Render errors: fallback to status card with failure state.

## Observability Signals

- Connection state transitions
- Subscription counts and changes
- Stale/fallback triggers
- Render cache hit/miss trends
- Per-action update latency

## Data Flow Validation Checklist

1. First render appears before steady stream subscription completion.
2. Stale transition activates fallback path correctly.
3. Recovery path returns to `LIVE` without duplicate subscriptions.
4. Action removal cleans callback and resources.
