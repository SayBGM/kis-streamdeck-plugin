(function () {
  "use strict";

  var ACTION_SAVE_DEBOUNCE_MS = 350;
  var PREFERENCE_FIELDS = [
    "dataMode",
    "uiUpdateMode",
    "renderIntervalMs",
    "backupPollIntervalMs",
  ];
  var requestSequence = 0;
  var UNSAFE_DATA = {};
  // Bound untrusted snapshot work before cloning or rendering diagnostics.
  var SAFE_DATA_MAX_DEPTH = 32;
  var SAFE_DATA_MAX_NODES = 4096;
  var SAFE_DATA_MAX_PROPERTIES = 8192;
  var SAFE_DATA_MAX_ARRAY_LENGTH = 512;
  var SAFE_DATA_MAX_STRING_LENGTH = 16384;
  var SAFE_DATA_MAX_TOTAL_STRING_LENGTH = 262144;
  var SNAPSHOT_EPOCH_MAX_LENGTH = 128;
  var RETIRED_SNAPSHOT_EPOCH_LIMIT = 12;

  function byId(id) {
    return document.getElementById(id);
  }

  function selectedUiUpdateMode() {
    var selected = document.querySelector('input[name="uiUpdateMode"]:checked');
    return selected ? selected.value : "realtime";
  }

  function setSelectedUiUpdateMode(mode) {
    var radios = document.querySelectorAll('input[name="uiUpdateMode"]');
    for (var index = 0; index < radios.length; index += 1) {
      radios[index].checked = radios[index].value === mode;
    }
  }

  function syncRenderIntervalVisibility() {
    byId("renderIntervalField").hidden = selectedUiUpdateMode() === "realtime";
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

  function hasValue(value) {
    return value !== undefined && value !== null && value !== "";
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function consumeSafeString(value, budget) {
    if (value.length > SAFE_DATA_MAX_STRING_LENGTH) return false;
    budget.stringLength += value.length;
    return budget.stringLength <= SAFE_DATA_MAX_TOTAL_STRING_LENGTH;
  }

  function safeDataClone(value, budget, depth) {
    if (depth > SAFE_DATA_MAX_DEPTH) return UNSAFE_DATA;
    budget.nodes += 1;
    if (budget.nodes > SAFE_DATA_MAX_NODES) return UNSAFE_DATA;
    if (typeof value === "string") {
      return consumeSafeString(value, budget) ? value : UNSAFE_DATA;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : UNSAFE_DATA;
    if (typeof value !== "object") return UNSAFE_DATA;
    if (budget.ancestors.has(value)) return UNSAFE_DATA;

    var isArray = Array.isArray(value);
    var prototype;
    var descriptors;
    try {
      prototype = Object.getPrototypeOf(value);
      if (
        (isArray && prototype !== Array.prototype) ||
        (!isArray && prototype !== null && prototype !== Object.prototype) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        return UNSAFE_DATA;
      }
      descriptors = Object.entries(Object.getOwnPropertyDescriptors(value));
    } catch (_error) {
      return UNSAFE_DATA;
    }
    budget.properties += descriptors.length;
    if (budget.properties > SAFE_DATA_MAX_PROPERTIES) return UNSAFE_DATA;
    for (var keyIndex = 0; keyIndex < descriptors.length; keyIndex += 1) {
      if (!consumeSafeString(descriptors[keyIndex][0], budget)) return UNSAFE_DATA;
    }

    budget.ancestors.add(value);
    try {
      if (isArray) {
        var lengthDescriptor = null;
        for (var descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) {
          if (descriptors[descriptorIndex][0] === "length") {
            lengthDescriptor = descriptors[descriptorIndex][1];
            break;
          }
        }
        if (
          !lengthDescriptor ||
          lengthDescriptor.enumerable ||
          !hasOwn(lengthDescriptor, "value") ||
          !Number.isSafeInteger(lengthDescriptor.value) ||
          lengthDescriptor.value < 0 ||
          lengthDescriptor.value > SAFE_DATA_MAX_ARRAY_LENGTH
        ) {
          return UNSAFE_DATA;
        }
        var arrayCopy = new Array(lengthDescriptor.value);
        for (var arrayIndex = 0; arrayIndex < descriptors.length; arrayIndex += 1) {
          var arrayEntry = descriptors[arrayIndex];
          var arrayKey = arrayEntry[0];
          var arrayDescriptor = arrayEntry[1];
          if (arrayKey === "length") continue;
          if (
            !/^(0|[1-9][0-9]*)$/.test(arrayKey) ||
            !arrayDescriptor.enumerable ||
            !hasOwn(arrayDescriptor, "value")
          ) {
            return UNSAFE_DATA;
          }
          var numericIndex = Number(arrayKey);
          if (
            !Number.isSafeInteger(numericIndex) ||
            numericIndex < 0 ||
            numericIndex >= lengthDescriptor.value ||
            numericIndex >= 4294967295
          ) {
            return UNSAFE_DATA;
          }
          var arrayValue = safeDataClone(arrayDescriptor.value, budget, depth + 1);
          if (arrayValue === UNSAFE_DATA) return UNSAFE_DATA;
          arrayCopy[numericIndex] = arrayValue;
        }
        return arrayCopy;
      }

      var objectCopy = Object.create(null);
      for (var objectIndex = 0; objectIndex < descriptors.length; objectIndex += 1) {
        var objectEntry = descriptors[objectIndex];
        var objectDescriptor = objectEntry[1];
        if (!objectDescriptor.enumerable || !hasOwn(objectDescriptor, "value")) {
          return UNSAFE_DATA;
        }
        var objectValue = safeDataClone(objectDescriptor.value, budget, depth + 1);
        if (objectValue === UNSAFE_DATA) return UNSAFE_DATA;
        objectCopy[objectEntry[0]] = objectValue;
      }
      return objectCopy;
    } finally {
      budget.ancestors.delete(value);
    }
  }

  function copyKnownPreferences(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    var copy = Object.create(null);
    for (var index = 0; index < PREFERENCE_FIELDS.length; index += 1) {
      var field = PREFERENCE_FIELDS[index];
      if (!hasOwn(value, field)) return null;
      copy[field] = value[field];
    }
    if (
      (copy.dataMode !== "automatic" && copy.dataMode !== "rest-only") ||
      (copy.uiUpdateMode !== "realtime" && copy.uiUpdateMode !== "throttled") ||
      !Number.isInteger(copy.renderIntervalMs) ||
      copy.renderIntervalMs < 500 ||
      copy.renderIntervalMs > 1000 ||
      copy.renderIntervalMs % 100 !== 0 ||
      (copy.backupPollIntervalMs !== 15000 &&
        copy.backupPollIntervalMs !== 30000 &&
        copy.backupPollIntervalMs !== 60000)
    ) {
      return null;
    }
    return copy;
  }

  function copyKnownSnapshot(value) {
    var safeValue;
    try {
      safeValue = safeDataClone(value, {
        nodes: 0,
        properties: 0,
        stringLength: 0,
        ancestors: new WeakSet(),
      }, 0);
    } catch (_error) {
      return null;
    }
    if (
      safeValue === UNSAFE_DATA ||
      !safeValue ||
      typeof safeValue !== "object" ||
      Array.isArray(safeValue) ||
      !hasOwn(safeValue, "schemaVersion") ||
      safeValue.schemaVersion !== 2 ||
      !hasOwn(safeValue, "snapshotEpoch") ||
      typeof safeValue.snapshotEpoch !== "string" ||
      safeValue.snapshotEpoch.trim().length === 0 ||
      safeValue.snapshotEpoch.length > SNAPSHOT_EPOCH_MAX_LENGTH ||
      !hasOwn(safeValue, "snapshotSequence") ||
      !Number.isSafeInteger(safeValue.snapshotSequence) ||
      safeValue.snapshotSequence < 1 ||
      !hasOwn(safeValue, "settingsRevision") ||
      !Number.isSafeInteger(safeValue.settingsRevision) ||
      safeValue.settingsRevision < 0 ||
      !hasOwn(safeValue, "credentialsConfigured") ||
      typeof safeValue.credentialsConfigured !== "boolean" ||
      !hasOwn(safeValue, "preferences") ||
      !hasOwn(safeValue, "diagnostics") ||
      !safeValue.diagnostics ||
      typeof safeValue.diagnostics !== "object" ||
      Array.isArray(safeValue.diagnostics) ||
      (hasOwn(safeValue, "maskedAppKey") && typeof safeValue.maskedAppKey !== "string")
    ) {
      return null;
    }
    var safePreferences = copyKnownPreferences(safeValue.preferences);
    if (!safePreferences) return null;
    var copy = Object.create(null);
    copy.schemaVersion = safeValue.schemaVersion;
    copy.snapshotEpoch = safeValue.snapshotEpoch;
    copy.snapshotSequence = safeValue.snapshotSequence;
    copy.settingsRevision = safeValue.settingsRevision;
    copy.credentialsConfigured = safeValue.credentialsConfigured;
    if (hasOwn(safeValue, "maskedAppKey")) copy.maskedAppKey = safeValue.maskedAppKey;
    copy.preferences = safePreferences;
    copy.diagnostics = safeValue.diagnostics;
    return copy;
  }

  function preferencesEqual(left, right) {
    if (!left || !right) return false;
    return PREFERENCE_FIELDS.every(function (field) {
      return left[field] === right[field];
    });
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

      '<section class="sdpi-connection-strip" data-section="connection-status">',
      '<div class="sdpi-connection-heading"><span>공통 연결 상태</span><span id="connectionBadge" class="sdpi-badge">확인 중</span></div>',
      '<div id="connectionSummary" class="sdpi-connection-summary">플러그인 상태를 불러오는 중입니다.</div>',
      "</section>",

      '<details class="sdpi-group sdpi-disclosure" data-section="stock-settings" open>',
      "<summary>",
      '<span class="sdpi-summary-copy"><span class="sdpi-summary-title">' + escapeHtml(config.actionTitle) + "</span>",
      '<span class="sdpi-summary-meta">종목 미설정</span></span>',
      '<span class="sdpi-scope">현재 버튼만</span>',
      '<span class="sdpi-disclosure-icon" aria-hidden="true"></span>',
      "</summary>",
      '<div class="sdpi-disclosure-body">',
      '<div class="sdpi-note">유효한 종목 값은 현재 버튼에 자동 저장됩니다.</div>',
      renderFields(config.fields),
      '<div id="actionStatusMessage" class="sdpi-status info"></div>',
      "</div>",
      "</details>",

      '<details id="credentialsDetails" class="sdpi-group sdpi-disclosure" data-section="credentials">',
      "<summary>",
      '<span class="sdpi-summary-copy"><span class="sdpi-summary-title">KIS API 자격증명</span>',
      '<span class="sdpi-summary-meta">저장 상태 확인 중</span></span>',
      '<span class="sdpi-scope">모든 버튼 공통</span>',
      '<span class="sdpi-disclosure-icon" aria-hidden="true"></span>',
      "</summary>",
      '<div class="sdpi-disclosure-body">',
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
      "</div>",
      "</details>",

      '<details id="preferencesDetails" class="sdpi-group sdpi-disclosure" data-section="global-preferences">',
      "<summary>",
      '<span class="sdpi-summary-copy"><span class="sdpi-summary-title">전체 버튼 환경설정</span>',
      '<span class="sdpi-summary-meta">설정을 불러오는 중</span></span>',
      '<span class="sdpi-scope">모든 버튼 공통</span>',
      '<span class="sdpi-disclosure-icon" aria-hidden="true"></span>',
      "</summary>",
      '<div class="sdpi-disclosure-body">',
      '<div class="sdpi-item"><div class="sdpi-item-label">데이터 모드</div><div class="sdpi-item-value">',
      '<select id="dataMode"><option value="automatic">자동 (WebSocket 우선)</option><option value="rest-only">REST 전용</option></select>',
      "</div></div>",
      '<div class="sdpi-note">이 설정은 모든 국내/미국 주식 버튼에 전역 적용됩니다.</div>',
      '<div class="sdpi-item sdpi-render-mode-item"><div id="uiUpdateModeLabel" class="sdpi-item-label">화면 반영 방식</div><div class="sdpi-item-value">',
      '<div class="sdpi-segmented" role="radiogroup" aria-labelledby="uiUpdateModeLabel" aria-describedby="uiUpdateModeDescription">',
      '<label class="sdpi-segmented-option" for="uiUpdateModeRealtime">',
      '<input class="sdpi-segmented-input" id="uiUpdateModeRealtime" type="radio" name="uiUpdateMode" value="realtime" checked>',
      '<span class="sdpi-segmented-content"><span class="sdpi-segmented-label">실시간</span><span class="sdpi-segmented-description">50ms 최신값 병합</span></span>',
      "</label>",
      '<label class="sdpi-segmented-option" for="uiUpdateModeThrottled">',
      '<input class="sdpi-segmented-input" id="uiUpdateModeThrottled" type="radio" name="uiUpdateMode" value="throttled">',
      '<span class="sdpi-segmented-content"><span class="sdpi-segmented-label">스로틀링</span><span class="sdpi-segmented-description">선택한 간격마다 최신값 반영</span></span>',
      "</label>",
      "</div>",
      '<div id="uiUpdateModeDescription" class="sdpi-field-description">화면 반영 주기를 선택합니다.</div>',
      "</div></div>",
      '<div id="renderIntervalField" class="sdpi-item"><div class="sdpi-item-label">스로틀 간격(ms)</div><div class="sdpi-item-value">',
      '<input id="renderIntervalMs" type="number" min="500" max="1000" step="100">',
      "</div></div>",
      '<div class="sdpi-item"><div class="sdpi-item-label">백업 폴링</div><div class="sdpi-item-value">',
      '<select id="backupPollIntervalMs"><option value="15000">15초</option><option value="30000">30초</option><option value="60000">60초</option></select>',
      "</div></div>",
      '<div class="sdpi-actions"><button type="button" id="savePreferencesButton" class="sdpi-button primary">고급 설정 저장</button></div>',
      '<div id="advancedStatusMessage" class="sdpi-status info"></div>',
      "</div>",
      "</details>",

      '<details id="troubleshootingDetails" class="sdpi-group sdpi-disclosure" data-section="troubleshooting">',
      "<summary>",
      '<span class="sdpi-summary-copy"><span class="sdpi-summary-title">문제 해결</span>',
      '<span class="sdpi-summary-meta">재연결 · 진단</span></span>',
      '<span class="sdpi-disclosure-icon" aria-hidden="true"></span>',
      "</summary>",
      '<div class="sdpi-disclosure-body">',
      '<div class="sdpi-actions">',
      '<button type="button" id="retryAuthButton" class="sdpi-button">인증 재시도</button>',
      '<button type="button" id="reconnectWsButton" class="sdpi-button">WebSocket 재연결</button>',
      '<button type="button" id="refreshQuoteButton" class="sdpi-button">현재 종목 새로고침</button>',
      "</div>",
      '<div id="troubleshootingStatusMessage" class="sdpi-status info"></div>',

      '<details id="diagnosticsDetails" class="sdpi-nested-disclosure">',
      "<summary>",
      '<span class="sdpi-summary-copy"><span class="sdpi-summary-title">상세 진단</span>',
      '<span class="sdpi-summary-meta">필요할 때만 펼침</span></span>',
      '<span class="sdpi-disclosure-icon" aria-hidden="true"></span>',
      "</summary>",
      '<div class="sdpi-nested-disclosure-body">',
      '<div class="sdpi-actions"><button type="button" id="refreshDiagnosticsButton" class="sdpi-button compact">새로고침</button></div>',
      '<pre id="diagnosticsOutput" class="sdpi-diagnostics">진단을 불러오는 중입니다.</pre>',
      "</div>",
      "</details>",
      "</div>",
      "</details>",
      "</div>",
    ].join("");
  }

  function StockPropertyInspector(config) {
    this.config = config;
    this.settingsRevision = 0;
    this.preferencesRevision = 0;
    this.lastAppliedPreferences = null;
    this.actionSaveTimer = null;
    this.pendingRequests = Object.create(null);
    this.latestRequestBySection = Object.create(null);
    this.latestSafeSnapshot = null;
    this.currentSnapshotEpoch = null;
    this.appliedSnapshotEpoch = null;
    this.retiredSnapshotEpochs = [];
    this.retiredSnapshotEpochSet = Object.create(null);
    this.latestSnapshotSequence = 0;
    this.credentialEditVersion = 0;
    this.preferencesEditVersion = 0;
  }

  StockPropertyInspector.prototype.sendCommand = function (type, fields, section) {
    var requestId = nextRequestId(type.replace("/", "-"));
    var payload = { type: type, requestId: requestId };
    var key;
    fields = fields || {};
    for (key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) payload[key] = fields[key];
    }
    this.pendingRequests[requestId] = {
      type: type,
      section: section,
      credentialEditVersion: this.credentialEditVersion,
      preferencesEditVersion: this.preferencesEditVersion,
      snapshotEpoch: this.currentSnapshotEpoch,
      submittedPreferences: type === "preferences/save"
        ? copyKnownPreferences(fields.preferences)
        : null,
    };
    this.latestRequestBySection[section] = requestId;
    sendToPlugin(payload);
    return requestId;
  };

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

  StockPropertyInspector.prototype.applyPreferenceSnapshot = function (
    preferences,
    settingsRevision,
    applyPreferences,
    epochChanged
  ) {
    if (!applyPreferences) {
      if (preferencesEqual(preferences, this.lastAppliedPreferences)) {
        this.preferencesRevision = epochChanged
          ? settingsRevision
          : Math.max(this.preferencesRevision, settingsRevision);
      }
      return;
    }
    byId("dataMode").value = preferences.dataMode;
    setSelectedUiUpdateMode(preferences.uiUpdateMode);
    byId("renderIntervalMs").value = String(preferences.renderIntervalMs);
    byId("backupPollIntervalMs").value = String(preferences.backupPollIntervalMs);
    syncRenderIntervalVisibility();
    this.lastAppliedPreferences = preferences;
    this.preferencesRevision = epochChanged
      ? settingsRevision
      : Math.max(this.preferencesRevision, settingsRevision);
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

  StockPropertyInspector.prototype.retireSnapshotEpoch = function (snapshotEpoch) {
    if (!snapshotEpoch || hasOwn(this.retiredSnapshotEpochSet, snapshotEpoch)) return;
    this.retiredSnapshotEpochs.push(snapshotEpoch);
    this.retiredSnapshotEpochSet[snapshotEpoch] = true;
    while (this.retiredSnapshotEpochs.length > RETIRED_SNAPSHOT_EPOCH_LIMIT) {
      var expiredEpoch = this.retiredSnapshotEpochs.shift();
      delete this.retiredSnapshotEpochSet[expiredEpoch];
    }
  };

  StockPropertyInspector.prototype.inspectSnapshot = function (snapshot) {
    var safeSnapshot = copyKnownSnapshot(snapshot);
    if (!safeSnapshot) return { safe: false, snapshot: null };
    var snapshotEpoch = safeSnapshot.snapshotEpoch;
    if (snapshotEpoch !== this.currentSnapshotEpoch) {
      if (hasOwn(this.retiredSnapshotEpochSet, snapshotEpoch)) {
        return { safe: true, current: false, snapshot: safeSnapshot };
      }
      this.retireSnapshotEpoch(this.currentSnapshotEpoch);
      this.currentSnapshotEpoch = snapshotEpoch;
      this.latestSafeSnapshot = null;
      this.latestSnapshotSequence = 0;
    }
    if (safeSnapshot.snapshotSequence > this.latestSnapshotSequence) {
      this.latestSafeSnapshot = safeSnapshot;
      this.latestSnapshotSequence = safeSnapshot.snapshotSequence;
    }
    return { safe: true, current: true, snapshot: safeSnapshot };
  };

  StockPropertyInspector.prototype.applySafeSnapshot = function (safeSnapshot, options) {
    options = options || {};
    if (safeSnapshot !== this.latestSafeSnapshot) {
      return { fresh: false, applied: false };
    }
    var settingsRevision = safeSnapshot.settingsRevision;
    var epochChanged = safeSnapshot.snapshotEpoch !== this.appliedSnapshotEpoch;
    if (!epochChanged && settingsRevision < this.settingsRevision) {
      if (options.applyStaleDiagnostics === true) {
        this.applyDiagnostics(safeSnapshot.diagnostics);
      }
      return { fresh: false, applied: false };
    }
    this.appliedSnapshotEpoch = safeSnapshot.snapshotEpoch;
    this.settingsRevision = epochChanged
      ? settingsRevision
      : Math.max(this.settingsRevision, settingsRevision);
    byId("maskedAppKey").textContent = safeSnapshot.maskedAppKey || "설정 안 됨";
    byId("credentialSummary").textContent = safeSnapshot.credentialsConfigured
      ? "자격증명이 저장되어 있습니다. Secret은 다시 표시하지 않습니다."
      : "자격증명을 입력해야 시세를 조회할 수 있습니다.";
    if (options.applyCredentials) byId("appSecret").value = "";
    this.applyPreferenceSnapshot(
      safeSnapshot.preferences,
      settingsRevision,
      options.applyPreferences === true,
      epochChanged
    );
    this.applyDiagnostics(safeSnapshot.diagnostics);
    return { fresh: true, applied: true };
  };

  StockPropertyInspector.prototype.applySnapshot = function (snapshot, options) {
    var inspected = this.inspectSnapshot(snapshot);
    if (!inspected.safe) {
      return { safe: false, fresh: false, applied: false, snapshot: null };
    }
    var result = this.applySafeSnapshot(inspected.snapshot, options);
    return {
      safe: true,
      fresh: result.fresh,
      applied: result.applied,
      snapshot: inspected.snapshot,
    };
  };

  StockPropertyInspector.prototype.applyLatestSafeSnapshot = function (options) {
    if (!this.latestSafeSnapshot) return { fresh: false, applied: false };
    return this.applySafeSnapshot(this.latestSafeSnapshot, options);
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
    if (message.type === "diagnostics/update") {
      if (message.snapshot) this.applySnapshot(message.snapshot, {
        applyCredentials: false,
        applyPreferences: this.preferencesEditVersion === 0,
        applyStaleDiagnostics: true,
      });
      return;
    }
    if (message.type === "settings/update") {
      if (message.snapshot) this.applySnapshot(message.snapshot, {
        applyCredentials: this.credentialEditVersion === 0,
        applyPreferences: this.preferencesEditVersion === 0,
        applyStaleDiagnostics: true,
      });
      return;
    }

    var pending = this.pendingRequests[message.requestId];
    if (!pending) {
      if (message.snapshot) this.applySnapshot(message.snapshot, {
        applyCredentials: this.credentialEditVersion === 0,
        applyPreferences: this.preferencesEditVersion === 0,
      });
      return;
    }
    var hasSnapshot = hasOwn(message, "snapshot");
    var inspectedSnapshot = null;
    if (hasSnapshot) {
      inspectedSnapshot = this.inspectSnapshot(message.snapshot);
      if (!inspectedSnapshot.safe) return;
      if (!inspectedSnapshot.current) return;
    } else if (
      pending.snapshotEpoch &&
      pending.snapshotEpoch !== this.currentSnapshotEpoch
    ) {
      return;
    }
    delete this.pendingRequests[message.requestId];
    if (this.latestRequestBySection[pending.section] !== message.requestId) return;

    if (hasSnapshot) {
      var safeSnapshot = inspectedSnapshot.snapshot;
      if (pending.section === "credentials") {
        var credentialsUnchanged = pending.credentialEditVersion === this.credentialEditVersion;
        var credentialCanReset = credentialsUnchanged && message.ok === true;
        var credentialResult = this.applySafeSnapshot(safeSnapshot, {
          applyCredentials: credentialCanReset,
          applyPreferences: false,
        });
        if (credentialCanReset) {
          if (credentialResult.applied) {
            this.credentialEditVersion = 0;
          } else {
            var latestCredentialResult = this.applyLatestSafeSnapshot({
              applyCredentials: true,
              applyPreferences: false,
            });
            if (latestCredentialResult.applied) this.credentialEditVersion = 0;
          }
        }
      } else if (pending.section === "advanced" && pending.type === "preferences/save") {
        var preferencesUnchanged = pending.preferencesEditVersion === this.preferencesEditVersion;
        var submittedPreferencesMatch = preferencesEqual(
          pending.submittedPreferences,
          safeSnapshot.preferences
        );
        var preferencesCanReset =
          preferencesUnchanged && message.ok === true && submittedPreferencesMatch;
        var preferenceResult = this.applySafeSnapshot(safeSnapshot, {
          applyCredentials: false,
          applyPreferences: preferencesCanReset,
        });
        if (preferencesCanReset) {
          if (preferenceResult.applied) {
            this.preferencesEditVersion = 0;
          } else {
            var latestPreferenceResult = this.applyLatestSafeSnapshot({
              applyCredentials: false,
              applyPreferences: true,
            });
            if (latestPreferenceResult.applied) this.preferencesEditVersion = 0;
          }
        }
      } else if (pending.section === "settings") {
        this.applySafeSnapshot(safeSnapshot, {
          applyCredentials: pending.credentialEditVersion === this.credentialEditVersion,
          applyPreferences: pending.preferencesEditVersion === this.preferencesEditVersion,
        });
      } else {
        this.applySafeSnapshot(safeSnapshot, {
          applyCredentials: false,
          applyPreferences: false,
        });
      }
    }

    var safeMessage = message.error && message.error.safeMessage
      ? message.error.safeMessage
      : "요청을 처리하지 못했습니다.";
    if (pending.section === "credentials") {
      var credentialSuccessMessage = pending.type === "credentials/clear"
        ? "자격증명이 지워졌습니다."
        : "자격증명이 저장되었습니다.";
      this.setStatus(
        "credentialStatusMessage",
        message.ok === true ? credentialSuccessMessage : safeMessage,
        message.ok === true ? "success" : "error"
      );
    } else if (pending.section === "advanced") {
      this.setStatus(
        "advancedStatusMessage",
        message.ok === true ? "요청이 적용되었습니다." : safeMessage,
        message.ok === true ? "success" : "error"
      );
    } else if (pending.section === "troubleshooting") {
      this.setStatus(
        "troubleshootingStatusMessage",
        message.ok === true ? "요청이 적용되었습니다." : safeMessage,
        message.ok === true ? "success" : "error"
      );
    } else if (pending.section === "diagnostics" && message.ok === false) {
      byId("diagnosticsOutput").textContent = safeMessage;
    } else if (pending.section === "settings" && message.ok === false) {
      byId("connectionSummary").textContent = safeMessage;
    }
  };

  StockPropertyInspector.prototype.bindEvents = function () {
    var inspector = this;
    document.addEventListener("piDidConnect", function () {
      inspector.sendCommand("settings/request", null, "settings");
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
      inspector.sendCommand("credentials/save", fields, "credentials");
      inspector.setStatus("credentialStatusMessage", "자격증명을 저장하는 중입니다.", "info");
    });
    byId("clearCredentialsButton").addEventListener("click", function () {
      inspector.sendCommand(
        "credentials/clear",
        { settingsRevision: inspector.settingsRevision },
        "credentials"
      );
      inspector.setStatus("credentialStatusMessage", "자격증명을 지우는 중입니다.", "info");
    });
    byId("savePreferencesButton").addEventListener("click", function () {
      var intervalValue = byId("renderIntervalMs").value;
      var renderIntervalMs = Number(intervalValue);
      if (
        !intervalValue ||
        !Number.isInteger(renderIntervalMs) ||
        renderIntervalMs < 500 ||
        renderIntervalMs > 1000 ||
        renderIntervalMs % 100 !== 0
      ) {
        inspector.setStatus(
          "advancedStatusMessage",
          "스로틀 간격은 500~1000ms 사이의 100ms 단위 정수로 입력하세요.",
          "error"
        );
        return;
      }
      inspector.sendCommand("preferences/save", {
        settingsRevision: inspector.preferencesRevision,
        preferences: {
          dataMode: byId("dataMode").value,
          uiUpdateMode: selectedUiUpdateMode(),
          renderIntervalMs: renderIntervalMs,
          backupPollIntervalMs: Number(byId("backupPollIntervalMs").value),
        },
      }, "advanced");
    });
    byId("retryAuthButton").addEventListener("click", function () {
      inspector.sendCommand("auth/retry", null, "troubleshooting");
    });
    byId("reconnectWsButton").addEventListener("click", function () {
      inspector.sendCommand("ws/reconnect", null, "troubleshooting");
    });
    byId("refreshQuoteButton").addEventListener("click", function () {
      inspector.sendCommand("quote/refresh", null, "troubleshooting");
    });
    byId("refreshDiagnosticsButton").addEventListener("click", function () {
      inspector.sendCommand("diagnostics/request", null, "diagnostics");
    });

    byId("appKey").addEventListener("input", function () {
      inspector.credentialEditVersion += 1;
    });
    byId("appSecret").addEventListener("input", function () {
      inspector.credentialEditVersion += 1;
    });
    ["dataMode", "backupPollIntervalMs"].forEach(function (id) {
      byId(id).addEventListener("change", function () {
        inspector.preferencesEditVersion += 1;
      });
    });
    var uiUpdateModeRadios = document.querySelectorAll('input[name="uiUpdateMode"]');
    for (var radioIndex = 0; radioIndex < uiUpdateModeRadios.length; radioIndex += 1) {
      uiUpdateModeRadios[radioIndex].addEventListener("change", function () {
        syncRenderIntervalVisibility();
        inspector.preferencesEditVersion += 1;
      });
    }
    byId("renderIntervalMs").addEventListener("input", function () {
      inspector.preferencesEditVersion += 1;
    });
    syncRenderIntervalVisibility();
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
