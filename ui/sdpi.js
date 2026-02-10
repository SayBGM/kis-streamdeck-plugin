/**
 * Stream Deck Property Inspector SDK Helper
 *
 * Stream Deck 소프트웨어와 WebSocket으로 통신하여
 * 전역 설정(Global Settings)과 액션 설정(Action Settings)을 관리합니다.
 */

let websocket = null;
let piUUID = null;
let actionInfo = null;

/**
 * Stream Deck 소프트웨어가 PI HTML 로드 후 자동 호출하는 함수
 * @param {string} inPort - WebSocket 포트
 * @param {string} inPluginUUID - PI UUID
 * @param {string} inRegisterEvent - 등록 이벤트명
 * @param {string} inInfo - 앱 정보 JSON
 * @param {string} inActionInfo - 액션 정보 JSON (현재 settings 포함)
 */
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(
  inPort,
  inPluginUUID,
  inRegisterEvent,
  inInfo,
  inActionInfo
) {
  piUUID = inPluginUUID;
  actionInfo = JSON.parse(inActionInfo);

  websocket = new WebSocket(`ws://localhost:${inPort}`);

  websocket.onopen = function () {
    // PI 등록
    websocket.send(
      JSON.stringify({
        event: inRegisterEvent,
        uuid: inPluginUUID,
      })
    );

    // 전역 설정 요청
    websocket.send(
      JSON.stringify({
        event: "getGlobalSettings",
        context: inPluginUUID,
      })
    );

    // 초기 액션 설정 전달
    const settings = actionInfo.payload.settings || {};
    document.dispatchEvent(
      new CustomEvent("piDidReceiveSettings", { detail: settings })
    );
  };

  websocket.onmessage = function (evt) {
    const data = JSON.parse(evt.data);

    switch (data.event) {
      case "didReceiveSettings":
        document.dispatchEvent(
          new CustomEvent("piDidReceiveSettings", {
            detail: data.payload.settings,
          })
        );
        break;

      case "didReceiveGlobalSettings":
        document.dispatchEvent(
          new CustomEvent("piDidReceiveGlobalSettings", {
            detail: data.payload.settings,
          })
        );
        break;

      case "sendToPropertyInspector":
        document.dispatchEvent(
          new CustomEvent("piDidReceiveMessage", {
            detail: data.payload,
          })
        );
        break;
    }
  };
}

/**
 * 액션 설정 저장 (버튼별)
 * @param {object} settings - 저장할 설정 객체
 */
// eslint-disable-next-line no-unused-vars
function setSettings(settings) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(
      JSON.stringify({
        event: "setSettings",
        context: piUUID,
        payload: settings,
      })
    );
  }
}

/**
 * 전역 설정 저장 (모든 버튼 공유)
 * @param {object} settings - 저장할 전역 설정 객체
 */
// eslint-disable-next-line no-unused-vars
function setGlobalSettings(settings) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(
      JSON.stringify({
        event: "setGlobalSettings",
        context: piUUID,
        payload: settings,
      })
    );
  }
}

/**
 * 플러그인에 메시지 전송
 * @param {object} payload - 전송할 데이터
 */
// eslint-disable-next-line no-unused-vars
function sendToPlugin(payload) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(
      JSON.stringify({
        action: actionInfo.action,
        event: "sendToPlugin",
        context: piUUID,
        payload: payload,
      })
    );
  }
}
