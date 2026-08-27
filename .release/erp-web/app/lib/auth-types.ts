import type { TenantSummary } from './erp-types';

export type AuthRole = 'viewer' | 'operator' | 'admin';

export interface AuthMembership {
  role: AuthRole;
  tenant: TenantSummary;
}

export interface AuthSession {
  user: {
    id: string;
    username: string;
    email: string;
  };
  memberships: AuthMembership[];
  expiresAt: string;
}

export type AuthSessionResponse =
  | { authenticated: false }
  | ({ authenticated: true } & AuthSession);
