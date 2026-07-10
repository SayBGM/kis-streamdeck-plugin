import type { Market, MarketSession } from "../types/index.js";

const RESYNC_INTERVAL_MS = 60_000;
const SEARCH_DAYS = 8;

type MarketTimeZone = "Asia/Seoul" | "America/New_York";

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

interface SessionBoundary {
  minuteOfDay: number;
  session: MarketSession;
}

const MARKET_SCHEDULES: Readonly<Record<Market, readonly SessionBoundary[]>> = {
  domestic: [
    { minuteOfDay: 8 * 60 + 30, session: "PRE" },
    { minuteOfDay: 9 * 60, session: "REG" },
    { minuteOfDay: 15 * 60 + 30, session: "CLOSED" },
    { minuteOfDay: 15 * 60 + 40, session: "AFT" },
    { minuteOfDay: 18 * 60, session: "CLOSED" },
  ],
  overseas: [
    { minuteOfDay: 4 * 60, session: "PRE" },
    { minuteOfDay: 9 * 60 + 30, session: "REG" },
    { minuteOfDay: 16 * 60, session: "AFT" },
    { minuteOfDay: 20 * 60, session: "CLOSED" },
  ],
};

const MARKET_TIME_ZONES: Readonly<Record<Market, MarketTimeZone>> = {
  domestic: "Asia/Seoul",
  overseas: "America/New_York",
};

const formatterCache = new Map<MarketTimeZone, Intl.DateTimeFormat>();

function getFormatter(timeZone: MarketTimeZone): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function weekdayNumber(value: string): number {
  switch (value) {
    case "Sun": return 0;
    case "Mon": return 1;
    case "Tue": return 2;
    case "Wed": return 3;
    case "Thu": return 4;
    case "Fri": return 5;
    default: return 6;
  }
}

function zonedParts(epochMs: number, timeZone: MarketTimeZone): ZonedParts {
  const values: Record<string, string> = {};
  for (const part of getFormatter(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdayNumber(values.weekday ?? "Sat"),
  };
}

function addLocalDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function localWeekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * Intl에는 로컬 시각→epoch 변환 API가 없어 관측된 오프셋을 보정합니다.
 * 시장 경계는 DST 전환이 끝난 04:00 이후이므로 중복/존재하지 않는 시각이 없습니다.
 */
function localBoundaryToEpoch(
  date: LocalDate,
  minuteOfDay: number,
  timeZone: MarketTimeZone,
): number {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const targetAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let candidate = targetAsUtc;

  for (let pass = 0; pass < 3; pass += 1) {
    const observed = zonedParts(candidate, timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = targetAsUtc - observedAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function sessionAt(parts: ZonedParts, schedule: readonly SessionBoundary[]): MarketSession {
  if (parts.weekday === 0 || parts.weekday === 6) return "CLOSED";

  const localMs = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1_000;
  let session: MarketSession = "CLOSED";
  for (const boundary of schedule) {
    if (localMs < boundary.minuteOfDay * 60_000) break;
    session = boundary.session;
  }
  return session;
}

interface ResolvedBoundary extends SessionBoundary {
  epochMs: number;
}

function surroundingBoundaries(market: Market, epochMs: number): ResolvedBoundary[] {
  const timeZone = MARKET_TIME_ZONES[market];
  const schedule = MARKET_SCHEDULES[market];
  const current = zonedParts(epochMs, timeZone);
  const currentDate: LocalDate = current;
  const boundaries: ResolvedBoundary[] = [];

  for (let offset = -SEARCH_DAYS; offset <= SEARCH_DAYS; offset += 1) {
    const date = addLocalDays(currentDate, offset);
    const weekday = localWeekday(date);
    if (weekday === 0 || weekday === 6) continue;

    for (const boundary of schedule) {
      boundaries.push({
        ...boundary,
        epochMs: localBoundaryToEpoch(date, boundary.minuteOfDay, timeZone),
      });
    }
  }
  return boundaries.sort((left, right) => left.epochMs - right.epochMs);
}

export interface MarketSnapshot {
  readonly market: Market;
  readonly session: MarketSession;
  /** 현재 세션이 시작된 UTC epoch ms. 주말 CLOSED도 금요일 종료 시각으로 안정적입니다. */
  readonly sessionEpoch: number;
  readonly nextTransitionAt: number;
}

export function getMarketSnapshot(market: Market, epochMs = Date.now()): MarketSnapshot {
  const timeZone = MARKET_TIME_ZONES[market];
  const parts = zonedParts(epochMs, timeZone);
  const boundaries = surroundingBoundaries(market, epochMs);
  let previous: ResolvedBoundary | undefined;
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    if (boundaries[index].epochMs <= epochMs) {
      previous = boundaries[index];
      break;
    }
  }
  const next = boundaries.find((boundary) => boundary.epochMs > epochMs);

  if (!previous || !next) {
    throw new RangeError("시장 세션 경계를 계산할 수 없습니다.");
  }

  return Object.freeze({
    market,
    session: sessionAt(parts, MARKET_SCHEDULES[market]),
    sessionEpoch: previous.epochMs,
    nextTransitionAt: next.epochMs,
  });
}

/** 기존 미국 주간거래 tr_key 규칙(KST 평일 09:00~15:30)을 순수 함수로 제공합니다. */
export function isOverseasDayTradingAt(epochMs = Date.now()): boolean {
  const parts = zonedParts(epochMs, "Asia/Seoul");
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  const localMs = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1_000;
  return localMs >= 9 * 60 * 60_000 && localMs < (15 * 60 + 30) * 60_000;
}

export interface MarketClockDependencies {
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (timer: unknown) => void;
}

export type MarketClockListener = (snapshot: MarketSnapshot) => void;

function sameSnapshot(left: MarketSnapshot, right: MarketSnapshot): boolean {
  return left.session === right.session &&
    left.sessionEpoch === right.sessionEpoch &&
    left.nextTransitionAt === right.nextTransitionAt;
}

export class MarketClock {
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly listeners = new Set<MarketClockListener>();
  private resyncTimer: unknown;
  private transitionTimer: unknown;
  private timerGeneration = 0;
  private running = false;
  private current: MarketSnapshot;

  constructor(
    readonly market: Market,
    dependencies: MarketClockDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = dependencies.clearTimeout ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    this.current = getMarketSnapshot(market, this.now());
  }

  /**
   * 즉시 재평가하고 상태가 바뀌면 구독자에게 알립니다. start/stop은 자동
   * 타이머만 제어하므로 정지 상태에서도 호출자가 명시적으로 동기화할 수 있습니다.
   */
  snapshot(): MarketSnapshot {
    this.evaluate();
    return this.current;
  }

  /** 등록 시 자동 타이머 시작 여부와 무관하게 현재 스냅샷을 정확히 한 번 전달합니다. */
  subscribe(listener: MarketClockListener): () => void {
    this.evaluate();
    this.listeners.add(listener);
    this.invoke(listener, this.current);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.evaluate();
    this.armTimers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.timerGeneration += 1;
    this.clearTimers();
  }

  private evaluate(): void {
    const next = getMarketSnapshot(this.market, this.now());
    if (sameSnapshot(this.current, next)) return;
    this.current = next;
    for (const listener of [...this.listeners]) this.invoke(listener, next);
  }

  private invoke(listener: MarketClockListener, snapshot: MarketSnapshot): void {
    try {
      const result = listener(snapshot) as unknown;
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // 한 소비자의 오류가 시계와 다른 버튼의 갱신을 중단하지 않게 격리합니다.
    }
  }

  private armTimers(): void {
    if (!this.running) return;
    const generation = ++this.timerGeneration;
    this.clearTimers();
    this.resyncTimer = this.setTimer(
      () => this.onTimer(generation),
      RESYNC_INTERVAL_MS,
    );
    const transitionDelay = Math.max(1, this.current.nextTransitionAt - this.now());
    this.transitionTimer = this.setTimer(
      () => this.onTimer(generation),
      transitionDelay,
    );
  }

  private onTimer(generation: number): void {
    if (!this.running || generation !== this.timerGeneration) return;
    this.evaluate();
    this.armTimers();
  }

  private clearTimers(): void {
    if (this.resyncTimer !== undefined) {
      this.clearTimer(this.resyncTimer);
      this.resyncTimer = undefined;
    }
    if (this.transitionTimer !== undefined) {
      this.clearTimer(this.transitionTimer);
      this.transitionTimer = undefined;
    }
  }
}
