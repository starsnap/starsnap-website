export type EatBidLookupSource = 'CACHE' | 'EAT' | 'STALE_CACHE';

export interface EatBidQuery {
  announcementStartDate: string;
  announcementEndDate: string;
  useOrganizationName: string;
  demandOrganizationName: string;
  bidName: string;
  page: number;
  pageSize: number;
}

export interface EatBidItemSpec {
  id: string;
  messageOrder: number;
  itemOrder: number;
  orderingInstitutionName: string;
  itemName: string;
  foodName: string;
  specification: string;
  unitName: string;
  attributes: string;
  quantity: string;
}

export interface EatBidAnnouncement {
  bidNo: string;
  bidName: string;
  statusName: string;
  announcementDate: string;
  announcementTime: string;
  purchasingOrganizationName: string;
  demandOrganizationName: string;
  bidStartDate: string;
  bidEndDate: string;
  bidOpenDate: string;
  bidOpenTime: string;
  deliveryStartDate: string;
  deliveryEndDate: string;
  deliveryAddress: string;
  basePrice: string;
  itemName: string;
  specs: EatBidItemSpec[];
}

export interface EatBidLookupResponse {
  query: EatBidQuery;
  source: EatBidLookupSource;
  cachedAt: string;
  expiresAt: string;
  warning?: string;
  total: number;
  page: number;
  pageSize: number;
  items: EatBidAnnouncement[];
}
