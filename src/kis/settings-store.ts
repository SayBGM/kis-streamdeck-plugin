import type { GlobalSettings } from "../types/index.js";

/**
 * 전역 설정 저장소
 * REST API 등에서 appKey/appSecret에 접근해야 할 때 사용합니다.
 */
class GlobalSettingsStore {
  private settings: GlobalSettings | null = null;
  private waiters = new Set<(settings: GlobalSettings) => void>();

  set(settings: GlobalSettings): void {
    this.settings = settings;
    if (settings.appKey?.trim() && settings.appSecret?.trim()) {
      for (const resolve of this.waiters) {
        resolve(settings);
      }
      this.waiters.clear();
    }
  }

  get(): GlobalSettings | null {
    return this.settings;
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<GlobalSettings | null> {
    const current = this.settings;
    if (current?.appKey?.trim() && current.appSecret?.trim()) {
      return current;
    }

    return new Promise<GlobalSettings | null>((resolve) => {
      const waiter = (readySettings: GlobalSettings) => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(readySettings);
      };

      this.waiters.add(waiter);

      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
    });
  }
}

export const kisGlobalSettings = new GlobalSettingsStore();
