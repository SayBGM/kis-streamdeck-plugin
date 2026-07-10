import streamDeck from "@elgato/streamdeck";
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
});

streamDeck.settings.onDidReceiveGlobalSettings(() => {
  void runtime.refreshGlobalSettings().catch((error: unknown) => {
    logger.error("[Plugin] 전역 설정 재적용 실패", error);
  });
});

streamDeck.actions.registerAction(
  new DomesticStockAction(runtime.domesticController),
);
streamDeck.actions.registerAction(
  new OverseasStockAction(runtime.overseasController),
);

void streamDeck.connect()
  .then(() => runtime.initialize())
  .catch((error: unknown) => {
    logger.error("[Plugin] 초기화 실패", error);
  });
