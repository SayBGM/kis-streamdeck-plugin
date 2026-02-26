# SPEC-PERF-001 Acceptance Criteria

## Purpose

Define objective checks to validate performance and reliability improvements from SPEC-PERF-001.

## Test Scope

- Connection lifecycle and recovery
- Fallback activation and recovery
- Rendering efficiency and cache behavior
- Logging/observability quality

## Acceptance Criteria

### A. Connection Reliability
1. Reconnect uses exponential backoff with jitter.
2. Backoff is capped and reset after successful reconnect.
3. Reconnected session restores subscriptions without duplication.
4. No runaway reconnect loops under repeated failures.

### B. Auth/Approval Stability
1. Approval key refresh works before expiry under active usage.
2. Token/approval refresh requests are deduplicated in-flight.
3. Auth-related errors trigger safe retry/recovery path.
4. Sensitive credential values do not appear in logs.

### C. Fallback and State Transitions
1. Stream staleness triggers `BACKUP` state at configured threshold.
2. REST fallback keeps card data visible during stream degradation.
3. Recovery returns to `LIVE` when stream resumes.
4. `BROKEN` state is only entered when both paths fail.

### D. Rendering Efficiency
1. Semantic cache key prevents redundant render invalidations.
2. Cache hit ratio improves versus pre-change baseline.
3. Equivalent data does not trigger repeated image updates.
4. Rendering remains visually correct across states/sessions.

### E. Observability
1. Logs capture connection transition timeline.
2. Logs capture fallback/recovery events.
3. Error logs include actionable context without leaking secrets.
4. Metrics or counters are available for basic trend analysis.

## Validation Scenarios

### Scenario 1: Normal Operation
- Continuous stream updates with no fallback activation.
- Expected: stable `LIVE` state and smooth card updates.

### Scenario 2: Temporary Stream Outage
- Force socket closure for a short interval.
- Expected: transition to `BACKUP`, then recovery to `LIVE`.

### Scenario 3: Prolonged Outage
- Keep stream unavailable beyond several retries.
- Expected: bounded retries, no infinite tight loop, clear status behavior.

### Scenario 4: Auth Expiry Event
- Simulate expired token/approval key.
- Expected: refresh + recovery without manual intervention.

### Scenario 5: Burst Update Load
- Inject high-frequency quote updates.
- Expected: controlled image update behavior and acceptable responsiveness.

## Exit Decision

The spec is accepted when:
1. All mandatory criteria pass.
2. No critical regressions are found.
3. Remaining issues are documented with mitigation and owner.
