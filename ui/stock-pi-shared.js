(function () {
  var CONNECTION_TEST_REQUEST_TYPE = "kis.connectionTest";
  var CONNECTION_TEST_RESULT_TYPE = "kis.connectionTestResult";
  var ACTION_SAVE_DEBOUNCE_MS = 350;
  var DEFAULT_ACTION_BADGE = "현재 버튼만";
  var DEFAULT_ACTION_NOTE =
    "이 섹션은 현재 선택한 버튼에만 저장됩니다. 유효한 값은 입력 후 자동 저장됩니다.";
  var DEFAULT_GLOBAL_NOTE =
    "여기서 저장한 App Key, App Secret, 업데이트 방식은 모든 주식 버튼에 공통 적용됩니다.";

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

  function hasValue(value) {
    return value !== undefined && value !== null && value !== "";
  }

  function getFieldType(field) {
    return field.type || "text";
  }

  function getSelectFallbackValue(field) {
    if (hasValue(field.defaultValue)) {
      return String(field.defaultValue);
    }
    if (field.options && field.options.length > 0) {
      return String(field.options[0].value);
    }
    return "";
  }

  function renderOptions(options) {
    var rendered = [];
    var index;

    for (index = 0; index < options.length; index += 1) {
      rendered.push(
        '<option value="' +
          escapeHtml(options[index].value) +
          '">' +
          escapeHtml(options[index].label) +
          "</option>"
      );
    }

    return rendered.join("");
  }

  function renderInput(field) {
    if (getFieldType(field) === "select") {
      return (
        '<select id="' +
        escapeHtml(field.id) +
        '">' +
        renderOptions(field.options || []) +
        "</select>"
      );
    }

    var attrs = [
      'type="' + escapeHtml(getFieldType(field)) + '"',
      'id="' + escapeHtml(field.id) + '"',
    ];

    if (hasValue(field.placeholder)) {
      attrs.push('placeholder="' + escapeHtml(field.placeholder) + '"');
    }
    if (hasValue(field.min)) {
      attrs.push('min="' + escapeHtml(field.min) + '"');
    }
    if (hasValue(field.max)) {
      attrs.push('max="' + escapeHtml(field.max) + '"');
    }

    return "<input " + attrs.join(" ") + ">";
  }

  function renderField(field) {
    var parts = [
      '<div class="sdpi-item">',
      '<div class="sdpi-item-label">' + escapeHtml(field.label) + "</div>",
      '<div class="sdpi-item-value">',
      renderInput(field),
      "</div>",
      "</div>",
    ];

    if (field.errorMessage) {
      parts.push(
        '<div id="' +
          escapeHtml(field.errorId || field.id + "Error") +
          '" class="sdpi-error">' +
          escapeHtml(field.errorMessage) +
          "</div>"
      );
    }
    if (field.help) {
      parts.push('<div class="sdpi-help">' + escapeHtml(field.help) + "</div>");
    }

    return parts.join("");
  }

  function renderActionFields(fields) {
    var parts = [];
    var index;

    for (index = 0; index < fields.length; index += 1) {
      parts.push(renderField(fields[index]));
    }

    return parts.join("");
  }

  function renderLayout(config) {
    return [
      '<div class="sdpi-wrapper">',
      '<div class="sdpi-group">',
      '<div class="sdpi-group-label">',
      "<span>KIS API 설정</span>",
      '<span class="sdpi-badge">모든 버튼 공통</span>',
      "</div>",
      '<div class="sdpi-note">' + escapeHtml(DEFAULT_GLOBAL_NOTE) + "</div>",
      '<div class="sdpi-item">',
      '<div class="sdpi-item-label">App Key</div>',
      '<div class="sdpi-item-value"><input type="password" id="appKey" placeholder="App Key 입력"></div>',
      "</div>",
      '<div class="sdpi-item">',
      '<div class="sdpi-item-label">App Secret</div>',
      '<div class="sdpi-item-value"><input type="password" id="appSecret" placeholder="App Secret 입력"></div>',
      "</div>",
      '<div class="sdpi-help">한국투자증권 Open API에서 발급받은 키를 입력하세요. 모든 버튼에 공통 적용됩니다.</div>',
      '<div class="sdpi-item">',
      '<div class="sdpi-item-label">업데이트</div>',
      '<div class="sdpi-item-value">',
      '<select id="updateMode">',
      '<option value="websocket">실시간 (WebSocket)</option>',
      '<option value="hybrid">WebSocket + 쓰로틀</option>',
      '<option value="poll">주기적 (폴링)</option>',
      "</select>",
      "</div>",
      "</div>",
      '<div id="pollIntervalRow" class="sdpi-item" style="display:none;">',
      '<div class="sdpi-item-label">간격(초)</div>',
      '<div class="sdpi-item-value"><input type="number" id="pollIntervalSec" min="1" max="3600" placeholder="30"></div>',
      "</div>",
      '<div id="pollIntervalError" class="sdpi-error">1~3600 사이의 숫자를 입력하세요</div>',
      '<div id="throttleMsRow" class="sdpi-item" style="display:none;">',
      '<div class="sdpi-item-label">쓰로틀(ms)</div>',
      '<div class="sdpi-item-value"><input type="number" id="throttleMs" min="200" placeholder="1000"></div>',
      "</div>",
      '<div id="throttleMsError" class="sdpi-error">최솟값은 200ms입니다</div>',
      '<div class="sdpi-actions">',
      '<button type="button" id="saveGlobalButton" class="sdpi-button primary" disabled>공통 설정 저장</button>',
      '<button type="button" id="testConnectionButton" class="sdpi-button secondary">연결 테스트</button>',
      "</div>",
      '<div id="globalStatusMessage" class="sdpi-status info"></div>',
      "</div>",
      '<div class="sdpi-group">',
      '<div class="sdpi-group-label">',
      "<span>" + escapeHtml(config.actionTitle) + "</span>",
      '<span class="sdpi-badge">' +
        escapeHtml(config.actionBadge || DEFAULT_ACTION_BADGE) +
        "</span>",
      "</div>",
      '<div class="sdpi-note">' +
        escapeHtml(config.actionNote || DEFAULT_ACTION_NOTE) +
        "</div>",
      renderActionFields(config.fields || []),
      '<div id="actionStatusMessage" class="sdpi-status info"></div>',
      "</div>",
      "</div>",
    ].join("");
  }

  function StockPropertyInspector(config) {
    this.config = config;
    this.globalDirty = false;
    this.actionSaveTimer = null;
    this.pendingConnectionTestId = null;
    this.actionFieldValidity = {};
  }

  StockPropertyInspector.prototype.setStatus = function (targetId, message, type) {
    var element = byId(targetId);

    if (!message) {
      element.textContent = "";
      element.className = "sdpi-status info";
      return;
    }

    element.textContent = message;
    element.className = "sdpi-status " + type + " visible";
  };

  StockPropertyInspector.prototype.updateModeRows = function (mode) {
    byId("pollIntervalRow").style.display = mode === "poll" ? "flex" : "none";
    byId("throttleMsRow").style.display = mode === "hybrid" ? "flex" : "none";
  };

  StockPropertyInspector.prototype.getGlobalSettingsPayload = function () {
    return {
      appKey: byId("appKey").value.trim(),
      appSecret: byId("appSecret").value.trim(),
      updateMode: byId("updateMode").value,
      pollIntervalSec: byId("pollIntervalSec").value || "30",
      throttleMs: byId("throttleMs").value || "1000",
    };
  };

  StockPropertyInspector.prototype.setGlobalDirty = function (message) {
    this.globalDirty = true;
    this.updateGlobalControls();

    if (message) {
      this.setStatus("globalStatusMessage", message, "info");
    }
  };

  StockPropertyInspector.prototype.validatePollInterval = function (value) {
    var parsed = parseInt(value, 10);
    var isValid = !isNaN(parsed) && parsed >= 1 && parsed <= 3600;

    byId("pollIntervalError").style.display =
      value.length > 0 && !isValid ? "block" : "none";

    return isValid || value.length === 0;
  };

  StockPropertyInspector.prototype.validateThrottleMs = function (value) {
    var parsed = parseInt(value, 10);
    var isValid = !isNaN(parsed) && parsed >= 200;

    byId("throttleMsError").style.display =
      value.length > 0 && !isValid ? "block" : "none";

    return isValid || value.length === 0;
  };

  StockPropertyInspector.prototype.isGlobalSettingsValid = function () {
    var mode = byId("updateMode").value;
    var pollValid =
      mode !== "poll" || this.validatePollInterval(byId("pollIntervalSec").value);
    var throttleValid =
      mode !== "hybrid" || this.validateThrottleMs(byId("throttleMs").value);

    return pollValid && throttleValid;
  };

  StockPropertyInspector.prototype.updateGlobalControls = function () {
    byId("saveGlobalButton").disabled =
      !this.globalDirty || !this.isGlobalSettingsValid();
    byId("testConnectionButton").disabled = this.pendingConnectionTestId !== null;
  };

  StockPropertyInspector.prototype.getFieldSettingKey = function (field) {
    return field.settingKey || field.id;
  };

  StockPropertyInspector.prototype.setFieldValue = function (field, value) {
    var element = byId(field.id);
    var normalized = hasValue(value) ? String(value) : "";

    if (!normalized && hasValue(field.defaultValue)) {
      normalized = String(field.defaultValue);
    }
    if (typeof field.normalizeReceived === "function") {
      normalized = field.normalizeReceived(normalized);
    }

    element.value = normalized;

    if (getFieldType(field) === "select" && !element.value) {
      element.value = getSelectFallbackValue(field);
    }
  };

  StockPropertyInspector.prototype.readActionValues = function () {
    var values = {};
    var fields = this.config.fields || [];
    var index;

    for (index = 0; index < fields.length; index += 1) {
      values[this.getFieldSettingKey(fields[index])] = byId(fields[index].id).value;
    }

    return values;
  };

  StockPropertyInspector.prototype.serializeFieldValue = function (field, value) {
    if (typeof field.serialize === "function") {
      return field.serialize(value);
    }

    if (getFieldType(field) === "select") {
      return value;
    }

    return value.trim();
  };

  StockPropertyInspector.prototype.validateActionField = function (field) {
    var errorId = field.errorId || field.id + "Error";
    var errorElement = byId(errorId);
    var value = byId(field.id).value;
    var allowEmpty = field.allowEmpty !== false;
    var isValid = true;

    if (typeof field.validate === "function") {
      isValid = field.validate(value);
    }

    if (!allowEmpty && value.length === 0) {
      isValid = false;
    }

    if (errorElement) {
      errorElement.style.display =
        value.length > 0 && !isValid ? "block" : "none";
    }

    this.actionFieldValidity[field.id] = isValid || (allowEmpty && value.length === 0);
    return this.actionFieldValidity[field.id];
  };

  StockPropertyInspector.prototype.findFirstInvalidActionField = function () {
    var fields = this.config.fields || [];
    var index;

    for (index = 0; index < fields.length; index += 1) {
      if (!this.validateActionField(fields[index])) {
        return fields[index];
      }
    }

    return null;
  };

  StockPropertyInspector.prototype.buildActionSettingsPayload = function () {
    var payload = {};
    var fields = this.config.fields || [];
    var index;

    for (index = 0; index < fields.length; index += 1) {
      payload[this.getFieldSettingKey(fields[index])] = this.serializeFieldValue(
        fields[index],
        byId(fields[index].id).value
      );
    }

    return payload;
  };

  StockPropertyInspector.prototype.getConnectionTestActionPayload = function () {
    var actionPayload = this.buildActionSettingsPayload();

    return {
      stockCode: actionPayload.stockCode,
      ticker: actionPayload.ticker,
      exchange: actionPayload.exchange,
    };
  };

  StockPropertyInspector.prototype.saveGlobalSettings = function () {
    if (!this.isGlobalSettingsValid()) {
      this.setStatus("globalStatusMessage", "공통 설정 값을 확인하세요.", "error");
      this.updateGlobalControls();
      return;
    }

    setGlobalSettings(this.getGlobalSettingsPayload());
    this.globalDirty = false;
    this.updateGlobalControls();
    this.setStatus(
      "globalStatusMessage",
      "공통 설정이 저장되었습니다. 모든 버튼에 적용됩니다.",
      "success"
    );
  };

  StockPropertyInspector.prototype.saveActionSettings = function () {
    var invalidField = this.findFirstInvalidActionField();

    if (invalidField) {
      this.setStatus(
        "actionStatusMessage",
        invalidField.invalidStatusMessage || "입력 값을 확인하세요.",
        "error"
      );
      return;
    }

    setSettings(this.buildActionSettingsPayload());
    this.setStatus(
      "actionStatusMessage",
      this.config.actionSavedMessage || "현재 버튼 설정이 저장되었습니다.",
      "success"
    );
  };

  StockPropertyInspector.prototype.queueActionSave = function () {
    var invalidField = this.findFirstInvalidActionField();

    if (invalidField) {
      if (this.actionSaveTimer) {
        clearTimeout(this.actionSaveTimer);
        this.actionSaveTimer = null;
      }
      this.setStatus(
        "actionStatusMessage",
        invalidField.invalidStatusMessage || "입력 값을 확인하세요.",
        "error"
      );
      return;
    }

    if (this.actionSaveTimer) {
      clearTimeout(this.actionSaveTimer);
    }

    this.setStatus(
      "actionStatusMessage",
      this.config.actionSavingMessage || "현재 버튼 설정을 저장하는 중입니다...",
      "info"
    );

    var inspector = this;
    this.actionSaveTimer = setTimeout(function () {
      inspector.actionSaveTimer = null;
      inspector.saveActionSettings();
    }, ACTION_SAVE_DEBOUNCE_MS);
  };

  StockPropertyInspector.prototype.runConnectionTest = function () {
    var actionPayload;
    var invalidField;

    if (this.pendingConnectionTestId !== null) {
      return;
    }

    invalidField = this.findFirstInvalidActionField();
    if (invalidField) {
      this.setStatus(
        "actionStatusMessage",
        invalidField.invalidStatusMessage || "입력 값을 확인하세요.",
        "error"
      );
      return;
    }

    this.pendingConnectionTestId = "connection-test-" + Date.now();
    actionPayload = this.getConnectionTestActionPayload();
    this.updateGlobalControls();
    byId("testConnectionButton").textContent = "연결 확인 중...";
    this.setStatus(
      "globalStatusMessage",
      "KIS API 연결과 현재 버튼 설정을 확인하는 중입니다...",
      "info"
    );

    sendToPlugin({
      type: CONNECTION_TEST_REQUEST_TYPE,
      requestId: this.pendingConnectionTestId,
      appKey: byId("appKey").value.trim(),
      appSecret: byId("appSecret").value.trim(),
      stockCode: actionPayload.stockCode,
      ticker: actionPayload.ticker,
      exchange: actionPayload.exchange,
    });
  };

  StockPropertyInspector.prototype.applyGlobalSettings = function (settings) {
    var mode = settings.updateMode || "websocket";

    byId("appKey").value = settings.appKey || "";
    byId("appSecret").value = settings.appSecret || "";
    byId("updateMode").value = mode;
    byId("pollIntervalSec").value = settings.pollIntervalSec || "30";
    byId("throttleMs").value = settings.throttleMs || "1000";

    this.updateModeRows(mode);
    this.globalDirty = false;
    this.updateGlobalControls();
  };

  StockPropertyInspector.prototype.applyActionSettings = function (settings) {
    var fields = this.config.fields || [];
    var key;
    var index;

    settings = settings || {};

    for (index = 0; index < fields.length; index += 1) {
      key = this.getFieldSettingKey(fields[index]);
      this.setFieldValue(fields[index], settings[key]);
      this.validateActionField(fields[index]);
    }
  };

  StockPropertyInspector.prototype.bindEvents = function () {
    var inspector = this;
    var fields = this.config.fields || [];
    var index;

    document.addEventListener("piDidReceiveGlobalSettings", function (evt) {
      inspector.applyGlobalSettings(evt.detail || {});
    });

    document.addEventListener("piDidReceiveSettings", function (evt) {
      inspector.applyActionSettings(evt.detail || {});
    });

    document.addEventListener("piDidReceiveMessage", function (evt) {
      var payload = evt.detail || {};

      if (payload.type !== CONNECTION_TEST_RESULT_TYPE) {
        return;
      }
      if (
        payload.requestId &&
        inspector.pendingConnectionTestId &&
        payload.requestId !== inspector.pendingConnectionTestId
      ) {
        return;
      }

      inspector.pendingConnectionTestId = null;
      byId("testConnectionButton").textContent = "연결 테스트";
      inspector.updateGlobalControls();
      inspector.setStatus(
        "globalStatusMessage",
        payload.message,
        payload.ok ? "success" : "error"
      );
    });

    byId("saveGlobalButton").addEventListener("click", function () {
      inspector.saveGlobalSettings();
    });
    byId("testConnectionButton").addEventListener("click", function () {
      inspector.runConnectionTest();
    });

    byId("appKey").addEventListener("input", function () {
      inspector.setGlobalDirty("공통 설정이 변경되었습니다. 저장 버튼으로 적용하세요.");
    });
    byId("appSecret").addEventListener("input", function () {
      inspector.setGlobalDirty("공통 설정이 변경되었습니다. 저장 버튼으로 적용하세요.");
    });
    byId("updateMode").addEventListener("change", function () {
      inspector.updateModeRows(this.value);
      inspector.setGlobalDirty("업데이트 방식이 변경되었습니다. 저장 후 모든 버튼에 반영됩니다.");
    });
    byId("pollIntervalSec").addEventListener("input", function () {
      inspector.validatePollInterval(this.value);
      inspector.setGlobalDirty("공통 설정이 변경되었습니다. 저장 버튼으로 적용하세요.");
    });
    byId("throttleMs").addEventListener("input", function () {
      inspector.validateThrottleMs(this.value);
      inspector.setGlobalDirty("공통 설정이 변경되었습니다. 저장 버튼으로 적용하세요.");
    });
    byId("throttleMs").addEventListener("blur", function () {
      var parsed = parseInt(this.value, 10);

      if (!isNaN(parsed) && parsed < 200) {
        this.value = "200";
        byId("throttleMsError").style.display = "none";
        inspector.setGlobalDirty("쓰로틀 값을 200ms로 보정했습니다. 저장 버튼으로 적용하세요.");
      }
    });

    for (index = 0; index < fields.length; index += 1) {
      (function (field) {
        var element = byId(field.id);
        var eventName =
          field.saveOn || (getFieldType(field) === "select" ? "change" : "input");

        element.addEventListener(eventName, function () {
          if (typeof field.normalizeInput === "function") {
            this.value = field.normalizeInput(this.value);
          }

          inspector.validateActionField(field);
          inspector.queueActionSave();
        });
      })(fields[index]);
    }
  };

  function bootstrapStockPI(config) {
    var root = byId(config.rootId || "piRoot");
    var inspector;

    if (!root) {
      throw new Error("Property Inspector root element was not found.");
    }

    root.innerHTML = renderLayout(config);
    inspector = new StockPropertyInspector(config);
    inspector.bindEvents();
    inspector.updateModeRows("websocket");
    inspector.updateGlobalControls();

    return inspector;
  }

  window.KISStockPI = {
    bootstrap: bootstrapStockPI,
  };
})();
