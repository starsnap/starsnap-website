import type { ModuleId, OrganizationType } from './erp-types';

const moduleIdsByOrganization = {
  BRAND: ['dashboard', 'partners', 'channel-orders', 'products', 'inventory', 'delivery', 'settlement'],
  DEALER: ['dashboard', 'partners', 'bids', 'channel-orders', 'products', 'inventory', 'delivery', 'settlement'],
  BIDDER: ['dashboard', 'bids', 'partners', 'channel-orders', 'products', 'meals', 'purchasing', 'inventory', 'delivery', 'settlement'],
} satisfies Record<OrganizationType, readonly ModuleId[]>;

export function moduleIdsForOrganization(organizationType: OrganizationType): readonly ModuleId[] {
  return moduleIdsByOrganization[organizationType];
}
