import {
  SingletonAction,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  migrateOverseasStockSettings,
  type OverseasStockSettingsV2,
} from "../settings/schema.js";
import type {
  ActionWrapperDiagnosticsPort,
  StockActionControllerPort,
} from "./stock-action-wrapper-runtime.js";
import {
  noopActionWrapperDiagnostics,
  StockActionWrapperRuntime,
} from "./stock-action-wrapper-runtime.js";

/** Stream Deck SDK events only; all market policy lives in StockActionController. */
export class OverseasStockAction extends SingletonAction<OverseasStockSettingsV2> {
  override readonly manifestId = "com.kis.streamdeck.overseas-stock";
  private readonly runtime: StockActionWrapperRuntime<OverseasStockSettingsV2>;

  constructor(
    controller: StockActionControllerPort<OverseasStockSettingsV2>,
    diagnostics: ActionWrapperDiagnosticsPort = noopActionWrapperDiagnostics,
  ) {
    super();
    this.runtime = new StockActionWrapperRuntime(
      controller,
      migrateOverseasStockSettings,
      diagnostics,
    );
  }

  override async onWillAppear(
    ev: WillAppearEvent<OverseasStockSettingsV2>,
  ): Promise<void> {
    if (!ev.action.isKey()) return;
    await this.runtime.appear(
      ev.action.id,
      ev.payload.settings,
      ev.action,
      ev.action,
    );
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<OverseasStockSettingsV2>,
  ): Promise<void> {
    await this.runtime.settingsChanged(ev.action.id, ev.payload.settings, ev.action);
  }

  override async onWillDisappear(
    ev: WillDisappearEvent<OverseasStockSettingsV2>,
  ): Promise<void> {
    await this.runtime.disappear(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<OverseasStockSettingsV2>): Promise<void> {
    await this.runtime.manualRefresh(ev.action.id);
  }
}
