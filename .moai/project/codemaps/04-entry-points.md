# Entrypoints and Lifecycle

## Main Entrypoints

### `src/plugin.ts`
- Primary plugin bootstrap
- Stream Deck SDK initialization
- Action registration and global settings setup

### Action Entrypoints
- `actions/domestic-stock.ts`
- `actions/overseas-stock.ts`

These modules handle per-button lifecycle callbacks and route data/render updates.

## Lifecycle Flow

### 1. Plugin Startup
1. Runtime loads plugin bundle.
2. `plugin.ts` initializes SDK context.
3. Action classes are registered.
4. Global settings are loaded.

### 2. Action Appears (`willAppear`)
1. Validate action-level settings.
2. Validate required global credentials.
3. Render initial state/loading card.
4. Fetch snapshot data (REST) for first meaningful render.
5. Register stream subscription for real-time updates.

### 3. Active Operation
1. WebSocket manager receives raw payload.
2. Parser normalizes payload.
3. Action receives callback and updates view model.
4. Renderer generates SVG.
5. Action sends new image to Stream Deck runtime.

### 4. Settings Update (`didReceiveSettings`)
1. Merge/validate new settings.
2. Recompute subscription key if symbol changed.
3. Re-subscribe/unsubscribe as needed.
4. Trigger immediate render refresh.

### 5. Action Disappears (`didDisappear`)
1. Unregister callback/subscription from manager.
2. Clean per-action timers/resources.
3. If no subscriptions remain, manager may close connection.

## KIS Integration Entrypoints

### REST
- Used for initial load and stale-data fallback.
- Requires OAuth access token.

### WebSocket
- Used for continuous real-time updates.
- Requires streaming approval key.
- Managed via singleton WebSocket manager.

## Settings Store Entrypoints

- Global settings: credentials and shared plugin configuration.
- Action settings: symbol/ticker, exchange, label preferences.
- Initialization gate: action flows wait until required settings are available.

## Logging/Observability Entrypoints

- Plugin bootstrap logs
- Connection transition logs
- Subscription lifecycle logs
- Parsing/rendering error logs

## Failure and Recovery Paths

### Stream Failure
- Move state to fallback mode.
- Use REST snapshots.
- Attempt reconnect with backoff strategy.

### Auth Failure
- Trigger token/approval refresh.
- Retry connection/subscription after refresh.

### Invalid Settings
- Render explicit configuration-needed state.
- Do not start live subscription until valid.

## Checklist for Entry/Lifecycle Changes

1. Keep state transitions explicit and logged.
2. Ensure unsubscribe/cleanup always runs.
3. Preserve first-render responsiveness.
4. Verify no duplicate subscription after settings change.
