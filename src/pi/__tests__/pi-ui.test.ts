import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

const UI_ROOT = resolve(process.cwd(), "ui");

function readUi(file: string): string {
  return readFileSync(resolve(UI_ROOT, file), "utf8");
}

function createUi() {
  const window = new Window({ url: "http://localhost/" });
  window.document.body.innerHTML = '<div id="piRoot"></div>';
  const commands: unknown[] = [];
  const actionSettings: unknown[] = [];
  Object.assign(window, {
    sendToPlugin: vi.fn((command: unknown) => commands.push(command)),
    setSettings: vi.fn((settings: unknown) => actionSettings.push(settings)),
  });
  window.eval(readUi("stock-pi-shared.js"));
  const api = (window as unknown as {
    KISStockPI: { bootstrap(config: unknown): unknown };
  }).KISStockPI;
  api.bootstrap({
    actionTitle: "국내주식 설정",
    fields: [
      { id: "stockCode", label: "종목코드", serialize: (value: string) => value.trim() },
      { id: "stockName", label: "종목명", serialize: (value: string) => value.trim() },
    ],
  });
  return { window, document: window.document, commands, actionSettings };
}

function withSafeSnapshotContainers<
  T extends { preferences: object; diagnostics: object },
>(snapshot: T): T {
  const cloneData = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(cloneData);
    if (value && typeof value === "object") {
      const copy = Object.create(null) as Record<string, unknown>;
      for (const [key, nested] of Object.entries(value)) copy[key] = cloneData(nested);
      return copy;
    }
    return value;
  };
  return cloneData(snapshot) as T;
}

function inPiRealm<T>(window: Window, value: T): T {
  const parse = window.eval("JSON.parse") as (json: string) => T;
  return parse(JSON.stringify(value));
}

function withUnsafePreferencePrototype<T extends ReturnType<typeof responseSnapshot>>(
  snapshot: T,
): T {
  return Object.assign(Object.create(null), snapshot, {
    preferences: Object.assign(
      Object.create({ inheritedPreference: true }),
      snapshot.preferences,
    ),
  }) as T;
}

function withUnsafeSnapshotAccessor<T extends ReturnType<typeof responseSnapshot>>(
  snapshot: T,
): T {
  const unsafeSnapshot = Object.assign(Object.create(null), snapshot) as T;
  Object.defineProperty(unsafeSnapshot, "schemaVersion", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("unsafe snapshot accessor must not execute");
    },
  });
  return unsafeSnapshot;
}

function responseSnapshot() {
  return withSafeSnapshotContainers({
    schemaVersion: 2,
    settingsRevision: 4,
    credentialsConfigured: true,
    maskedAppKey: "ABC••••XYZ",
    preferences: {
      dataMode: "automatic",
      uiUpdateMode: "realtime",
      renderIntervalMs: 700,
      backupPollIntervalMs: 30_000,
    },
    diagnostics: {
      auth: { configured: true, credentialGeneration: 2, tokenExpiresAt: 1234 },
      websocket: {
        state: "open",
        demand: 1,
        heartbeatPending: false,
        reconnectAttempts: 0,
      },
      subscriptions: {
        total: 1,
        states: { live: 1 },
        queuedControls: 0,
        rotationActive: false,
        rotationQueued: 0,
      },
      restBackup: {
        queuedRequests: 0,
        sharedRequests: 0,
        activeTransports: 0,
        cacheEntries: 1,
        startsInRateWindow: 0,
        failures: 0,
      },
      render: {
        uiUpdateMode: "realtime",
        configuredIntervalMs: 700,
        effectiveIntervalMs: 50,
        activeTargets: 1,
        queuedTargets: 0,
        submitted: 1,
        coalesced: 0,
        renders: 1,
        commits: 1,
        semanticSkips: 0,
        imageSkips: 0,
        supersededSkips: 0,
        staleDrops: 0,
        failures: 0,
        cacheEntries: 1,
      },
    },
  });
}

function snapshotAt(revision: number) {
  return withSafeSnapshotContainers({ ...responseSnapshot(), settingsRevision: revision });
}

function snapshotWithPreferenceChanges(
  settingsRevision: number,
  preferences: Partial<ReturnType<typeof responseSnapshot>["preferences"]>,
) {
  const snapshot = responseSnapshot();
  return withSafeSnapshotContainers({
    ...snapshot,
    settingsRevision,
    preferences: {
      ...snapshot.preferences,
      ...preferences,
    },
  });
}

function snapshotWithRenderPreferences(
  uiUpdateMode: "realtime" | "throttled",
  renderIntervalMs: number,
  settingsRevision = 4,
) {
  return snapshotWithPreferenceChanges(settingsRevision, {
    uiUpdateMode,
    renderIntervalMs,
  });
}

function snapshotWithCredentialChanges(
  settingsRevision: number,
  credentialsConfigured: boolean,
  maskedAppKey: string,
) {
  return withSafeSnapshotContainers({
    ...responseSnapshot(),
    settingsRevision,
    credentialsConfigured,
    maskedAppKey,
  });
}

describe("Property Inspector UI", () => {
  it("uses command messages and contains no direct global-settings SDK commands", () => {
    const helper = readUi("sdpi.js");
    const shared = readUi("stock-pi-shared.js");

    expect(helper).not.toMatch(/getGlobalSettings|setGlobalSettings/);
    expect(shared).not.toMatch(/getGlobalSettings|setGlobalSettings/);
    expect(helper).toContain('event: "sendToPlugin"');
    expect(shared).toContain('sendCommand("settings/request"');
    expect(shared).toContain('sendCommand("credentials/save"');
    expect(shared).toContain('sendCommand("preferences/save"');
    expect(shared).toContain('sendCommand("diagnostics/request"');
    expect(shared).toContain('sendCommand("auth/retry"');
    expect(shared).toContain('sendCommand("ws/reconnect"');
    expect(shared).toContain('sendCommand("quote/refresh"');
  });

  it("renders sections in the required order with folded advanced settings", () => {
    const { document } = createUi();
    const sections = [...document.querySelectorAll("[data-section]")]
      .map((node) => node.getAttribute("data-section"));

    expect(sections).toEqual([
      "stock-settings",
      "connection-status",
      "credentials",
      "advanced-settings",
      "diagnostics",
    ]);
    expect(document.querySelector("details[data-section='advanced-settings']")?.hasAttribute("open"))
      .toBe(false);
  });

  it("renders global render mode and throttled interval controls", () => {
    const { document } = createUi();

    expect(document.body.textContent).toContain("화면 반영 방식");
    expect(document.body.textContent).toContain("스로틀 간격(ms)");
    expect(document.body.textContent).toContain("모든 국내/미국 주식 버튼에 전역 적용");
    const mode = document.getElementById("uiUpdateMode") as unknown as {
      options: ArrayLike<{ value: string }>;
    };
    expect(Array.from(mode.options).map((option) => ({
      value: option.value,
      label: (option as unknown as { textContent: string }).textContent,
    }))).toEqual([
      { value: "realtime", label: "실시간 (50ms 최신값 병합)" },
      { value: "throttled", label: "스로틀링" },
    ]);
    const interval = document.getElementById("renderIntervalMs");
    expect(interval?.getAttribute("type")).toBe("number");
    expect(interval?.getAttribute("min")).toBe("500");
    expect(interval?.getAttribute("max")).toBe("1000");
    expect(interval?.getAttribute("step")).toBe("100");
  });

  it("hydrates render preferences and synchronizes interval disabled state", () => {
    const { window, document } = createUi();
    const mode = document.getElementById("uiUpdateMode") as unknown as {
      value: string;
    };
    const interval = document.getElementById("renderIntervalMs") as unknown as {
      value: string;
      disabled: boolean;
    };

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "realtime", ok: true, snapshot: snapshotWithRenderPreferences("realtime", 700) },
    }));
    expect(mode.value).toBe("realtime");
    expect(interval.value).toBe("700");
    expect(interval.disabled).toBe(true);

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "throttled", ok: true, snapshot: snapshotWithRenderPreferences("throttled", 900, 5) },
    }));
    expect(mode.value).toBe("throttled");
    expect(interval.value).toBe("900");
    expect(interval.disabled).toBe(false);
  });

  it("preserves the throttled interval while render mode toggles round-trip", () => {
    const { window, document } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotWithRenderPreferences("throttled", 700) },
    }));
    const mode = document.getElementById("uiUpdateMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    const interval = document.getElementById("renderIntervalMs") as unknown as {
      value: string;
      disabled: boolean;
      dispatchEvent(event: unknown): boolean;
    };
    interval.value = "900";
    interval.dispatchEvent(new window.Event("input"));

    mode.value = "realtime";
    mode.dispatchEvent(new window.Event("change"));
    expect(interval.disabled).toBe(true);
    expect(interval.value).toBe("900");

    mode.value = "throttled";
    mode.dispatchEvent(new window.Event("change"));
    expect(interval.disabled).toBe(false);
    expect(interval.value).toBe("900");
  });

  it("never fills secret inputs and saves action settings with schemaVersion 2", async () => {
    const { window, document, actionSettings } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "r1", ok: true, snapshot: responseSnapshot() },
    }));

    expect((document.getElementById("appSecret") as unknown as { value: string }).value).toBe("");
    expect(document.getElementById("maskedAppKey")?.textContent).toContain("ABC••••XYZ");

    document.dispatchEvent(new window.CustomEvent("piDidReceiveSettings", {
      detail: { stockCode: "005930", stockName: "삼성전자" },
    }));
    const stockName = document.getElementById("stockName") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    stockName.value = "삼성전자 우";
    stockName.dispatchEvent(new window.Event("input"));
    await new Promise((resolve) => window.setTimeout(resolve, 400));

    expect(actionSettings.at(-1)).toMatchObject({
      schemaVersion: 2,
      stockCode: "005930",
      stockName: "삼성전자 우",
    });
  });

  it("requests settings on connect and sends revision-fenced credential/preferences commands", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidConnect"));
    expect(commands.at(-1)).toMatchObject({ type: "settings/request", requestId: expect.any(String) });

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "r1", ok: true, snapshot: responseSnapshot() },
    }));
    (document.getElementById("appKey") as unknown as { value: string }).value = "NEWKEY";
    (document.getElementById("appSecret") as unknown as { value: string }).value = "new-secret";
    document.getElementById("saveCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "credentials/save",
      appKey: "NEWKEY",
      appSecret: "new-secret",
      settingsRevision: 4,
    });

    (document.getElementById("dataMode") as unknown as { value: string }).value = "rest-only";
    (document.getElementById("uiUpdateMode") as unknown as { value: string }).value = "throttled";
    (document.getElementById("renderIntervalMs") as unknown as { value: string }).value = "900";
    (document.getElementById("backupPollIntervalMs") as unknown as { value: string }).value = "60000";
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 4,
      preferences: {
        dataMode: "rest-only",
        uiUpdateMode: "throttled",
        renderIntervalMs: 900,
        backupPollIntervalMs: 60_000,
      },
    });
  });

  it("preserves a valid throttled interval in realtime preference payloads", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotWithRenderPreferences("realtime", 700) },
    }));

    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));

    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      preferences: {
        uiUpdateMode: "realtime",
        renderIntervalMs: 700,
      },
    });
  });

  it.each(["", "499", "550", "1100", "700.5"])(
    "rejects invalid throttled interval %p without sending a command",
    (invalidValue) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotWithRenderPreferences("realtime", 700) },
      }));
      const interval = document.getElementById("renderIntervalMs") as unknown as { value: string };
      interval.value = invalidValue;
      const commandCount = commands.length;

      document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));

      expect(commands).toHaveLength(commandCount);
      expect(document.getElementById("advancedStatusMessage")?.textContent).toContain("스로틀 간격");
      expect(document.getElementById("advancedStatusMessage")?.className).toContain("error");
    },
  );

  it("protects interval input edits from settings pushes", () => {
    const { window, document } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotWithRenderPreferences("throttled", 700) },
    }));
    const interval = document.getElementById("renderIntervalMs") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    interval.value = "900";
    interval.dispatchEvent(new window.Event("input"));

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "settings/update", snapshot: snapshotWithRenderPreferences("throttled", 600, 5) },
    }));

    expect(interval.value).toBe("900");
  });

  it("protects render mode changes from settings pushes and keeps disabled state synchronized", () => {
    const { window, document } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotWithRenderPreferences("realtime", 700) },
    }));
    const mode = document.getElementById("uiUpdateMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    const interval = document.getElementById("renderIntervalMs") as unknown as { disabled: boolean };
    mode.value = "throttled";
    mode.dispatchEvent(new window.Event("change"));

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "settings/update", snapshot: snapshotWithRenderPreferences("realtime", 600, 5) },
    }));

    expect(mode.value).toBe("throttled");
    expect(interval.disabled).toBe(false);
  });

  it("correlates out-of-order acknowledgements to the correct section", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: responseSnapshot() },
    }));
    (document.getElementById("appKey") as unknown as { value: string }).value = "NEWKEY";
    document.getElementById("saveCredentialsButton")?.dispatchEvent(new window.Event("click"));
    const credentialRequest = commands.at(-1) as { requestId: string };
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    const preferenceRequest = commands.at(-1) as { requestId: string };

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: preferenceRequest.requestId, ok: true, snapshot: responseSnapshot() },
    }));
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: credentialRequest.requestId,
        ok: false,
        error: { safeMessage: "최신 설정과 충돌했습니다." },
      },
    }));

    expect(document.getElementById("advancedStatusMessage")?.textContent).toContain("적용");
    expect(document.getElementById("credentialStatusMessage")?.textContent).toContain("충돌");
  });

  it.each(["accessor", "custom-prototype", "missing"] as const)(
    "preserves dirty preferences after a successful %s-snapshot acknowledgement",
    (snapshotKind) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const dataMode = document.getElementById("dataMode") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      const uiUpdateMode = document.getElementById("uiUpdateMode") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      const interval = document.getElementById("renderIntervalMs") as unknown as {
        value: string;
        disabled: boolean;
        dispatchEvent(event: unknown): boolean;
      };
      dataMode.value = "rest-only";
      dataMode.dispatchEvent(new window.Event("change"));
      uiUpdateMode.value = "throttled";
      uiUpdateMode.dispatchEvent(new window.Event("change"));
      interval.value = "900";
      interval.dispatchEvent(new window.Event("input"));
      document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
      const request = commands.at(-1) as { requestId: string };
      const acknowledgement: Record<string, unknown> = {
        requestId: request.requestId,
        ok: true,
      };
      if (snapshotKind === "accessor") {
        acknowledgement.snapshot = withUnsafeSnapshotAccessor(snapshotAt(5));
      } else if (snapshotKind === "custom-prototype") {
        acknowledgement.snapshot = withUnsafePreferencePrototype(snapshotAt(5));
      }

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: acknowledgement,
      }));
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "settings/update", snapshot: snapshotAt(6) },
      }));

      expect(dataMode.value).toBe("rest-only");
      expect(uiUpdateMode.value).toBe("throttled");
      expect(interval).toMatchObject({ value: "900", disabled: false });
    },
  );

  it("resets dirty preferences after a successful safe-snapshot acknowledgement", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const dataMode = document.getElementById("dataMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    const uiUpdateMode = document.getElementById("uiUpdateMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    const interval = document.getElementById("renderIntervalMs") as unknown as {
      value: string;
      disabled: boolean;
      dispatchEvent(event: unknown): boolean;
    };
    dataMode.value = "rest-only";
    dataMode.dispatchEvent(new window.Event("change"));
    uiUpdateMode.value = "throttled";
    uiUpdateMode.dispatchEvent(new window.Event("change"));
    interval.value = "900";
    interval.dispatchEvent(new window.Event("input"));
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    const request = commands.at(-1) as { requestId: string };

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: request.requestId,
        ok: true,
        snapshot: snapshotWithPreferenceChanges(5, {
          dataMode: "rest-only",
          uiUpdateMode: "throttled",
          renderIntervalMs: 900,
        }),
      },
    }));
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "settings/update", snapshot: snapshotAt(6) },
    }));

    expect(dataMode.value).toBe("automatic");
    expect(uiUpdateMode.value).toBe("realtime");
    expect(interval).toMatchObject({ value: "700", disabled: true });
  });

  it.each([
    ["save", "accessor"],
    ["save", "custom-prototype"],
    ["save", "missing"],
    ["clear", "accessor"],
    ["clear", "custom-prototype"],
    ["clear", "missing"],
  ] as const)(
    "preserves dirty credentials after %s succeeds with a %s snapshot",
    (commandType, snapshotKind) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const key = document.getElementById("appKey") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      const secret = document.getElementById("appSecret") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      key.value = "LOCALKEY";
      key.dispatchEvent(new window.Event("input"));
      secret.value = "local-secret";
      secret.dispatchEvent(new window.Event("input"));
      document.getElementById(
        commandType === "save" ? "saveCredentialsButton" : "clearCredentialsButton",
      )?.dispatchEvent(new window.Event("click"));
      const request = commands.at(-1) as { requestId: string };
      const acknowledgement: Record<string, unknown> = {
        requestId: request.requestId,
        ok: true,
      };
      if (snapshotKind === "accessor") {
        acknowledgement.snapshot = withUnsafeSnapshotAccessor(snapshotAt(5));
      } else if (snapshotKind === "custom-prototype") {
        acknowledgement.snapshot = withUnsafePreferencePrototype(snapshotAt(5));
      }

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: acknowledgement,
      }));
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "settings/update", snapshot: snapshotAt(6) },
      }));

      expect(key.value).toBe("LOCALKEY");
      expect(secret.value).toBe("local-secret");
    },
  );

  it.each(["save", "clear"] as const)(
    "resets dirty credentials after %s succeeds with a safe snapshot",
    (commandType) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const key = document.getElementById("appKey") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      const secret = document.getElementById("appSecret") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      key.value = "LOCALKEY";
      key.dispatchEvent(new window.Event("input"));
      secret.value = "local-secret";
      secret.dispatchEvent(new window.Event("input"));
      document.getElementById(
        commandType === "save" ? "saveCredentialsButton" : "clearCredentialsButton",
      )?.dispatchEvent(new window.Event("click"));
      const request = commands.at(-1) as { requestId: string };

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: request.requestId, ok: true, snapshot: snapshotAt(5) },
      }));
      expect(secret.value).toBe("");
      secret.value = "stale-without-input-event";
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "settings/update", snapshot: snapshotAt(6) },
      }));

      expect(secret.value).toBe("");
    },
  );

  it.each(["same-submitted", "remote-later-diff"] as const)(
    "reconciles preferences from a newer %s snapshot after an older success acknowledgement",
    (newerSnapshotKind) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const dataMode = document.getElementById("dataMode") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      const uiUpdateMode = document.getElementById("uiUpdateMode") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      const interval = document.getElementById("renderIntervalMs") as unknown as {
        value: string;
        disabled: boolean;
        dispatchEvent(event: unknown): boolean;
      };
      const backup = document.getElementById("backupPollIntervalMs") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      dataMode.value = "rest-only";
      dataMode.dispatchEvent(new window.Event("change"));
      uiUpdateMode.value = "throttled";
      uiUpdateMode.dispatchEvent(new window.Event("change"));
      interval.value = "900";
      interval.dispatchEvent(new window.Event("input"));
      backup.value = "60000";
      backup.dispatchEvent(new window.Event("change"));
      document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
      const request = commands.at(-1) as { requestId: string };
      const submittedPreferences = {
        dataMode: "rest-only" as const,
        uiUpdateMode: "throttled" as const,
        renderIntervalMs: 900,
        backupPollIntervalMs: 60_000,
      };
      const newerPreferences = newerSnapshotKind === "same-submitted"
        ? submittedPreferences
        : {
            dataMode: "automatic" as const,
            uiUpdateMode: "realtime" as const,
            renderIntervalMs: 800,
            backupPollIntervalMs: 15_000,
          };

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: {
          type: "diagnostics/update",
          snapshot: snapshotWithPreferenceChanges(6, newerPreferences),
        },
      }));
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: {
          requestId: request.requestId,
          ok: true,
          snapshot: snapshotWithPreferenceChanges(5, submittedPreferences),
        },
      }));

      expect(dataMode.value).toBe(newerPreferences.dataMode);
      expect(uiUpdateMode.value).toBe(newerPreferences.uiUpdateMode);
      expect(interval).toMatchObject({
        value: String(newerPreferences.renderIntervalMs),
        disabled: newerPreferences.uiUpdateMode === "realtime",
      });
      expect(backup.value).toBe(String(newerPreferences.backupPollIntervalMs));

      const sameRevisionFollowUp = snapshotWithPreferenceChanges(6, {
        ...newerPreferences,
        backupPollIntervalMs: 30_000,
      });
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "settings/update", snapshot: sameRevisionFollowUp },
      }));
      expect(backup.value).toBe("30000");
      document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "preferences/save",
        settingsRevision: 6,
        preferences: { backupPollIntervalMs: 30_000 },
      });
    },
  );

  it("reconciles credentials from a newer snapshot after an older success acknowledgement", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const key = document.getElementById("appKey") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    const secret = document.getElementById("appSecret") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    key.value = "LOCALKEY";
    key.dispatchEvent(new window.Event("input"));
    secret.value = "local-secret";
    secret.dispatchEvent(new window.Event("input"));
    document.getElementById("saveCredentialsButton")?.dispatchEvent(new window.Event("click"));
    const request = commands.at(-1) as { requestId: string };

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        type: "diagnostics/update",
        snapshot: snapshotWithCredentialChanges(6, true, "REV6••••KEY"),
      },
    }));
    expect(secret.value).toBe("local-secret");
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: request.requestId,
        ok: true,
        snapshot: snapshotWithCredentialChanges(5, true, "REV5••••KEY"),
      },
    }));

    expect(secret.value).toBe("");
    expect(document.getElementById("maskedAppKey")?.textContent).toBe("REV6••••KEY");
    secret.value = "stale-without-input-event";
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        type: "settings/update",
        snapshot: snapshotWithCredentialChanges(6, true, "REV6••••KEY"),
      },
    }));
    expect(secret.value).toBe("");
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "credentials/clear",
      settingsRevision: 6,
    });
  });

  it("keeps a pending preference request after an unsafe acknowledgement and accepts a later safe one", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const dataMode = document.getElementById("dataMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    dataMode.value = "rest-only";
    dataMode.dispatchEvent(new window.Event("change"));
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    const request = commands.at(-1) as { requestId: string };
    const statusBefore = document.getElementById("advancedStatusMessage")?.textContent;

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: request.requestId,
        ok: true,
        snapshot: withUnsafeSnapshotAccessor(snapshotAt(5)),
      },
    }));
    expect(document.getElementById("advancedStatusMessage")?.textContent).toBe(statusBefore);
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: request.requestId,
        ok: true,
        snapshot: snapshotWithPreferenceChanges(5, { dataMode: "rest-only" }),
      },
    }));
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        type: "settings/update",
        snapshot: snapshotWithPreferenceChanges(6, { dataMode: "automatic" }),
      },
    }));

    expect(dataMode.value).toBe("automatic");
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 6,
    });
  });

  it("does not reset dirty preferences when a safe success acknowledgement mismatches the submission", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const dataMode = document.getElementById("dataMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    dataMode.value = "rest-only";
    dataMode.dispatchEvent(new window.Event("change"));
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    const request = commands.at(-1) as { requestId: string };

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: request.requestId,
        ok: true,
        snapshot: snapshotWithPreferenceChanges(5, {
          dataMode: "automatic",
          uiUpdateMode: "throttled",
          renderIntervalMs: 800,
        }),
      },
    }));
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        type: "settings/update",
        snapshot: snapshotWithPreferenceChanges(6, { dataMode: "automatic" }),
      },
    }));

    expect(dataMode.value).toBe("rest-only");
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 6,
      preferences: { dataMode: "rest-only" },
    });
  });

  it("preserves dirty secret and preference inputs during diagnostics pushes and stale acks", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: responseSnapshot() },
    }));
    const secret = document.getElementById("appSecret") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    const mode = document.getElementById("dataMode") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    secret.value = "typing-secret";
    secret.dispatchEvent(new window.Event("input"));
    mode.value = "rest-only";
    mode.dispatchEvent(new window.Event("change"));

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "diagnostics/update", snapshot: responseSnapshot() },
    }));
    expect(secret.value).toBe("typing-secret");
    expect(mode.value).toBe("rest-only");

    (document.getElementById("appKey") as unknown as { value: string }).value = "KEY";
    document.getElementById("saveCredentialsButton")?.dispatchEvent(new window.Event("click"));
    const oldRequest = commands.at(-1) as { requestId: string };
    secret.value = "newer-secret";
    secret.dispatchEvent(new window.Event("input"));
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: oldRequest.requestId, ok: true, snapshot: responseSnapshot() },
    }));
    expect(secret.value).toBe("newer-secret");
  });

  it("adopts remotely changed preferences from diagnostics when the form is clean", () => {
    const { window, document } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));

    const ordinarySnapshot = inPiRealm(window, snapshotWithPreferenceChanges(5, {
      dataMode: "rest-only",
      uiUpdateMode: "throttled",
      renderIntervalMs: 900,
      backupPollIntervalMs: 60_000,
    }));
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        type: "diagnostics/update",
        snapshot: ordinarySnapshot,
      },
    }));

    expect((document.getElementById("dataMode") as unknown as { value: string }).value)
      .toBe("rest-only");
    expect((document.getElementById("uiUpdateMode") as unknown as { value: string }).value)
      .toBe("throttled");
    expect((document.getElementById("renderIntervalMs") as unknown as {
      value: string;
      disabled: boolean;
    })).toMatchObject({ value: "900", disabled: false });
    expect((document.getElementById("backupPollIntervalMs") as unknown as { value: string }).value)
      .toBe("60000");
  });

  it("accepts null-prototype snapshots and preferences", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const remote = snapshotWithPreferenceChanges(5, {
      dataMode: "rest-only",
      uiUpdateMode: "throttled",
      renderIntervalMs: 900,
      backupPollIntervalMs: 60_000,
    });
    const nullPreferences = Object.assign(Object.create(null), remote.preferences);
    const nullSnapshot = Object.assign(Object.create(null), {
      ...remote,
      preferences: nullPreferences,
    });

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "diagnostics/update", snapshot: nullSnapshot },
    }));

    expect((document.getElementById("dataMode") as unknown as { value: string }).value)
      .toBe("rest-only");
    expect((document.getElementById("renderIntervalMs") as unknown as {
      value: string;
      disabled: boolean;
    })).toMatchObject({ value: "900", disabled: false });
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "credentials/clear",
      settingsRevision: 5,
    });
  });

  it.each(["diagnostics/update", "settings/update"] as const)(
    "rejects custom-prototype preferences from %s snapshots",
    (messageType) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const remote = snapshotWithPreferenceChanges(5, {
        dataMode: "rest-only",
        uiUpdateMode: "throttled",
        renderIntervalMs: 900,
        backupPollIntervalMs: 60_000,
      });
      const customPreferences = Object.assign(
        Object.create({ inheritedPreference: true }),
        remote.preferences,
      );

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: {
          type: messageType,
          snapshot: Object.assign(Object.create(null), remote, {
            preferences: customPreferences,
          }),
        },
      }));

      expect((document.getElementById("dataMode") as unknown as { value: string }).value)
        .toBe("automatic");
      expect((document.getElementById("renderIntervalMs") as unknown as {
        value: string;
        disabled: boolean;
      })).toMatchObject({ value: "700", disabled: true });
      document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "credentials/clear",
        settingsRevision: 4,
      });

      const dataMode = document.getElementById("dataMode") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      dataMode.value = "rest-only";
      dataMode.dispatchEvent(new window.Event("change"));
      document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "preferences/save",
        settingsRevision: 4,
      });
    },
  );

  it.each(["snapshot", "preferences"] as const)(
    "rejects a structurally cloned Object.prototype on %s",
    (target) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const remote = snapshotWithPreferenceChanges(5, {
        dataMode: "rest-only",
        uiUpdateMode: "throttled",
        renderIntervalMs: 900,
        backupPollIntervalMs: 60_000,
      });
      const fakeObjectPrototype = Object.create(null);
      Object.defineProperties(
        fakeObjectPrototype,
        Object.getOwnPropertyDescriptors(Object.prototype),
      );
      const unsafeSnapshot = target === "snapshot"
        ? Object.assign(Object.create(fakeObjectPrototype), remote)
        : Object.assign(Object.create(null), remote, {
            preferences: Object.assign(
              Object.create(fakeObjectPrototype),
              remote.preferences,
            ),
          });

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: unsafeSnapshot },
      }));

      expect((document.getElementById("dataMode") as unknown as { value: string }).value)
        .toBe("automatic");
      expect((document.getElementById("renderIntervalMs") as unknown as { value: string }).value)
        .toBe("700");
      document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "credentials/clear",
        settingsRevision: 4,
      });
    },
  );

  it.each(["schemaVersion", "settingsRevision"] as const)(
    "ignores snapshots with an own %s accessor without executing it",
    (accessorField) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
      const getter = vi.fn(() => accessorField === "schemaVersion" ? 2 : 6);
      const remote = snapshotWithPreferenceChanges(6, {
        dataMode: "rest-only",
        uiUpdateMode: "throttled",
        renderIntervalMs: 900,
        backupPollIntervalMs: 60_000,
      });
      const unsafeSnapshot = withSafeSnapshotContainers({
        ...remote,
        diagnostics: {
          ...remote.diagnostics,
          websocket: { ...remote.diagnostics.websocket, state: "closed" },
        },
      });
      Object.defineProperty(unsafeSnapshot, accessorField, {
        enumerable: true,
        get: getter,
      });

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: unsafeSnapshot },
      }));

      expect(getter).not.toHaveBeenCalled();
      expect((document.getElementById("dataMode") as unknown as { value: string }).value)
        .toBe("automatic");
      expect(document.getElementById("connectionBadge")?.textContent).toBe("open");
      expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
      document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "credentials/clear",
        settingsRevision: 4,
      });
      const dataMode = document.getElementById("dataMode") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      dataMode.value = "rest-only";
      dataMode.dispatchEvent(new window.Event("change"));
      document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "preferences/save",
        settingsRevision: 4,
      });
    },
  );

  it.each(["snapshot", "preferences"] as const)(
    "rejects an unexpected accessor on the %s without executing it",
    (target) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
      const remote = snapshotWithPreferenceChanges(6, {
        dataMode: "rest-only",
        uiUpdateMode: "throttled",
        renderIntervalMs: 900,
      });
      remote.diagnostics.websocket.state = "closed";
      const getter = vi.fn(() => "unexpected");
      Object.defineProperty(target === "snapshot" ? remote : remote.preferences, "unexpected", {
        enumerable: true,
        get: getter,
      });

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: remote },
      }));

      expect(getter).not.toHaveBeenCalled();
      expect((document.getElementById("dataMode") as unknown as { value: string }).value)
        .toBe("automatic");
      expect(document.getElementById("connectionBadge")?.textContent).toBe("open");
      expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
      document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "credentials/clear",
        settingsRevision: 4,
      });
    },
  );

  it.each(["websocket", "websocket.state"] as const)(
    "rejects a diagnostics %s accessor without executing it",
    (target) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
      const remote = snapshotWithPreferenceChanges(6, { dataMode: "rest-only" });
      const originalWebsocket = remote.diagnostics.websocket;
      const getter = vi.fn(() => target === "websocket"
        ? Object.assign(Object.create(null), originalWebsocket, { state: "closed" })
        : "closed");
      if (target === "websocket") {
        Object.defineProperty(remote.diagnostics, "websocket", {
          enumerable: true,
          get: getter,
        });
      } else {
        Object.defineProperty(remote.diagnostics.websocket, "state", {
          enumerable: true,
          get: getter,
        });
      }

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: remote },
      }));

      expect(getter).not.toHaveBeenCalled();
      expect((document.getElementById("dataMode") as unknown as { value: string }).value)
        .toBe("automatic");
      expect(document.getElementById("connectionBadge")?.textContent).toBe("open");
      expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
      document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "credentials/clear",
        settingsRevision: 4,
      });
    },
  );

  it("does not accept a missing schemaVersion through Object.prototype pollution", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
    const remote = snapshotWithPreferenceChanges(6, { dataMode: "rest-only" }) as Record<
      string,
      unknown
    >;
    delete remote.schemaVersion;
    const objectPrototype = window.eval("Object.prototype") as object;
    Object.defineProperty(objectPrototype, "schemaVersion", {
      configurable: true,
      value: { enumerable: true, value: 2 },
    });

    try {
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: remote },
      }));
    } finally {
      delete (objectPrototype as Record<string, unknown>).schemaVersion;
    }

    expect((document.getElementById("dataMode") as unknown as { value: string }).value)
      .toBe("automatic");
    expect(document.getElementById("connectionBadge")?.textContent).toBe("open");
    expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "credentials/clear",
      settingsRevision: 4,
    });
  });

  it("rejects cyclic diagnostics without changing the applied state", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
    const remote = snapshotWithPreferenceChanges(6, { dataMode: "rest-only" });
    (remote.diagnostics as Record<string, unknown>).cycle = remote.diagnostics;

    expect(() => {
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: remote },
      }));
    }).not.toThrow();

    expect((document.getElementById("dataMode") as unknown as { value: string }).value)
      .toBe("automatic");
    expect(document.getElementById("connectionBadge")?.textContent).toBe("open");
    expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "credentials/clear",
      settingsRevision: 4,
    });
  });

  it("accepts PI-realm data arrays and clones them into diagnostics", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const remote = inPiRealm(window, snapshotWithPreferenceChanges(5, {
      dataMode: "rest-only",
    }));
    (remote.diagnostics as Record<string, unknown>).samples = window.eval(
      '[1, {"ok": true}, null]',
    );

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "diagnostics/update", snapshot: remote },
    }));

    expect((document.getElementById("dataMode") as unknown as { value: string }).value)
      .toBe("rest-only");
    expect(document.getElementById("diagnosticsOutput")?.textContent).toContain('"samples"');
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "credentials/clear",
      settingsRevision: 5,
    });
  });

  it.each([
    "symbol",
    "non-enumerable",
    "undefined",
    "non-finite",
    "foreign-array",
    "custom-prototype",
  ] as const)("rejects a diagnostics graph containing %s data", (unsafeKind) => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
    const remote = snapshotWithPreferenceChanges(6, { dataMode: "rest-only" });
    const diagnostics = remote.diagnostics as Record<PropertyKey, unknown>;
    if (unsafeKind === "symbol") {
      diagnostics[Symbol("unsafe")] = "value";
    } else if (unsafeKind === "non-enumerable") {
      Object.defineProperty(diagnostics, "hidden", { value: true });
    } else if (unsafeKind === "undefined") {
      diagnostics.unsafe = undefined;
    } else if (unsafeKind === "non-finite") {
      diagnostics.unsafe = Number.POSITIVE_INFINITY;
    } else if (unsafeKind === "foreign-array") {
      diagnostics.unsafe = [1, 2, 3];
    } else {
      diagnostics.unsafe = Object.assign(Object.create({ inherited: true }), { value: true });
    }

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "diagnostics/update", snapshot: remote },
    }));

    expect((document.getElementById("dataMode") as unknown as { value: string }).value)
      .toBe("automatic");
    expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "credentials/clear",
      settingsRevision: 4,
    });
  });

  it.each(["named-data", "accessor-index", "non-enumerable-index"] as const)(
    "rejects a PI-realm array with a %s descriptor",
    (unsafeKind) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
      const remote = inPiRealm(window, snapshotWithPreferenceChanges(6, {
        dataMode: "rest-only",
      }));
      const values = window.eval("[1, 2]") as unknown[];
      const getter = vi.fn(() => 1);
      if (unsafeKind === "named-data") {
        Object.defineProperty(values, "extra", { enumerable: true, value: 3 });
      } else if (unsafeKind === "accessor-index") {
        Object.defineProperty(values, "0", { enumerable: true, get: getter });
      } else {
        Object.defineProperty(values, "0", { enumerable: false, value: 1 });
      }
      (remote.diagnostics as Record<string, unknown>).samples = values;

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: remote },
      }));

      expect(getter).not.toHaveBeenCalled();
      expect((document.getElementById("dataMode") as unknown as { value: string }).value)
        .toBe("automatic");
      expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
      document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "credentials/clear",
        settingsRevision: 4,
      });
    },
  );

  it("does not apply diagnostics from an unsafe operational acknowledgement snapshot", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const diagnosticsBefore = document.getElementById("diagnosticsOutput")?.textContent;
    document.getElementById("refreshDiagnosticsButton")?.dispatchEvent(new window.Event("click"));
    const request = commands.at(-1) as { requestId: string };
    const safeSnapshot = snapshotAt(5);
    const unsafeSnapshot = withSafeSnapshotContainers({
      ...safeSnapshot,
      diagnostics: {
        ...safeSnapshot.diagnostics,
        websocket: { ...safeSnapshot.diagnostics.websocket, state: "closed" },
      },
    });
    const getter = vi.fn(() => 2);
    Object.defineProperty(unsafeSnapshot, "schemaVersion", {
      enumerable: true,
      get: getter,
    });

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: request.requestId, ok: true, snapshot: unsafeSnapshot },
    }));

    expect(getter).not.toHaveBeenCalled();
    expect(document.getElementById("connectionBadge")?.textContent).toBe("open");
    expect(document.getElementById("diagnosticsOutput")?.textContent).toBe(diagnosticsBefore);
  });

  it.each(["schemaVersion", "settingsRevision"] as const)(
    "rejects snapshots with an inherited %s",
    (inheritedField) => {
      const { window, document, commands } = createUi();
      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
      }));
      const remote = snapshotWithPreferenceChanges(6, {
        dataMode: "rest-only",
        renderIntervalMs: 900,
      });
      const ownFields = { ...remote } as Record<string, unknown>;
      delete ownFields[inheritedField];
      const inheritedSnapshot = Object.assign(
        Object.create({
          [inheritedField]: inheritedField === "schemaVersion" ? 2 : 6,
        }),
        ownFields,
      );

      document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
        detail: { type: "diagnostics/update", snapshot: inheritedSnapshot },
      }));

      expect((document.getElementById("dataMode") as unknown as { value: string }).value)
        .toBe("automatic");
      expect((document.getElementById("renderIntervalMs") as unknown as { value: string }).value)
        .toBe("700");
      document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "credentials/clear",
        settingsRevision: 4,
      });
      const dataMode = document.getElementById("dataMode") as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      dataMode.value = "rest-only";
      dataMode.dispatchEvent(new window.Event("change"));
      document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
      expect(commands.at(-1)).toMatchObject({
        type: "preferences/save",
        settingsRevision: 4,
      });
    },
  );

  it("keeps dirty inputs and the applied preference revision when diagnostics reveal remote changes", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const dataMode = document.getElementById("dataMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    const uiUpdateMode = document.getElementById("uiUpdateMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    const interval = document.getElementById("renderIntervalMs") as unknown as {
      value: string;
      disabled: boolean;
      dispatchEvent(event: unknown): boolean;
    };
    const backup = document.getElementById("backupPollIntervalMs") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    dataMode.value = "rest-only";
    dataMode.dispatchEvent(new window.Event("change"));
    uiUpdateMode.value = "throttled";
    uiUpdateMode.dispatchEvent(new window.Event("change"));
    interval.value = "900";
    interval.dispatchEvent(new window.Event("input"));
    backup.value = "60000";
    backup.dispatchEvent(new window.Event("change"));
    const remoteSnapshot = snapshotWithPreferenceChanges(5, { renderIntervalMs: 800 });

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "diagnostics/update", snapshot: remoteSnapshot },
    }));
    expect(dataMode.value).toBe("rest-only");
    expect(uiUpdateMode.value).toBe("throttled");
    expect(interval).toMatchObject({ value: "900", disabled: false });
    expect(backup.value).toBe("60000");

    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    const firstSave = commands.at(-1) as { requestId: string };
    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 4,
    });

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: firstSave.requestId,
        ok: false,
        error: { safeMessage: "원격 설정과 충돌했습니다." },
        snapshot: remoteSnapshot,
      },
    }));
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));

    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 4,
    });
    expect(dataMode.value).toBe("rest-only");
    expect(interval.value).toBe("900");
    expect(document.getElementById("advancedStatusMessage")?.textContent).toContain("충돌");
  });

  it("does not inspect accessor-backed remote preferences or advance their revision", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const dataMode = document.getElementById("dataMode") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    dataMode.value = "rest-only";
    dataMode.dispatchEvent(new window.Event("change"));
    const getter = vi.fn(() => "automatic");
    const preferences = Object.defineProperty({
      uiUpdateMode: "realtime",
      renderIntervalMs: 700,
      backupPollIntervalMs: 30_000,
    }, "dataMode", {
      enumerable: true,
      get: getter,
    });

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        type: "diagnostics/update",
        snapshot: Object.assign(Object.create(null), snapshotAt(5), { preferences }),
      },
    }));
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));

    expect(commands.at(-1)).toMatchObject({
      type: "credentials/clear",
      settingsRevision: 4,
    });
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));

    expect(getter).not.toHaveBeenCalled();
    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 4,
    });
  });

  it("advances the preference revision on a token diagnostics tick with the same baseline", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const secret = document.getElementById("appSecret") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    const mode = document.getElementById("dataMode") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    secret.value = "dirty-secret";
    secret.dispatchEvent(new window.Event("input"));
    mode.value = "rest-only";
    mode.dispatchEvent(new window.Event("change"));

    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { type: "diagnostics/update", snapshot: snapshotAt(5) },
    }));
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));

    expect(secret.value).toBe("dirty-secret");
    expect(mode.value).toBe("rest-only");
    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 5,
      preferences: { dataMode: "rest-only" },
    });
  });

  it("recovers credential save and clear retries from conflict snapshots without losing dirty input", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const key = document.getElementById("appKey") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    const secret = document.getElementById("appSecret") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    key.value = "NEWKEY";
    key.dispatchEvent(new window.Event("input"));
    secret.value = "dirty-secret";
    secret.dispatchEvent(new window.Event("input"));
    document.getElementById("saveCredentialsButton")?.dispatchEvent(new window.Event("click"));
    const firstSave = commands.at(-1) as { requestId: string };
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: firstSave.requestId,
        ok: false,
        error: { safeMessage: "설정 충돌" },
        snapshot: snapshotAt(5),
      },
    }));

    expect(secret.value).toBe("dirty-secret");
    document.getElementById("saveCredentialsButton")?.dispatchEvent(new window.Event("click"));
    const retrySave = commands.at(-1) as { requestId: string };
    expect(commands.at(-1)).toMatchObject({ type: "credentials/save", settingsRevision: 5 });
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: retrySave.requestId, ok: true, snapshot: snapshotAt(6) },
    }));

    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    const firstClear = commands.at(-1) as { requestId: string };
    expect(commands.at(-1)).toMatchObject({ type: "credentials/clear", settingsRevision: 6 });
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: firstClear.requestId,
        ok: false,
        error: { safeMessage: "설정 충돌" },
        snapshot: snapshotAt(7),
      },
    }));
    document.getElementById("clearCredentialsButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({ type: "credentials/clear", settingsRevision: 7 });
  });

  it("recovers preference retries and ignores an older out-of-order conflict revision", () => {
    const { window, document, commands } = createUi();
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: "initial", ok: true, snapshot: snapshotAt(4) },
    }));
    const mode = document.getElementById("dataMode") as unknown as { value: string; dispatchEvent(event: unknown): boolean };
    mode.value = "rest-only";
    mode.dispatchEvent(new window.Event("change"));
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    const first = commands.at(-1) as { requestId: string };
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: first.requestId,
        ok: false,
        error: { safeMessage: "설정 충돌" },
        snapshot: snapshotAt(5),
      },
    }));
    expect(mode.value).toBe("rest-only");

    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    const second = commands.at(-1) as { requestId: string };
    expect(commands.at(-1)).toMatchObject({ type: "preferences/save", settingsRevision: 5 });
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: { requestId: second.requestId, ok: true, snapshot: snapshotAt(6) },
    }));
    document.dispatchEvent(new window.CustomEvent("piDidReceiveMessage", {
      detail: {
        requestId: first.requestId,
        ok: false,
        error: { safeMessage: "늦은 충돌" },
        snapshot: snapshotAt(5),
      },
    }));

    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({ type: "preferences/save", settingsRevision: 6 });
    expect(document.getElementById("advancedStatusMessage")?.textContent).not.toContain("늦은");
  });

  it("uses an external-only CSP and external configuration scripts", () => {
    for (const file of ["domestic-stock-pi.html", "overseas-stock-pi.html"]) {
      const html = readUi(file);
      expect(html).toContain("Content-Security-Policy");
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(html).not.toMatch(/https?:\/\//i);
    }
  });
});
