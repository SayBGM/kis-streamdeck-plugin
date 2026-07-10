import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { DomesticStockAction } from "./actions/domestic-stock.js";
import { OverseasStockAction } from "./actions/overseas-stock.js";
import { createPluginRuntime } from "./runtime/plugin-runtime.js";
import type { GlobalSettingsV2 } from "./settings/schema.js";
import type { GlobalSettings } from "./types/index.js";
import { logger } from "./utils/logger.js";

streamDeck.logger.setLevel("debug");
streamDeck.settings.useExperimentalMessageIdentifiers = true;

const runtime = createPluginRuntime({
  settingsPersistence: {
    getGlobalSettings: () => streamDeck.settings.getGlobalSettings<GlobalSettings>(),
    setGlobalSettings: (settings: GlobalSettingsV2) =>
      streamDeck.settings.setGlobalSettings(settings),
  },
  piSender: {
    send: async (contextId, message) => {
      if (streamDeck.ui.action?.id !== contextId) return;
      await streamDeck.ui.sendToPropertyInspector(message as unknown as JsonValue);
    },
  },
});

function marketForManifest(manifestId: string): "domestic" | "overseas" | undefined {
  if (manifestId === "com.kis.streamdeck.domestic-stock") return "domestic";
  if (manifestId === "com.kis.streamdeck.overseas-stock") return "overseas";
  return undefined;
}

streamDeck.ui.onDidAppear((event) => {
  const market = marketForManifest(event.action.manifestId);
  if (!market) return;
  void runtime.piController
    .propertyInspectorDidAppear(event.action.id, market);
});

streamDeck.ui.onDidDisappear((event) => {
  const market = marketForManifest(event.action.manifestId);
  if (!market) return;
  void runtime.piController
    .propertyInspectorDidDisappear(event.action.id);
});

streamDeck.ui.onSendToPlugin((event) => {
  const market = marketForManifest(event.action.manifestId);
  if (!market) return;
  void runtime.piController
    .handleCommand(event.action.id, market, event.payload);
});

streamDeck.settings.onDidReceiveGlobalSettings(() => {
  void runtime.refreshGlobalSettings().catch((error: unknown) => {
    logger.error("[Plugin] 전역 설정 재적용 실패", error);
  });
});

streamDeck.actions.registerAction(
  new DomesticStockAction(runtime.domesticController, runtime.diagnostics),
);
streamDeck.actions.registerAction(
  new OverseasStockAction(runtime.overseasController, runtime.diagnostics),
);

void streamDeck.connect()
  .then(() => runtime.initialize())
  .catch((error: unknown) => {
    logger.error("[Plugin] 초기화 실패", error);
  });
