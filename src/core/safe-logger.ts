import { logger as sdkLogger } from "../utils/logger.js";
import {
  type KisError,
  type SafeMetadata,
  sanitizeMetadata,
} from "./errors.js";

export interface SafeLoggerSink {
  info(value: string): void;
  warn(value: string): void;
  error(value: string): void;
  debug(value: string): void;
}

export interface SafeLogEntry {
  code: KisError["code"];
  scope: KisError["scope"];
  retryable: boolean;
  at: number;
  metadata?: SafeMetadata;
}

function toEntry(
  error: KisError,
  metadata?: Readonly<Record<string, unknown>>,
): SafeLogEntry {
  const safeMetadata = sanitizeMetadata({
    ...error.metadata,
    ...metadata,
  });
  return {
    code: error.code,
    scope: error.scope,
    retryable: error.retryable,
    at: error.at,
    ...(Object.keys(safeMetadata).length > 0 ? { metadata: safeMetadata } : {}),
  };
}

export function createSafeLogger(sink: SafeLoggerSink) {
  return {
    info: (error: KisError, metadata?: Readonly<Record<string, unknown>>) =>
      sink.info(JSON.stringify(toEntry(error, metadata))),
    warn: (error: KisError, metadata?: Readonly<Record<string, unknown>>) =>
      sink.warn(JSON.stringify(toEntry(error, metadata))),
    error: (error: KisError, metadata?: Readonly<Record<string, unknown>>) =>
      sink.error(JSON.stringify(toEntry(error, metadata))),
    debug: (error: KisError, metadata?: Readonly<Record<string, unknown>>) =>
      sink.debug(JSON.stringify(toEntry(error, metadata))),
  };
}

export const safeLogger = createSafeLogger(sdkLogger);
