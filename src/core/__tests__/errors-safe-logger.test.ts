import { describe, expect, it, vi } from "vitest";
import { KisError } from "../errors.js";
import { createSafeLogger } from "../safe-logger.js";

describe("KisError", () => {
  it("keeps only the public error contract and allowlisted metadata", () => {
    const error = new KisError({
      code: "AUTH_REJECTED",
      scope: "auth",
      retryable: false,
      safeMessage: "인증이 거부되었습니다.",
      at: 123,
      metadata: {
        attempt: 2,
        state: "retrying",
        appKey: "very-secret-key",
        rawBody: "server secret body",
        arbitrary: "not allowed",
      },
    });

    expect(error).toEqual({
      code: "AUTH_REJECTED",
      scope: "auth",
      retryable: false,
      safeMessage: "인증이 거부되었습니다.",
      at: 123,
      metadata: { attempt: 2, state: "retrying" },
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("very-secret-key");
    expect(JSON.stringify(error)).not.toContain("server secret body");
  });
});

describe("safe logger", () => {
  it("logs only code, scope, retryable and safe typed metadata", () => {
    const sink = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const logger = createSafeLogger(sink);
    const error = new KisError({
      code: "NETWORK",
      scope: "rest",
      retryable: true,
      safeMessage: "네트워크 오류",
      at: 456,
    });

    logger.error(error, {
      attempt: 3,
      httpStatus: 503,
      state: "degraded",
      appSecret: "secret-value",
      token: "token-value",
      approval: "approval-value",
      fingerprint: "fingerprint-value",
      rawPayload: "raw-value",
    });

    expect(sink.error).toHaveBeenCalledWith(JSON.stringify({
      code: "NETWORK",
      scope: "rest",
      retryable: true,
      at: 456,
      metadata: { attempt: 3, httpStatus: 503, state: "degraded" },
    }));
    const serialized = JSON.stringify(sink.error.mock.calls);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("token-value");
    expect(serialized).not.toContain("approval-value");
    expect(serialized).not.toContain("fingerprint-value");
    expect(serialized).not.toContain("raw-value");
  });
});
