const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const MIN_SHANGHAI_YEAR = 2000;
const MAX_SHANGHAI_YEAR = 9998;

const localDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function invalidClock(): never {
  throw new TypeError("Invalid billing period clock");
}

function nativeEpoch(value: Date): number {
  try {
    const epoch = Date.prototype.getTime.call(value);
    if (!Number.isFinite(epoch)) {
      invalidClock();
    }
    return epoch;
  } catch {
    return invalidClock();
  }
}

function localPart(
  date: Date,
  type: Intl.DateTimeFormatPartTypes,
): number {
  const value = localDateFormatter
    .formatToParts(date)
    .find((part) => part.type === type)?.value;
  if (value === undefined) {
    invalidClock();
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    invalidClock();
  }
  return number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function nextShanghaiCalendarMonth(paidAt: Date): Date {
  const paidEpoch = nativeEpoch(paidAt);
  const source = new Date(paidEpoch);
  const year = localPart(source, "year");
  const month = localPart(source, "month");
  const day = localPart(source, "day");
  const hour = localPart(source, "hour");
  const minute = localPart(source, "minute");
  const second = localPart(source, "second");
  if (year < MIN_SHANGHAI_YEAR || year > MAX_SHANGHAI_YEAR) {
    invalidClock();
  }

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  const target = new Date(
    `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-${String(nextDay).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.${String(source.getUTCMilliseconds()).padStart(3, "0")}+08:00`,
  );
  const targetEpoch = Date.prototype.getTime.call(target);
  if (!Number.isFinite(targetEpoch) || targetEpoch <= paidEpoch) {
    invalidClock();
  }
  return target;
}
