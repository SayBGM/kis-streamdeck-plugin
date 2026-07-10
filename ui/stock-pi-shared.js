(function () {
  "use strict";

  var ACTION_SAVE_DEBOUNCE_MS = 350;
  var requestSequence = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function nextRequestId(prefix) {
    requestSequence += 1;
    return prefix + "-" + Date.now() + "-" + requestSequence;
  }

  function command(type, fields) {
    var payload = { type: type, requestId: nextRequestId(type.replace("/", "-")) };
    var key;
    fields = fields || {};
    for (key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) payload[key] = fields[key];
    }
    sendToPlugin(payload);
  }

  function hasValue(value) {
    return value !== undefined && value !== null && value !== "";
  }

  function fieldType(field) {
    return field.type || "text";
  }

  function renderOptions(options) {
    return (options || []).map(function (option) {
      return '<option value="' + escapeHtml(option.value) + '">' +
        escapeHtml(option.label) + "</option>";
    }).join("");
  }

  function renderInput(field) {
    if (fieldType(field) === "select") {
      return '<select id="' + escapeHtml(field.id) + '">' +
        renderOptions(field.options) + "</select>";
    }
    var attributes = [
      'type="' + escapeHtml(fieldType(field)) + '"',
      'id="' + escapeHtml(field.id) + '"',
    ];
    if (field.placeholder) attributes.push('placeholder="' + escapeHtml(field.placeholder) + '"');
    return "<input " + attributes.join(" ") + ">";
  }

  function renderField(field) {
    return [
      '<div class="sdpi-item">',
      '<div class="sdpi-item-label">' + escapeHtml(field.label) + "</div>",
      '<div class="sdpi-item-value">' + renderInput(field) + "</div>",
      "</div>",
      field.errorMessage
        ? '<div id="' + escapeHtml(field.id + "Error") + '" class="sdpi-error">' +
          escapeHtml(field.errorMessage) + "</div>"
        : "",
      field.help ? '<div class="sdpi-help">' + escapeHtml(field.help) + "</div>" : "",
    ].join("");
  }

  function renderFields(fields) {
    return (fields || []).map(renderField).join("");
  }

  function renderLayout(config) {
    return [
      '<div class="sdpi-wrapper">',

      '<section class="sdpi-group" data-section="stock-settings">',
      '<div class="sdpi-group-label"><span>' + escapeHtml(config.actionTitle) + "</span>",
      '<span class="sdpi-badge">현재 버튼만</span></div>',
      '<div class="sdpi-note">유효한 종목 값은 현재 버튼에 자동 저장됩니다.</div>',
      renderFields(config.fields),
      '<div id="actionStatusMessage" class="sdpi-status info"></div>',
      "</section>",

      '<section class="sdpi-group" data-section="connection-status">',
      '<div class="sdpi-group-label"><span>공통 연결 상태</span><span id="connectionBadge" class="sdpi-badge">확인 중</span></div>',
      '<div id="connectionSummary" class="sdpi-note">플러그인 상태를 불러오는 중입니다.</div>',
      "</section>",

      '<section class="sdpi-group" data-section="credentials">',
      '<div class="sdpi-group-label"><span>KIS API 자격증명</span><span class="sdpi-badge">모든 버튼 공통</span></div>',
      '<div id="credentialSummary" class="sdpi-note">저장 상태를 확인 중입니다.</div>',
      '<div class="sdpi-item"><div class="sdpi-item-label">저장된 Key</div>',
      '<div id="maskedAppKey" class="sdpi-item-value sdpi-readonly">설정 안 됨</div></div>',
      '<div class="sdpi-item"><div class="sdpi-item-label">App Key</div>',
      '<div class="sdpi-item-value"><input type="text" id="appKey" autocomplete="off" placeholder="새 App Key 입력"></div></div>',
      '<div class="sdpi-item"><div class="sdpi-item-label">App Secret</div>',
      '<div class="sdpi-item-value"><input type="password" id="appSecret" autocomplete="new-password" placeholder="비워두면 기존 Secret 유지"></div></div>',
      '<div class="sdpi-actions">',
      '<button type="button" id="saveCredentialsButton" class="sdpi-button primary">자격증명 저장</button>',
      '<button type="button" id="clearCredentialsButton" class="sdpi-button">지우기</button>',
      "</div>",
      '<div id="credentialStatusMessage" class="sdpi-status info"></div>',
      "</section>",

      '<details class="sdpi-group" data-section="advanced-settings">',
      '<summary class="sdpi-group-label">고급 설정</summary>',
      '<div class="sdpi-item"><div class="sdpi-item-label">데이터 모드</div><div class="sdpi-item-value">',
      '<select id="dataMode"><option value="automatic">자동 (WebSocket 우선)</option><option value="rest-only">REST 전용</option></select>',
      "</div></div>",
      '<div class="sdpi-item"><div class="sdpi-item-label">렌더 간격</div><div class="sdpi-item-value">',
      '<select id="renderIntervalMs"><option value="2000">2초</option><option value="5000">5초</option><option value="10000">10초</option></select>',
      "</div></div>",
      '<div class="sdpi-item"><div class="sdpi-item-label">백업 폴링</div><div class="sdpi-item-value">',
      '<select id="backupPollIntervalMs"><option value="15000">15초</option><option value="30000">30초</option><option value="60000">60초</option></select>',
      "</div></div>",
      '<div class="sdpi-actions"><button type="button" id="savePreferencesButton" class="sdpi-button primary">고급 설정 저장</button></div>',
      '<div class="sdpi-actions">',
      '<button type="button" id="retryAuthButton" class="sdpi-button">인증 재시도</button>',
      '<button type="button" id="reconnectWsButton" class="sdpi-button">WebSocket 재연결</button>',
      '<button type="button" id="refreshQuoteButton" class="sdpi-button">현재 종목 새로고침</button>',
      "</div>",
      '<div id="advancedStatusMessage" class="sdpi-status info"></div>',
      "</details>",

      '<section class="sdpi-group" data-section="diagnostics">',
      '<div class="sdpi-group-label"><span>상세 진단</span>',
      '<button type="button" id="refreshDiagnosticsButton" class="sdpi-button compact">새로고침</button></div>',
      '<pre id="diagnosticsOutput" class="sdpi-diagnostics">진단을 불러오는 중입니다.</pre>',
      "</section>",
      "</div>",
    ].join("");
  }

  function StockPropertyInspector(config) {
    this.config = config;
    this.settingsRevision = 0;
    this.actionSaveTimer = null;
  }

  StockPropertyInspector.prototype.setStatus = function (id, message, kind) {
    var target = byId(id);
    if (!target) return;
    target.textContent = message || "";
    target.className = "sdpi-status " + (kind || "info") + (message ? " visible" : "");
  };

  StockPropertyInspector.prototype.setFieldValue = function (field, value) {
    var input = byId(field.id);
    var normalized = hasValue(value) ? String(value) : "";
    if (!normalized && hasValue(field.defaultValue)) normalized = String(field.defaultValue);
    if (field.normalizeReceived) normalized = field.normalizeReceived(normalized);
    input.value = normalized;
    if (fieldType(field) === "select" && !input.value && field.options && field.options[0]) {
      input.value = String(field.options[0].value);
    }
  };

  StockPropertyInspector.prototype.validateField = function (field) {
    var value = byId(field.id).value;
    var valid = !field.validate || field.validate(value);
    var error = byId(field.id + "Error");
    if (error) error.style.display = value && !valid ? "block" : "none";
    return valid || (!value && field.allowEmpty !== false);
  };

  StockPropertyInspector.prototype.applyActionSettings = function (settings) {
    var inspector = this;
    (this.config.fields || []).forEach(function (field) {
      inspector.setFieldValue(field, settings && settings[field.settingKey || field.id]);
      inspector.validateField(field);
    });
  };

  StockPropertyInspector.prototype.actionPayload = function () {
    var payload = { schemaVersion: 2 };
    (this.config.fields || []).forEach(function (field) {
      var value = byId(field.id).value;
      payload[field.settingKey || field.id] = field.serialize
        ? field.serialize(value)
        : fieldType(field) === "select" ? value : value.trim();
    });
    return payload;
  };

  StockPropertyInspector.prototype.saveAction = function () {
    var inspector = this;
    var invalid = (this.config.fields || []).find(function (field) {
      return !inspector.validateField(field);
    });
    if (invalid) {
      this.setStatus("actionStatusMessage", invalid.invalidStatusMessage || "입력 값을 확인하세요.", "error");
      return;
    }
    setSettings(this.actionPayload());
    this.setStatus("actionStatusMessage", "현재 버튼 설정이 저장되었습니다.", "success");
  };

  StockPropertyInspector.prototype.queueActionSave = function () {
    var inspector = this;
    if (this.actionSaveTimer) clearTimeout(this.actionSaveTimer);
    this.actionSaveTimer = setTimeout(function () {
      inspector.actionSaveTimer = null;
      inspector.saveAction();
    }, ACTION_SAVE_DEBOUNCE_MS);
  };

  StockPropertyInspector.prototype.applySnapshot = function (snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 2) return;
    this.settingsRevision = snapshot.settingsRevision;
    byId("maskedAppKey").textContent = snapshot.maskedAppKey || "설정 안 됨";
    byId("credentialSummary").textContent = snapshot.credentialsConfigured
      ? "자격증명이 저장되어 있습니다. Secret은 다시 표시하지 않습니다."
      : "자격증명을 입력해야 시세를 조회할 수 있습니다.";
    byId("appSecret").value = "";
    byId("dataMode").value = snapshot.preferences.dataMode;
    byId("renderIntervalMs").value = String(snapshot.preferences.renderIntervalMs);
    byId("backupPollIntervalMs").value = String(snapshot.preferences.backupPollIntervalMs);
    this.applyDiagnostics(snapshot.diagnostics);
  };

  StockPropertyInspector.prototype.applyDiagnostics = function (diagnostics) {
    diagnostics = diagnostics || {};
    var websocket = diagnostics.websocket || {};
    var subscriptions = diagnostics.subscriptions || {};
    var rest = diagnostics.restBackup || {};
    var render = diagnostics.render || {};
    byId("connectionBadge").textContent = websocket.state || "unknown";
    byId("connectionSummary").textContent =
      "WS " + (websocket.state || "unknown") +
      " · 구독 " + (subscriptions.total || 0) +
      " · REST 대기 " + (rest.queuedRequests || 0) +
      " · 렌더 대기 " + (render.queuedTargets || 0);
    byId("diagnosticsOutput").textContent = JSON.stringify(diagnostics, null, 2);
  };

  StockPropertyInspector.prototype.handleMessage = function (message) {
    if (!message || typeof message !== "object") return;
    if (message.snapshot) this.applySnapshot(message.snapshot);
    if (message.type === "diagnostics/update" || message.type === "settings/update") return;
    if (message.ok === false && message.error) {
      this.setStatus("advancedStatusMessage", message.error.safeMessage || "요청을 처리하지 못했습니다.", "error");
    } else if (message.ok === true) {
      this.setStatus("advancedStatusMessage", "요청이 적용되었습니다.", "success");
      byId("appSecret").value = "";
    }
  };

  StockPropertyInspector.prototype.bindEvents = function () {
    var inspector = this;
    document.addEventListener("piDidConnect", function () {
      command("settings/request");
    });
    document.addEventListener("piDidReceiveSettings", function (event) {
      inspector.applyActionSettings(event.detail || {});
    });
    document.addEventListener("piDidReceiveMessage", function (event) {
      inspector.handleMessage(event.detail || {});
    });

    (this.config.fields || []).forEach(function (field) {
      var input = byId(field.id);
      input.addEventListener(field.saveOn || (fieldType(field) === "select" ? "change" : "input"), function () {
        if (field.normalizeInput) this.value = field.normalizeInput(this.value);
        inspector.validateField(field);
        inspector.queueActionSave();
      });
    });

    byId("saveCredentialsButton").addEventListener("click", function () {
      var appKey = byId("appKey").value.trim();
      var appSecret = byId("appSecret").value;
      if (!appKey) {
        inspector.setStatus("credentialStatusMessage", "App Key를 입력하세요.", "error");
        return;
      }
      var fields = { appKey: appKey, settingsRevision: inspector.settingsRevision };
      if (appSecret) fields.appSecret = appSecret;
      command("credentials/save", fields);
      inspector.setStatus("credentialStatusMessage", "자격증명을 저장하는 중입니다.", "info");
    });
    byId("clearCredentialsButton").addEventListener("click", function () {
      command("credentials/clear", { settingsRevision: inspector.settingsRevision });
    });
    byId("savePreferencesButton").addEventListener("click", function () {
      command("preferences/save", {
        settingsRevision: inspector.settingsRevision,
        preferences: {
          dataMode: byId("dataMode").value,
          renderIntervalMs: Number(byId("renderIntervalMs").value),
          backupPollIntervalMs: Number(byId("backupPollIntervalMs").value),
        },
      });
    });
    byId("retryAuthButton").addEventListener("click", function () { command("auth/retry"); });
    byId("reconnectWsButton").addEventListener("click", function () { command("ws/reconnect"); });
    byId("refreshQuoteButton").addEventListener("click", function () { command("quote/refresh"); });
    byId("refreshDiagnosticsButton").addEventListener("click", function () { command("diagnostics/request"); });
  };

  function bootstrap(config) {
    var root = byId(config.rootId || "piRoot");
    if (!root) throw new Error("Property Inspector root element was not found.");
    root.innerHTML = renderLayout(config);
    var inspector = new StockPropertyInspector(config);
    inspector.bindEvents();
    return inspector;
  }

  window.KISStockPI = { bootstrap: bootstrap };
})();
