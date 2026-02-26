# SPEC-PERF-001 Research Notes

## Research Objective

Identify the largest performance and reliability bottlenecks in the current plugin implementation and rank optimization opportunities by impact and risk.

## Method

- Reviewed stream connection lifecycle paths.
- Reviewed fallback behavior and stale-data handling.
- Reviewed renderer caching and update behavior.
- Compared likely bottlenecks by expected cost and frequency.

## Key Findings

### 1. Connection Reliability
- Fixed reconnect delay can create avoidable pressure during repeated failures.
- Approval-key lifecycle should be proactively refreshed to avoid expiry-driven instability.
- Additional heartbeat checks may improve early disconnect detection.

### 2. Rendering Cost
- Rendering-to-image path cost is dominated by repeated encoding and SDK update calls.
- Semantic cache key quality strongly affects effective cache hit ratio.
- Precision mismatches can cause unnecessary redraws.

### 3. Fallback Behavior
- Fallback path is essential for resilience but should be clearly bounded and observable.
- Recovery to stream mode must avoid duplicate subscriptions.

## Bottleneck Ranking (Estimated)

1. Stream Deck image update frequency and IPC overhead
2. Full SVG encode path on cache misses
3. Connection churn under repeated failures
4. Token/approval refresh edge cases
5. Parser/render precision inconsistency

## Risk Matrix

### Connection Risks
- Approval key expires during active usage
- Retry storms under unstable network
- Missing liveness signal for half-open sockets

### Rendering Risks
- Excessive update bursts saturating image updates
- Cache key fragmentation reducing reuse
- Small numeric differences triggering repeated renders

## Optimization Opportunities

### Tier 1 (High impact / low risk)
1. Exponential reconnect backoff + jitter
2. Proactive approval-key refresh
3. Better semantic cache keys

### Tier 2 (Medium impact / medium risk)
4. Debounced image update strategy
5. Client-side heartbeat/liveness checks
6. Increased cache capacity with memory monitoring

### Tier 3 (Lower impact / low risk)
7. Unified numeric precision rules
8. Improved structured diagnostics

## Recommended Implementation Order

1. Reliability hardening (reconnect + approval lifecycle)
2. Cache key and render invalidation tuning
3. Optional image-update debouncing
4. Final observability and stress validation

## Success Signals

- Lower reconnect storm frequency
- Faster return to `LIVE` after failures
- Higher render cache hit rate
- Lower redundant image update volume

## Open Questions

1. What is the best stale threshold per market/session volatility?
2. How aggressive can image debouncing be without hurting UX?
3. What cache size limit is safe on target runtime memory?
