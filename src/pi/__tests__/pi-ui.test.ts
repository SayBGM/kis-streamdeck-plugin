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

function responseSnapshot() {
  return {
    schemaVersion: 2,
    settingsRevision: 4,
    credentialsConfigured: true,
    maskedAppKey: "ABC••••XYZ",
    preferences: {
      dataMode: "automatic",
      renderIntervalMs: 2_000,
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
      recentErrors: { events: [], counters: {} },
    },
  };
}

function snapshotAt(revision: number) {
  return { ...responseSnapshot(), settingsRevision: revision };
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

  it("labels the existing render throttle as a screen refresh limit", () => {
    const { document } = createUi();

    expect(document.body.textContent).toContain("화면 갱신 제한");
    expect(document.body.textContent).not.toContain("렌더 간격");
    const select = document.getElementById("renderIntervalMs") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "2000",
      "5000",
      "10000",
    ]);
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
    (document.getElementById("renderIntervalMs") as unknown as { value: string }).value = "10000";
    (document.getElementById("backupPollIntervalMs") as unknown as { value: string }).value = "60000";
    document.getElementById("savePreferencesButton")?.dispatchEvent(new window.Event("click"));
    expect(commands.at(-1)).toMatchObject({
      type: "preferences/save",
      settingsRevision: 4,
      preferences: {
        dataMode: "rest-only",
        renderIntervalMs: 10_000,
        backupPollIntervalMs: 60_000,
      },
    });
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

  it("advances only the revision on a token diagnostics tick so a dirty preference save succeeds", () => {
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
