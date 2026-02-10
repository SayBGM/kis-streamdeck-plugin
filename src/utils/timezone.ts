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
function getTimeInZone(timeZone: string): { hour: number; minute: number } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);

  return { hour, minute };
}
