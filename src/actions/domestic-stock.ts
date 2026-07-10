import {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  actionSettingsEqual,
  migrateDomesticStockSettings,
  type DomesticStockSettingsV2,
} from "../settings/schema.js";
import type {
  StockActionAppearInput,
  StockActionPort,
} from "./stock-action-controller.js";

export interface StockActionControllerPort<Settings> {
  appear(input: StockActionAppearInput<Settings>): Promise<void>;
  updateSettings(actionId: string, settings: Settings): Promise<void>;
  disappear(actionId: string): Promise<void>;
  manualRefresh(actionId: string): Promise<void>;
}

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
export class DomesticStockAction extends SingletonAction<DomesticStockSettingsV2> {
  override readonly manifestId = "com.kis.streamdeck.domestic-stock";

  constructor(
    private readonly controller: StockActionControllerPort<DomesticStockSettingsV2>,
  ) {
    super();
  }

  override async onWillAppear(
    ev: WillAppearEvent<DomesticStockSettingsV2>,
  ): Promise<void> {
    await isolated(async () => {
      if (!ev.action.isKey()) return;
      const settings = migrateDomesticStockSettings(ev.payload.settings);
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
    ev: DidReceiveSettingsEvent<DomesticStockSettingsV2>,
  ): Promise<void> {
    await isolated(async () => {
      const settings = migrateDomesticStockSettings(ev.payload.settings);
      if (!actionSettingsEqual(ev.payload.settings, settings)) {
        await isolated(() => ev.action.setSettings(settings));
      }
      await this.controller.updateSettings(ev.action.id, settings);
    });
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<DomesticStockSettingsV2>,
  ): Promise<void> {
    await isolated(() => this.controller.disappear(ev.action.id));
  }

  override async onKeyDown(ev: KeyDownEvent<DomesticStockSettingsV2>): Promise<void> {
    await isolated(() => this.controller.manualRefresh(ev.action.id));
  }
}
