# KIS StreamDeck Real-Time Stock Quotes Plugin - Product Overview

## Project Name and Description

**KIS StreamDeck Real-Time Stock Quotes Plugin**

- Version: 1.1.0
- Author: SayBGM (Gwangmin)
- License: Unspecified

This plugin uses the Korea Investment & Securities (KIS) Open API to show real-time stock quotes on Elgato Stream Deck. It supports both Korean and U.S. markets and displays current price, change rate, volume, and market/session state.

## Target Users

### Primary: Traders and Investors
- Active traders with a KIS account
- Professional investors who need constant quote visibility
- Users who want quick quote checks in multi-monitor setups

### Secondary: Developers and Engineers
- Developers interested in Stream Deck plugin development
- Engineers learning TypeScript/JavaScript WebSocket implementations
- Teams looking for OAuth2 + Open API integration patterns

### Tertiary: Financial Platform Builders
- Organizations building internal stock-monitoring systems
- Teams that need multi-source real-time data handling patterns
- Architects evaluating WebSocket-based streaming designs

## Core Features

### 1. Real-Time Stock Quote Streaming
- **WebSocket streaming** from KIS Open API
- **Korean stocks** parsed from `H0UNCNT0`
- **U.S. stocks** parsed from `HDFSCNT0`
- **Instant updates** when new ticks arrive

### 2. Dual Data Source System
- **Primary:** WebSocket streaming for low latency
- **Fallback:** REST API when streaming data is stale for 20+ seconds
- **State model:** `LIVE`, `BACKUP`, `BROKEN`
- **Automatic recovery** back to streaming once healthy

### 3. Authentication and Token Management
- OAuth2-based authentication
- Automatic token refresh for expiring tokens
- Built-in rate-limit handling
- In-memory token storage only (no file persistence)

### 4. Connection Health Management
- Visual status indicator on SVG cards
- Continuous connection-state tracking (`LIVE`, `BACKUP`, `BROKEN`)
- Automatic reconnect on disconnect
- Stream Deck button updates on state changes

### 5. Market Session Detection
- Korean sessions: PRE / REG / AFT / CLOSED
- U.S. sessions based on Eastern Time (ET)
- DST-aware conversion
- Session label shown on card

### 6. Shared Singleton WebSocket Connection
- One central WebSocket connection shared by all actions
- Lower network overhead and better API-limit usage
- Automatic per-button subscribe/unsubscribe handling
- Memory-efficient subscription lifecycle

### 7. SVG-Based UI Rendering
- Dynamic 144x144 SVG card rendering
- LRU cache for frequent card variants
- Status/session icons in card UI
- Resolution-friendly rendering behavior

### 8. Settings Management
- Global plugin settings shared across actions
- Promise-based waiting for settings initialization
- Per-button settings for symbol/ticker and display labels

## Main Use Cases

### 1. Professional Trading Monitoring
- Watch Korean and U.S. symbols simultaneously
- React faster to sudden market moves
- Track watchlists and portfolios on dedicated keys

### 2. Support for Automated Trading Operations
- Monitor WebSocket/API health in real time
- Detect delayed feeds and failover behavior
- Use session state to gate automation logic

### 3. Education and Technical Learning
- Observe real tick behavior from live feeds
- Study practical WebSocket data pipelines
- Learn OAuth2-based API integration in production-like code

## Integration Requirements

### Required

#### 1. KIS Open API Account and Credentials
- KIS account (individual or corporate)
- Open API access approval
- `app_key` and `app_secret`
- OAuth2 access token issuance

#### 2. Runtime Environment
- Elgato Stream Deck device/software
- macOS or Windows (supported by Stream Deck)
- Stable internet connection

#### 3. Development Environment (for plugin changes)
- Node.js 20+
- TypeScript 5.7.0
- npm or yarn

### Optional

#### 1. Enhanced Features
- Additional broker or market data integrations
- External notification integrations (Slack/Discord)

#### 2. Customization
- Theme and typography customization in SVG
- Extra indicators (e.g., RSI, MACD)

## Technical Architecture

### Architecture Patterns
- Event-driven Singleton pattern for WebSocket lifecycle
- Observer pattern for per-action data distribution

### Core Modules
- `kis/websocket-manager.ts`: central WebSocket lifecycle
- `kis/auth.ts`: OAuth2 token lifecycle
- `kis/rest-price.ts`: REST fallback quote fetch
- `renderer/stock-card.ts`: SVG rendering engine
- `actions/domestic-stock.ts`, `actions/overseas-stock.ts`: action implementations

### Data Flow
```
Stream Deck Button UI
  -> Action Handler
  -> WebSocket Manager
      -> Primary: WebSocket stream
      -> Fallback: REST snapshot when stale
  -> Parser
  -> SVG Card Renderer
  -> Stream Deck Icon Update
```

## Version and License

- Current version: 1.1.0
- Previous version: 1.0.0
- License: Unspecified

## Next Steps

### Developer Quick Start
1. Read `structure.md` to understand module boundaries.
2. Read `tech.md` for stack and setup details.
3. Review `src/plugin.ts` for plugin bootstrap.
4. Study `src/kis/websocket-manager.ts` for core architecture.

### User Quick Start
1. Request KIS Open API credentials.
2. Install the Stream Deck plugin.
3. Add buttons and configure symbols/tickers.
4. Start real-time monitoring.
