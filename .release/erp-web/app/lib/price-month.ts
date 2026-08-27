import type { PriceMonth } from './erp-types';

export const PRICE_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isPriceMonth(value: unknown): value is PriceMonth {
  return typeof value === 'string' && PRICE_MONTH_PATTERN.test(value);
}

export function currentPriceMonth(date = new Date()): PriceMonth {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) return date.toISOString().slice(0, 7) as PriceMonth;
  return `${year}-${month}` as PriceMonth;
}

export function formatPriceMonth(value: PriceMonth) {
  if (!isPriceMonth(value)) return value;
  const [year, month] = value.split('-');
  return `${year}년 ${Number(month)}월`;
}
