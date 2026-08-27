function isValidCalendarDate(year: string, month: string, day: string) {
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const leapYear = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return yearNumber >= 1
    && monthNumber >= 1
    && monthNumber <= 12
    && dayNumber >= 1
    && dayNumber <= daysInMonth[monthNumber - 1];
}

export function formatEatDate(value: string) {
  const normalized = value.trim();
  if (!normalized) return '-';

  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(normalized)
    ?? /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(normalized)
    ?? /^(\d{4})-(\d{2})-(\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(normalized);

  if (!match || !isValidCalendarDate(match[1], match[2], match[3])) return value;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
