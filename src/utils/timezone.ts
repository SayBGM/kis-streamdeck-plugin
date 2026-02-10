/**
 * 타임존 유틸리티
 *
 * 미국 써머타임(DST)을 자동으로 반영합니다.
 * Intl.DateTimeFormat을 사용하여 시스템 타임존 DB에 의존합니다.
 *
 * 미국 DST 규칙:
 * - 시작: 3월 두 번째 일요일 02:00 (시계를 1시간 앞으로)
 * - 종료: 11월 첫 번째 일요일 02:00 (시계를 1시간 뒤로)
 * - EST (겨울): UTC-5
 * - EDT (여름): UTC-4
 */

type ZoneTime = { hour: number; minute: number };

// Intl.DateTimeFormat 생성은 비용이 크므로 타임존별로 재사용합니다.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

// 분 단위로만 달라지는 값이므로 같은 분에는 결과를 재사용합니다.
const zoneMinuteCache = new Map<string, { epochMinute: number; time: ZoneTime }>();

/**
 * 현재 미국 동부시간(ET) 기준 시:분을 분 단위로 반환
 * 써머타임(EDT/EST) 자동 반영
 */
export function getETTotalMinutes(): number {
  const { hour, minute } = getTimeInZone("America/New_York");
  return hour * 60 + minute;
}

/**
 * 현재 한국시간(KST) 기준 시:분을 분 단위로 반환
 */
export function getKSTTotalMinutes(): number {
  const { hour, minute } = getTimeInZone("Asia/Seoul");
  return hour * 60 + minute;
}

/**
 * 특정 타임존의 현재 시간을 가져옵니다
 */
function getTimeInZone(timeZone: string): ZoneTime {
  const nowMs = Date.now();
  const epochMinute = Math.floor(nowMs / 60_000);

  const cached = zoneMinuteCache.get(timeZone);
  if (cached?.epochMinute === epochMinute) {
    return cached.time;
  }

  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(new Date(nowMs));
  let hourStr = "0";
  let minuteStr = "0";
  for (const p of parts) {
    if (p.type === "hour") hourStr = p.value;
    else if (p.type === "minute") minuteStr = p.value;
  }

  const time: ZoneTime = {
    hour: parseInt(hourStr, 10) || 0,
    minute: parseInt(minuteStr, 10) || 0,
  };

  zoneMinuteCache.set(timeZone, { epochMinute, time });
  return time;
}
