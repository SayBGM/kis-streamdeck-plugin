/** Minimal Stream Deck Property Inspector transport. */
let websocket = null;
let piUUID = null;
let actionInfo = null;

// Called by Stream Deck after the Property Inspector document loads.
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(
  inPort,
  inPluginUUID,
  inRegisterEvent,
  inInfo,
  inActionInfo
) {
  piUUID = inPluginUUID;
  try {
    actionInfo = JSON.parse(inActionInfo);
  } catch (_) {
    actionInfo = { action: "", payload: { settings: {} } };
  }

  websocket = new WebSocket("ws://localhost:" + inPort);
  websocket.onopen = function () {
    websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: inPluginUUID }));
    document.dispatchEvent(
      new CustomEvent("piDidReceiveSettings", {
        detail: (actionInfo.payload && actionInfo.payload.settings) || {},
      })
    );
    document.dispatchEvent(new CustomEvent("piDidConnect"));
  };

  websocket.onmessage = function (event) {
    var data;
    try {
      data = JSON.parse(event.data);
    } catch (_) {
      return;
    }
    if (data.event === "didReceiveSettings") {
      document.dispatchEvent(
        new CustomEvent("piDidReceiveSettings", {
          detail: (data.payload && data.payload.settings) || {},
        })
      );
    } else if (data.event === "sendToPropertyInspector") {
      document.dispatchEvent(
        new CustomEvent("piDidReceiveMessage", { detail: data.payload || {} })
      );
    }
  };
}

// eslint-disable-next-line no-unused-vars
function setSettings(settings) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN) return;
  websocket.send(
    JSON.stringify({ event: "setSettings", context: piUUID, payload: settings })
  );
}

// eslint-disable-next-line no-unused-vars
function sendToPlugin(payload) {
  if (!websocket || websocket.readyState !== WebSocket.OPEN || !actionInfo) return;
  websocket.send(
    JSON.stringify({
      action: actionInfo.action,
      event: "sendToPlugin",
      context: piUUID,
      payload: payload,
    })
  );
}
