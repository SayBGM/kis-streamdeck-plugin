import {
  type KisError,
  type KisErrorCode,
  type KisErrorScope,
  type SafeMetadata,
  sanitizeMetadata,
} from "./errors.js";

export type DiagnosticsCounter =
  | "authFailures"
  | "restFailures"
  | "websocketReconnects"
  | "subscriptionRejects"
  | "settingsFailures"
  | "manualRefreshes";

export interface DiagnosticEvent {
  code: KisErrorCode;
  scope: KisErrorScope;
  retryable: boolean;
  at: number;
  metadata?: SafeMetadata;
}

export interface DiagnosticsSnapshot {
  events: DiagnosticEvent[];
  counters: Partial<Record<DiagnosticsCounter, number>>;
}

export type DiagnosticsListener = (snapshot: DiagnosticsSnapshot) => void;

const MAX_EVENTS = 100;
const DIAGNOSTICS_COUNTERS = new Set<DiagnosticsCounter>([
  "authFailures",
  "restFailures",
  "websocketReconnects",
  "subscriptionRejects",
  "settingsFailures",
  "manualRefreshes",
]);

function cloneSnapshot(snapshot: DiagnosticsSnapshot): DiagnosticsSnapshot {
  return {
    events: snapshot.events.map((event) => ({
      ...event,
      ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
    })),
    counters: { ...snapshot.counters },
  };
}

export class DiagnosticsStore {
  private readonly events: DiagnosticEvent[] = [];
  private readonly counters: Partial<Record<DiagnosticsCounter, number>> = {};
  private readonly listeners = new Set<DiagnosticsListener>();

  record(
    error: KisError,
    metadata?: Readonly<Record<string, unknown>>,
  ): void {
    const safeMetadata = sanitizeMetadata({
      ...error.metadata,
      ...metadata,
    });
    this.events.push({
      code: error.code,
      scope: error.scope,
      retryable: error.retryable,
      at: error.at,
      ...(Object.keys(safeMetadata).length > 0 ? { metadata: safeMetadata } : {}),
    });
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.publish();
  }

  increment(counter: DiagnosticsCounter, amount = 1): void {
    if (!DIAGNOSTICS_COUNTERS.has(counter) || !Number.isFinite(amount)) return;
    this.counters[counter] = (this.counters[counter] ?? 0) + amount;
    this.publish();
  }

  snapshot(): DiagnosticsSnapshot {
    return cloneSnapshot({ events: this.events, counters: this.counters });
  }

  report(): DiagnosticsSnapshot {
    return this.snapshot();
  }

  subscribe(listener: DiagnosticsListener): () => void {
    this.listeners.add(listener);
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: DiagnosticsListener): void {
    this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(cloneSnapshot(snapshot));
      } catch {
        // Diagnostics observers must not break the operation being observed.
      }
    }
  }
}

export const diagnosticsStore = new DiagnosticsStore();
