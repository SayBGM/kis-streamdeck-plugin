# Module Structure

## Overview

This document maps major modules in the KIS StreamDeck plugin and describes ownership boundaries, interfaces, and collaboration points.

## Module Inventory

### `plugin.ts`
Responsibilities:
- Initialize Stream Deck SDK integration
- Register actions
- Read and propagate global settings

Public surface:
- plugin bootstrap path
- registration wiring for action classes

### `actions/domestic-stock.ts`
Responsibilities:
- Domestic action lifecycle handling
- Symbol validation and settings reaction
- Subscription registration with stream manager
- Render/update orchestration

### `actions/overseas-stock.ts`
Responsibilities:
- Overseas action lifecycle handling
- Ticker + exchange settings management
- Subscription registration with stream manager
- Render/update orchestration

### `kis/auth.ts`
Responsibilities:
- OAuth2 token issuance/refresh
- Approval key retrieval for streaming
- Cache and retry policy enforcement

### `kis/websocket-manager.ts`
Responsibilities:
- Maintain singleton WebSocket connection
- Handle subscribe/unsubscribe flows
- Dispatch parsed data to action callbacks
- Manage reconnect and connection states

### `kis/rest-price.ts`
Responsibilities:
- Fetch snapshot quotes for initial render/fallback
- Normalize response shape for renderer consumption

### `kis/*-parser.ts`
Responsibilities:
- Parse raw KIS payload schemas
- Convert to internal stock data model

### `renderer/stock-card.ts`
Responsibilities:
- Build SVG card image
- Apply visual states (LIVE/BACKUP/BROKEN)
- Cache render outputs for repeated states

### `types/index.ts`
Responsibilities:
- Shared interfaces and enums
- Stable contracts across modules

### `utils/*`
Responsibilities:
- Timezone/session helpers
- Logging helpers
- Small generic utilities

## Dependency Direction

```text
plugin.ts
  -> actions/*
      -> kis/websocket-manager.ts
      -> kis/rest-price.ts
      -> kis/*-parser.ts
      -> renderer/stock-card.ts
      -> types/index.ts
      -> utils/*
```

Rules:
- Keep transport details inside `kis/*`.
- Keep rendering details inside `renderer/*`.
- Keep shared contracts in `types/*`.

## Interface Notes

- Action modules depend on normalized stock payloads, not raw transport frames.
- Parser modules should return typed, rendering-ready structures.
- WebSocket manager should expose subscription APIs with minimal action coupling.

## Common Change Scenarios

### Add a new action type
1. Add settings/type contract.
2. Implement action lifecycle class.
3. Add parser logic if payload differs.
4. Register action in `plugin.ts`.

### Add a new data source
1. Define source client module.
2. Normalize output to existing stock model.
3. Integrate into fallback/priority policy.
4. Add observability for state transitions.

## Quality Checklist

- No new circular dependencies
- Clear boundary between auth/transport/render logic
- Updated type contracts and codemap docs
- Lifecycle behavior tested (`willAppear`/`didDisappear`)
