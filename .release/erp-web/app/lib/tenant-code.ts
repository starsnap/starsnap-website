import type { TenantCode } from './erp-types';

const tenantCodePattern = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

export function normalizeTenantCode(value: unknown): TenantCode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toUpperCase();
  return tenantCodePattern.test(normalized) ? normalized : null;
}

export function isTenantCode(value: unknown): value is TenantCode {
  return normalizeTenantCode(value) !== null;
}
