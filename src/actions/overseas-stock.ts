import {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  actionSettingsEqual,
  migrateOverseasStockSettings,
  type OverseasStockSettingsV2,
} from "../settings/schema.js";
import type { StockActionAppearInput, StockActionPort } from "./stock-action-controller.js";
import type { StockActionControllerPort } from "./domestic-stock.js";

async function isolated(operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Stream Deck event dispatch must not leak rejected late lifecycle work.
  }
}

function actionPort(action: { setImage(image?: string): Promise<void> }): StockActionPort {
  return Object.freeze({
    setImage: (image: string) => action.setImage(image),
  });
}

/** Stream Deck SDK events only; all market policy lives in StockActionController. */
export class OverseasStockAction extends SingletonAction<OverseasStockSettingsV2> {
  override readonly manifestId = "com.kis.streamdeck.overseas-stock";

  constructor(
    private readonly controller: StockActionControllerPort<OverseasStockSettingsV2>,
  ) {
    super();
  }

  override async onWillAppear(
    ev: WillAppearEvent<OverseasStockSettingsV2>,
  ): Promise<void> {
    await isolated(async () => {
      if (!ev.action.isKey()) return;
      const settings = migrateOverseasStockSettings(ev.payload.settings);
      if (!actionSettingsEqual(ev.payload.settings, settings)) {
        await isolated(() => ev.action.setSettings(settings));
      }
      await this.controller.appear({
        actionId: ev.action.id,
        settings,
        actionPort: actionPort(ev.action),
      });
    });
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<OverseasStockSettingsV2>,
  ): Promise<void> {
    await isolated(async () => {
      const settings = migrateOverseasStockSettings(ev.payload.settings);
      if (!actionSettingsEqual(ev.payload.settings, settings)) {
        await isolated(() => ev.action.setSettings(settings));
      }
      await this.controller.updateSettings(ev.action.id, settings);
    });
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<OverseasStockSettingsV2>,
  ): Promise<void> {
    await isolated(() => this.controller.disappear(ev.action.id));
  }

  override async onKeyDown(ev: KeyDownEvent<OverseasStockSettingsV2>): Promise<void> {
    await isolated(() => this.controller.manualRefresh(ev.action.id));
  }
}
