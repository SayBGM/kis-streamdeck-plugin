# SPEC-PERF-001 - Performance and Reliability Improvements

## Objective

Improve real-time rendering responsiveness and connection stability for the KIS StreamDeck plugin while preserving current functional behavior.

## Scope

In scope:
- WebSocket reconnect strategy improvements
- Approval/access token lifecycle robustness
- Render/cache efficiency improvements
- Fallback behavior under stale stream conditions

Out of scope:
- New product features unrelated to reliability/performance
- UI redesign unrelated to performance

## Current Baseline (Observed)

- Primary data source is WebSocket streaming.
- REST fallback activates when stream data is stale.
- Rendering uses SVG with cache support.
- Connection and auth failures can cause temporary instability.

## Functional Requirements

1. The system must keep one shared stream connection for active actions.
2. The system must recover from stream disconnects with bounded retry behavior.
3. The system must continue showing data via fallback path when stream is stale.
4. The system must return to streaming mode after recovery.
5. Rendering must avoid unnecessary repeated updates for semantically identical data.

## Non-Functional Requirements

1. Reconnect policy must reduce server pressure during repeated failures.
2. First meaningful render latency should remain low.
3. Update behavior should remain stable under bursty quote events.
4. State transitions must be observable via logs/metrics.

## Proposed Changes

### Connection Reliability
- Replace fixed reconnect delay with exponential backoff + jitter.
- Add periodic approval key refresh strategy.
- Add optional client-side heartbeat checks for earlier failure detection.

### Rendering Efficiency
- Strengthen semantic cache keys.
- Increase cache capacity where memory budget permits.
- Normalize render precision to reduce avoidable card invalidations.

### Operational Safety
- Improve error classification and logging context.
- Preserve explicit `LIVE/BACKUP/BROKEN` transition rules.

## Acceptance Criteria

1. Reconnect attempts follow bounded exponential schedule.
2. Stream recovery restores subscriptions without duplication.
3. Fallback mode activates when stale threshold is exceeded.
4. Cache hit ratio improves after semantic key update.
5. No credential leakage in logs.

## Risks

- Over-aggressive retries may increase upstream load.
- Cache expansion may increase memory pressure.
- Heartbeat tuning may cause false reconnect triggers.

## Mitigations

- Cap backoff and include jitter.
- Measure memory and adjust cache size incrementally.
- Tune heartbeat thresholds based on observed false-positive rate.

## Rollout Plan

1. Implement reconnect/backoff improvements.
2. Add token/approval refresh hardening.
3. Roll out render/cache optimizations.
4. Validate with staged stress testing.
