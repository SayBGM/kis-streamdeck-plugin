# KIS StreamDeck Plugin Architecture Docs

This directory contains codemap-style architecture documents for the KIS StreamDeck plugin.

## Document Index

1. `01-overview.md` - architecture overview, patterns, and major design choices
2. `02-modules.md` - module responsibilities and interfaces
3. `03-dependencies.md` - external/internal dependency analysis
4. `04-entry-points.md` - entrypoints and lifecycle flow
5. `05-data-flow.md` - end-to-end data flow details

## Recommended Reading Order

### Architecture-first
1. `01-overview.md`
2. `02-modules.md`
3. `03-dependencies.md`

### Implementation-first
4. `04-entry-points.md`
5. `05-data-flow.md`

## Core Concepts

- Singleton WebSocket manager
- Observer-style per-action update delivery
- Dual-source model (WebSocket primary, REST fallback)
- Session/timezone-aware rendering logic

## System Boundary Summary

- External: KIS Open API (REST + WebSocket, OAuth2)
- Internal: plugin/action/integration/render layers under `src/`
- Runtime host: Stream Deck SDK/runtime

## Maintenance Rule

Keep these docs synchronized with code changes in:
- `src/plugin.ts`
- `src/actions/*`
- `src/kis/*`
- `src/renderer/*`

Last updated: 2026-02-26
Author: Architecture Documentation System
