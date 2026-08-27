import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (value) => `[${value.join(',')}]`,
  fromDriver: (value) => {
    const content = value.slice(1, -1).trim();
    return content ? content.split(',').map(Number) : [];
  },
});

const auditColumns = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  organizationType: text('organization_type').notNull().default('BIDDER'),
  status: text('status').notNull().default('ACTIVE'),
  brandColor: text('brand_color').notNull().default('#17324D'),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_tenants_code').on(table.code),
  check('chk_tenants_organization_type', sql`${table.organizationType} IN ('BRAND', 'DEALER', 'BIDDER')`),
]);

export const administrativeAreas = pgTable('administrative_areas', {
  code: text('code').primaryKey(),
  parentCode: text('parent_code'),
  provinceCode: text('province_code').notNull(),
  name: text('name').notNull(),
  localName: text('local_name').notNull(),
  fullName: text('full_name').notNull(),
  level: text('level').notNull(),
  selectable: boolean('selectable').notNull().default(false),
  active: boolean('active').notNull().default(true),
  dataVersion: text('data_version').notNull(),
  ...auditColumns,
}, (table) => [
  index('idx_administrative_areas_parent_active').on(table.parentCode, table.active),
  index('idx_administrative_areas_province_level').on(table.provinceCode, table.level, table.active),
  check('chk_administrative_areas_code', sql`${table.code} ~ '^[0-9]{2}([0-9]{3})?$'`),
  check('chk_administrative_areas_province_code', sql`${table.provinceCode} ~ '^[0-9]{2}$'`),
  check(
    'chk_administrative_areas_level',
    sql`${table.level} IN ('SIDO', 'CITY_COUNTY', 'ADMIN_DISTRICT')`,
  ),
  check(
    'chk_administrative_areas_parent',
    sql`(${table.level} = 'SIDO' AND ${table.parentCode} IS NULL)
      OR (${table.level} <> 'SIDO' AND ${table.parentCode} IS NOT NULL)`,
  ),
  foreignKey({
    columns: [table.parentCode],
    foreignColumns: [table.code],
    name: 'fk_administrative_areas_parent',
  }),
]);

export const schoolSyncRuns = pgTable('school_sync_runs', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  sourceDataVersion: text('source_data_version'),
  status: text('status').notNull().default('RUNNING'),
  expectedCount: integer('expected_count'),
  processedCount: integer('processed_count').notNull().default(0),
  mappedCount: integer('mapped_count').notNull().default(0),
  deactivatedCount: integer('deactivated_count').notNull().default(0),
  errorMessage: text('error_message'),
  startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true, mode: 'string' }),
}, (table) => [
  uniqueIndex('uq_school_sync_runs_running_source')
    .on(table.source)
    .where(sql`${table.status} = 'RUNNING'`),
  index('idx_school_sync_runs_source_started').on(table.source, table.startedAt.desc()),
  check('chk_school_sync_runs_status', sql`${table.status} IN ('RUNNING', 'COMPLETED', 'FAILED')`),
  check('chk_school_sync_runs_expected_count', sql`${table.expectedCount} IS NULL OR ${table.expectedCount} >= 0`),
  check('chk_school_sync_runs_processed_count', sql`${table.processedCount} >= 0`),
  check('chk_school_sync_runs_mapped_count', sql`${table.mappedCount} >= 0`),
  check('chk_school_sync_runs_deactivated_count', sql`${table.deactivatedCount} >= 0`),
  check(
    'chk_school_sync_runs_completion',
    sql`(${table.status} = 'RUNNING' AND ${table.completedAt} IS NULL)
      OR (${table.status} IN ('COMPLETED', 'FAILED') AND ${table.completedAt} IS NOT NULL)`,
  ),
]);

export const schools = pgTable('schools', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  sourceOfficeCode: text('source_office_code').notNull(),
  sourceSchoolCode: text('source_school_code').notNull(),
  name: text('name').notNull(),
  englishName: text('english_name'),
  schoolKind: text('school_kind').notNull(),
  educationOfficeName: text('education_office_name'),
  jurisdictionOrgName: text('jurisdiction_org_name'),
  foundationType: text('foundation_type'),
  locationName: text('location_name'),
  postalCode: text('postal_code'),
  roadAddress: text('road_address').notNull(),
  roadDetailAddress: text('road_detail_address'),
  phone: text('phone'),
  fax: text('fax'),
  homepage: text('homepage'),
  coeducationType: text('coeducation_type'),
  dayNightType: text('day_night_type'),
  foundationDate: text('foundation_date'),
  anniversaryDate: text('anniversary_date'),
  sourceUpdatedAt: text('source_updated_at'),
  sourcePayload: jsonb('source_payload').$type<Record<string, unknown>>().notNull().default({}),
  areaCode: text('area_code').references(() => administrativeAreas.code),
  mappingStatus: text('mapping_status').notNull().default('UNMAPPED'),
  active: boolean('active').notNull().default(false),
  missingSyncCount: integer('missing_sync_count').notNull().default(0),
  lastSeenRunId: text('last_seen_run_id').notNull().references(() => schoolSyncRuns.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('uq_schools_external_identity').on(
    table.source,
    table.sourceOfficeCode,
    table.sourceSchoolCode,
  ),
  index('idx_schools_name_trgm').using('gin', sql`lower(${table.name}) gin_trgm_ops`),
  index('idx_schools_road_address_trgm').using('gin', sql`lower(${table.roadAddress}) gin_trgm_ops`),
  index('idx_schools_source_active').on(
    table.source,
    table.active,
    table.sourceOfficeCode,
    table.sourceSchoolCode,
  ),
  index('idx_schools_area_active').on(table.areaCode, table.active, table.name),
  index('idx_schools_last_seen_run').on(table.lastSeenRunId),
  check(
    'chk_schools_external_identity',
    sql`btrim(${table.source}) <> ''
      AND btrim(${table.sourceOfficeCode}) <> ''
      AND btrim(${table.sourceSchoolCode}) <> ''`,
  ),
  check(
    'chk_schools_required_text',
    sql`btrim(${table.name}) <> ''
      AND btrim(${table.schoolKind}) <> ''
      AND btrim(${table.roadAddress}) <> ''`,
  ),
  check('chk_schools_mapping_status', sql`${table.mappingStatus} IN ('MAPPED', 'UNMAPPED', 'REVIEW_REQUIRED')`),
  check('chk_schools_missing_sync_count', sql`${table.missingSyncCount} >= 0`),
  check(
    'chk_schools_area_mapping',
    sql`(${table.mappingStatus} = 'MAPPED' AND ${table.areaCode} IS NOT NULL)
      OR (${table.mappingStatus} IN ('UNMAPPED', 'REVIEW_REQUIRED') AND ${table.areaCode} IS NULL)`,
  ),
]);

export const eatBidQueryCache = pgTable('eat_bid_query_cache', {
  queryHash: text('query_hash').primaryKey(),
  normalizedFilters: jsonb('normalized_filters').$type<Record<string, string>>().notNull(),
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
  page: integer('page').notNull(),
  pageSize: integer('page_size').notNull(),
  totalCount: integer('total_count').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'string' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
  index('idx_eat_bid_query_cache_expiry').on(table.expiresAt),
  index('idx_eat_bid_query_cache_last_accessed').on(table.lastAccessedAt),
  check('chk_eat_bid_query_cache_hash', sql`${table.queryHash} ~ '^[0-9a-f]{64}$'`),
  check('chk_eat_bid_query_cache_filters', sql`jsonb_typeof(${table.normalizedFilters}) = 'object'`),
  check('chk_eat_bid_query_cache_page', sql`${table.page} > 0`),
  check('chk_eat_bid_query_cache_page_size', sql`${table.pageSize} > 0`),
  check('chk_eat_bid_query_cache_total_count', sql`${table.totalCount} >= 0`),
  check('chk_eat_bid_query_cache_dates', sql`${table.startDate} <= ${table.endDate}`),
  check('chk_eat_bid_query_cache_expiry', sql`${table.expiresAt} > ${table.fetchedAt}`),
  check('chk_eat_bid_query_cache_access', sql`${table.lastAccessedAt} >= ${table.fetchedAt}`),
]);

export const eatBidAnnouncements = pgTable('eat_bid_announcements', {
  queryHash: text('query_hash')
    .notNull()
    .references(() => eatBidQueryCache.queryHash, { onDelete: 'cascade' }),
  bidNo: text('bid_no').notNull(),
  bidName: text('bid_name').notNull().default(''),
  statusName: text('status_name').notNull().default(''),
  announcementDate: text('announcement_date').notNull().default(''),
  announcementTime: text('announcement_time').notNull().default(''),
  purchasingOrganizationName: text('purchasing_organization_name').notNull().default(''),
  demandOrganizationName: text('demand_organization_name').notNull().default(''),
  bidStartDate: text('bid_start_date').notNull().default(''),
  bidEndDate: text('bid_end_date').notNull().default(''),
  bidOpenDate: text('bid_open_date').notNull().default(''),
  bidOpenTime: text('bid_open_time').notNull().default(''),
  deliveryStartDate: text('delivery_start_date').notNull().default(''),
  deliveryEndDate: text('delivery_end_date').notNull().default(''),
  deliveryAddress: text('delivery_address').notNull().default(''),
  basePriceText: text('base_price_text').notNull().default(''),
  itemName: text('item_name').notNull().default(''),
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull().default({}),
  fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'string' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.queryHash, table.bidNo] }),
  index('idx_eat_bid_announcements_demand_org').on(
    table.queryHash,
    table.demandOrganizationName,
    table.announcementDate.desc(),
  ),
  index('idx_eat_bid_announcements_bid_date').on(
    table.queryHash,
    table.announcementDate.desc(),
    table.bidNo,
  ),
  check('chk_eat_bid_announcements_bid_no', sql`btrim(${table.bidNo}) <> ''`),
  check('chk_eat_bid_announcements_payload', sql`jsonb_typeof(${table.rawPayload}) = 'object'`),
]);

export const eatBidItemSpecs = pgTable('eat_bid_item_specs', {
  queryHash: text('query_hash').notNull(),
  specId: text('spec_id').notNull(),
  bidNo: text('bid_no').notNull(),
  messageOrder: integer('message_order').notNull(),
  itemOrder: integer('item_order').notNull(),
  instName: text('inst_name').notNull().default(''),
  itemName: text('item_name').notNull().default(''),
  foodName: text('food_name').notNull().default(''),
  specification: text('specification').notNull().default(''),
  unitName: text('unit_name').notNull().default(''),
  attributes: text('attributes').notNull().default(''),
  quantityText: text('quantity_text').notNull().default(''),
  rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().notNull().default({}),
}, (table) => [
  primaryKey({ columns: [table.queryHash, table.specId] }),
  foreignKey({
    columns: [table.queryHash, table.bidNo],
    foreignColumns: [eatBidAnnouncements.queryHash, eatBidAnnouncements.bidNo],
    name: 'fk_eat_bid_item_specs_announcement',
  }).onDelete('cascade'),
  uniqueIndex('uq_eat_bid_item_specs_position').on(
    table.queryHash,
    table.bidNo,
    table.messageOrder,
    table.itemOrder,
  ),
  index('idx_eat_bid_item_specs_food_name').on(table.queryHash, table.foodName),
  check('chk_eat_bid_item_specs_id', sql`btrim(${table.specId}) <> ''`),
  check('chk_eat_bid_item_specs_message_order', sql`${table.messageOrder} >= 0`),
  check('chk_eat_bid_item_specs_item_order', sql`${table.itemOrder} >= 0`),
  check('chk_eat_bid_item_specs_payload', sql`jsonb_typeof(${table.rawPayload}) = 'object'`),
]);

export const eatBidQueryResults = pgTable('eat_bid_query_results', {
  queryHash: text('query_hash')
    .notNull()
    .references(() => eatBidQueryCache.queryHash, { onDelete: 'cascade' }),
  bidNo: text('bid_no').notNull(),
  position: integer('position').notNull(),
}, (table) => [
  primaryKey({ columns: [table.queryHash, table.bidNo] }),
  foreignKey({
    columns: [table.queryHash, table.bidNo],
    foreignColumns: [eatBidAnnouncements.queryHash, eatBidAnnouncements.bidNo],
    name: 'fk_eat_bid_query_results_announcement',
  }).onDelete('cascade'),
  uniqueIndex('uq_eat_bid_query_results_position').on(table.queryHash, table.position),
  index('idx_eat_bid_query_results_bid').on(table.bidNo, table.queryHash),
  check('chk_eat_bid_query_results_position', sql`${table.position} >= 0`),
]);

export const brandDealerAssignments = pgTable('brand_dealer_assignments', {
  id: text('id').primaryKey(),
  brandTenantId: text('brand_tenant_id').notNull().references(() => tenants.id),
  dealerTenantId: text('dealer_tenant_id').notNull().references(() => tenants.id),
  region: text('region').notNull(),
  status: text('status').notNull().default('ACTIVE'),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_brand_dealer_pair').on(table.brandTenantId, table.dealerTenantId),
  uniqueIndex('uq_active_brand_per_dealer')
    .on(table.dealerTenantId)
    .where(sql`${table.status} = 'ACTIVE'`),
  index('idx_brand_dealer_brand_status').on(table.brandTenantId, table.status),
  index('idx_brand_dealer_dealer_status').on(table.dealerTenantId, table.status),
  check('chk_brand_dealer_distinct', sql`${table.brandTenantId} <> ${table.dealerTenantId}`),
  check('chk_brand_dealer_status', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
]);

export const brandDealerRegions = pgTable('brand_dealer_regions', {
  assignmentId: text('assignment_id')
    .notNull()
    .references(() => brandDealerAssignments.id, { onDelete: 'cascade' }),
  regionCode: text('region_code').notNull(),
  ...auditColumns,
}, (table) => [
  primaryKey({ columns: [table.assignmentId, table.regionCode] }),
  index('idx_brand_dealer_regions_code').on(table.regionCode, table.assignmentId),
  check(
    'chk_brand_dealer_regions_code',
    sql`${table.regionCode} IN ('SEOUL', 'BUSAN', 'DAEGU', 'INCHEON', 'GWANGJU', 'DAEJEON', 'ULSAN', 'SEJONG', 'GYEONGGI', 'GANGWON', 'CHUNGBUK', 'CHUNGNAM', 'JEONBUK', 'JEONNAM', 'GYEONGBUK', 'GYEONGNAM', 'JEJU')`,
  ),
]);

export const brandDealerAreas = pgTable('brand_dealer_areas', {
  assignmentId: text('assignment_id')
    .notNull()
    .references(() => brandDealerAssignments.id, { onDelete: 'cascade' }),
  areaCode: text('area_code').notNull().references(() => administrativeAreas.code),
  ...auditColumns,
}, (table) => [
  primaryKey({ columns: [table.assignmentId, table.areaCode] }),
  index('idx_brand_dealer_areas_code').on(table.areaCode, table.assignmentId),
]);

export const dealerBidderLinks = pgTable('dealer_bidder_links', {
  id: text('id').primaryKey(),
  dealerTenantId: text('dealer_tenant_id').notNull().references(() => tenants.id),
  bidderTenantId: text('bidder_tenant_id').notNull().references(() => tenants.id),
  status: text('status').notNull().default('ACTIVE'),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_dealer_bidder_pair').on(table.dealerTenantId, table.bidderTenantId),
  index('idx_dealer_bidder_dealer_status').on(table.dealerTenantId, table.status),
  index('idx_dealer_bidder_bidder_status').on(table.bidderTenantId, table.status),
  check('chk_dealer_bidder_distinct', sql`${table.dealerTenantId} <> ${table.bidderTenantId}`),
  check('chk_dealer_bidder_status', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
]);

export const bidderTargetRegions = pgTable('bidder_target_regions', {
  bidderTenantId: text('bidder_tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  regionCode: text('region_code').notNull(),
  ...auditColumns,
}, (table) => [
  primaryKey({ columns: [table.bidderTenantId, table.regionCode] }),
  index('idx_bidder_target_regions_code').on(table.regionCode, table.bidderTenantId),
  check(
    'chk_bidder_target_regions_code',
    sql`${table.regionCode} IN ('SEOUL', 'BUSAN', 'DAEGU', 'INCHEON', 'GWANGJU', 'DAEJEON', 'ULSAN', 'SEJONG', 'GYEONGGI', 'GANGWON', 'CHUNGBUK', 'CHUNGNAM', 'JEONBUK', 'JEONNAM', 'GYEONGBUK', 'GYEONGNAM', 'JEJU')`,
  ),
]);

export const bidderTargetAreas = pgTable('bidder_target_areas', {
  bidderTenantId: text('bidder_tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  areaCode: text('area_code').notNull().references(() => administrativeAreas.code),
  ...auditColumns,
}, (table) => [
  primaryKey({ columns: [table.bidderTenantId, table.areaCode] }),
  index('idx_bidder_target_areas_code').on(table.areaCode, table.bidderTenantId),
]);

export const schoolBids = pgTable('school_bids', {
  id: text('id').primaryKey(),
  bidderTenantId: text('bidder_tenant_id').notNull().references(() => tenants.id),
  bidNo: text('bid_no').notNull(),
  schoolId: text('school_id').references(() => schools.id),
  schoolName: text('school_name').notNull(),
  schoolAddress: text('school_address'),
  title: text('title').notNull(),
  region: text('region').notNull(),
  regionCode: text('region_code'),
  areaCode: text('area_code').references(() => administrativeAreas.code),
  awardedAt: text('awarded_at').notNull(),
  contractStart: text('contract_start').notNull(),
  contractEnd: text('contract_end').notNull(),
  contractAmount: integer('contract_amount').notNull(),
  status: text('status').notNull().default('AWARDED'),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_school_bids_bidder_no').on(table.bidderTenantId, table.bidNo),
  uniqueIndex('uq_school_bids_bidder_id').on(table.bidderTenantId, table.id),
  index('idx_school_bids_bidder_status').on(table.bidderTenantId, table.status),
  index('idx_school_bids_region_status').on(table.regionCode, table.status),
  index('idx_school_bids_area_status').on(table.areaCode, table.status),
  index('idx_school_bids_school_status').on(table.schoolId, table.status),
  check('chk_school_bids_amount', sql`${table.contractAmount} >= 0`),
  check('chk_school_bids_dates', sql`${table.contractStart} <= ${table.contractEnd}`),
  check('chk_school_bids_status', sql`${table.status} IN ('AWARDED', 'ACTIVE', 'CLOSED')`),
  check(
    'chk_school_bids_region_code',
    sql`${table.regionCode} IS NULL OR ${table.regionCode} IN ('SEOUL', 'BUSAN', 'DAEGU', 'INCHEON', 'GWANGJU', 'DAEJEON', 'ULSAN', 'SEJONG', 'GYEONGGI', 'GANGWON', 'CHUNGBUK', 'CHUNGNAM', 'JEONBUK', 'JEONNAM', 'GYEONGBUK', 'GYEONGNAM', 'JEJU')`,
  ),
  check(
    'chk_school_bids_school_snapshot',
    sql`${table.schoolId} IS NULL
      OR (
        ${table.schoolAddress} IS NOT NULL
        AND btrim(${table.schoolAddress}) <> ''
        AND ${table.areaCode} IS NOT NULL
      )`,
  ),
]);

export const channelOrders = pgTable('channel_orders', {
  id: text('id').primaryKey(),
  orderNo: text('order_no').notNull(),
  direction: text('direction').notNull(),
  buyerTenantId: text('buyer_tenant_id').notNull().references(() => tenants.id),
  supplierTenantId: text('supplier_tenant_id').notNull().references(() => tenants.id),
  schoolBidId: text('school_bid_id'),
  deliveryDate: text('delivery_date').notNull(),
  totalAmount: integer('total_amount').notNull(),
  itemCount: integer('item_count').notNull(),
  note: text('note').notNull().default(''),
  status: text('status').notNull().default('REQUESTED'),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_channel_orders_buyer_no').on(table.buyerTenantId, table.orderNo),
  index('idx_channel_orders_buyer_status').on(table.buyerTenantId, table.status),
  index('idx_channel_orders_supplier_status').on(table.supplierTenantId, table.status),
  index('idx_channel_orders_school_bid').on(table.schoolBidId),
  check('chk_channel_orders_distinct', sql`${table.buyerTenantId} <> ${table.supplierTenantId}`),
  check('chk_channel_orders_direction', sql`${table.direction} IN ('BIDDER_TO_DEALER', 'DEALER_TO_BRAND')`),
  check('chk_channel_orders_amount', sql`${table.totalAmount} >= 0`),
  check('chk_channel_orders_item_count', sql`${table.itemCount} > 0`),
  check(
    'chk_channel_orders_status',
    sql`${table.status} IN ('REQUESTED', 'ACCEPTED', 'SHIPPED', 'COMPLETED', 'REJECTED', 'CANCELLED')`,
  ),
  check(
    'chk_channel_orders_bid_direction',
    sql`(${table.direction} = 'BIDDER_TO_DEALER' AND ${table.schoolBidId} IS NOT NULL)
      OR (${table.direction} = 'DEALER_TO_BRAND' AND ${table.schoolBidId} IS NULL)`,
  ),
  foreignKey({
    columns: [table.buyerTenantId, table.schoolBidId],
    foreignColumns: [schoolBids.bidderTenantId, schoolBids.id],
    name: 'fk_channel_orders_bidder_school_bid',
  }),
]);

export const erpUsers = pgTable('erp_users', {
  id: text('id').primaryKey(),
  username: text('username').notNull(),
  usernameNormalized: text('username_normalized').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'string' }).notNull(),
  status: text('status').notNull().default('ACTIVE'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => [
  check('chk_erp_users_status', sql`${table.status} IN ('ACTIVE', 'LOCKED', 'DISABLED')`),
  check(
    'chk_erp_users_username_policy',
    sql`${table.username} ~ '^[A-Za-z0-9]{4,12}$'
      AND ${table.usernameNormalized} ~ '^[a-z0-9]{4,12}$'
      AND lower(${table.username}) = ${table.usernameNormalized}`,
  ),
]);

export const tenantMemberships = pgTable('tenant_memberships', {
  userId: text('user_id').notNull().references(() => erpUsers.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.tenantId] }),
  index('idx_tenant_memberships_tenant').on(table.tenantId, table.userId),
  check('chk_tenant_memberships_role', sql`${table.role} IN ('viewer', 'operator', 'admin')`),
]);

export const authSessions = pgTable('auth_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => erpUsers.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => [
  index('idx_auth_sessions_user').on(table.userId, table.expiresAt.desc()),
  index('idx_auth_sessions_expiry').on(table.expiresAt),
]);

export const emailVerificationChallenges = pgTable('email_verification_challenges', {
  id: text('id').primaryKey(),
  emailNormalized: text('email_normalized').notNull(),
  codeMac: text('code_mac').notNull(),
  verificationTokenHash: text('verification_token_hash').unique(),
  attemptCount: integer('attempt_count').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'string' }),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
}, (table) => [
  index('idx_email_verification_active')
    .on(table.emailNormalized, table.createdAt.desc())
    .where(sql`${table.consumedAt} IS NULL`),
  index('idx_email_verification_expiry').on(table.expiresAt),
  check('chk_email_verification_attempts', sql`${table.attemptCount} BETWEEN 0 AND 20`),
]);

export const authRateLimits = pgTable('auth_rate_limits', {
  action: text('action').notNull(),
  scopeHash: text('scope_hash').notNull(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  attemptCount: integer('attempt_count').notNull().default(1),
}, (table) => [
  primaryKey({ columns: [table.action, table.scopeHash] }),
  index('idx_auth_rate_limits_window').on(table.windowStartedAt),
  check('chk_auth_rate_limits_attempts', sql`${table.attemptCount} >= 1`),
]);

export const sites = pgTable('sites', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  timezone: text('timezone').notNull().default('Asia/Seoul'),
  active: boolean('active').notNull().default(true),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_sites_tenant_code').on(table.tenantId, table.code),
  uniqueIndex('uq_sites_tenant_id').on(table.tenantId, table.id),
  index('idx_sites_tenant').on(table.tenantId),
]);

export const products = pgTable('products', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  specification: text('specification').notNull(),
  unit: text('unit').notNull(),
  legacyUnitPrice: integer('unit_price').notNull(),
  schoolPriceKg: integer('school_price_kg').notNull().default(0),
  schoolPriceSpec: integer('school_price_spec').notNull().default(0),
  schoolPriceEach: integer('school_price_each').notNull().default(0),
  vendorPriceKg: integer('vendor_price_kg').notNull().default(0),
  vendorPriceSpec: integer('vendor_price_spec').notNull().default(0),
  vendorPriceEach: integer('vendor_price_each').notNull().default(0),
  purchasePriceKg: integer('purchase_price_kg').notNull().default(0),
  purchasePriceSpec: integer('purchase_price_spec').notNull().default(0),
  purchasePriceEach: integer('purchase_price_each').notNull().default(0),
  supplierName: text('supplier_name').notNull(),
  storageType: text('storage_type').notNull(),
  allergens: text('allergens').notNull().default(''),
  status: text('status').notNull().default('ACTIVE'),
  version: integer('version').notNull().default(1),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_products_tenant_sku').on(table.tenantId, table.sku),
  uniqueIndex('uq_products_tenant_id').on(table.tenantId, table.id),
  index('idx_products_tenant_name').on(table.tenantId, table.name),
  index('idx_products_tenant_status').on(table.tenantId, table.status),
  check('chk_products_unit_price_nonnegative', sql`${table.legacyUnitPrice} >= 0`),
  check('chk_products_unit_price_max', sql`${table.legacyUnitPrice} <= 100000000`),
  check('chk_products_school_price_kg_range', sql`${table.schoolPriceKg} BETWEEN 0 AND 100000000`),
  check('chk_products_school_price_spec_range', sql`${table.schoolPriceSpec} BETWEEN 0 AND 100000000`),
  check('chk_products_school_price_each_range', sql`${table.schoolPriceEach} BETWEEN 0 AND 100000000`),
  check('chk_products_vendor_price_kg_range', sql`${table.vendorPriceKg} BETWEEN 0 AND 100000000`),
  check('chk_products_vendor_price_spec_range', sql`${table.vendorPriceSpec} BETWEEN 0 AND 100000000`),
  check('chk_products_vendor_price_each_range', sql`${table.vendorPriceEach} BETWEEN 0 AND 100000000`),
  check('chk_products_purchase_price_kg_range', sql`${table.purchasePriceKg} BETWEEN 0 AND 100000000`),
  check('chk_products_purchase_price_spec_range', sql`${table.purchasePriceSpec} BETWEEN 0 AND 100000000`),
  check('chk_products_purchase_price_each_range', sql`${table.purchasePriceEach} BETWEEN 0 AND 100000000`),
  check('chk_products_version_positive', sql`${table.version} >= 1`),
]);

export const productMonthlyPrices = pgTable('product_monthly_prices', {
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  productId: text('product_id').notNull(),
  priceMonth: text('price_month').notNull(),
  schoolPriceKg: integer('school_price_kg').notNull(),
  schoolPriceSpec: integer('school_price_spec').notNull(),
  schoolPriceEach: integer('school_price_each').notNull(),
  vendorPriceKg: integer('vendor_price_kg').notNull(),
  vendorPriceSpec: integer('vendor_price_spec').notNull(),
  vendorPriceEach: integer('vendor_price_each').notNull(),
  purchasePriceKg: integer('purchase_price_kg').notNull(),
  purchasePriceSpec: integer('purchase_price_spec').notNull(),
  purchasePriceEach: integer('purchase_price_each').notNull(),
  priceVersion: integer('price_version').notNull().default(1),
  ...auditColumns,
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.productId, table.priceMonth] }),
  index('idx_product_monthly_prices_tenant_month').on(table.tenantId, table.priceMonth, table.productId),
  check(
    'chk_product_monthly_prices_month',
    sql`length(${table.priceMonth}) = 7
      AND ${table.priceMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
  ),
  check('chk_product_monthly_prices_school_kg', sql`${table.schoolPriceKg} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_school_spec', sql`${table.schoolPriceSpec} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_school_each', sql`${table.schoolPriceEach} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_vendor_kg', sql`${table.vendorPriceKg} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_vendor_spec', sql`${table.vendorPriceSpec} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_vendor_each', sql`${table.vendorPriceEach} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_purchase_kg', sql`${table.purchasePriceKg} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_purchase_spec', sql`${table.purchasePriceSpec} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_purchase_each', sql`${table.purchasePriceEach} BETWEEN 0 AND 100000000`),
  check('chk_product_monthly_prices_version', sql`${table.priceVersion} >= 1`),
  foreignKey({
    columns: [table.tenantId, table.productId],
    foreignColumns: [products.tenantId, products.id],
    name: 'fk_product_monthly_prices_product',
  }),
]);

export const mealPlans = pgTable('meal_plans', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  siteId: text('site_id').notNull(),
  serviceDate: text('service_date').notNull(),
  mealType: text('meal_type').notNull(),
  menuName: text('menu_name').notNull(),
  plannedServings: integer('planned_servings').notNull(),
  actualServings: integer('actual_servings'),
  allergens: text('allergens').notNull().default(''),
  status: text('status').notNull(),
  ...auditColumns,
}, (table) => [
  index('idx_meal_plans_tenant_date').on(table.tenantId, table.serviceDate),
  index('idx_meal_plans_tenant_status').on(table.tenantId, table.status),
  foreignKey({
    columns: [table.tenantId, table.siteId],
    foreignColumns: [sites.tenantId, sites.id],
    name: 'fk_meal_plans_tenant_site',
  }),
]);

export const purchaseOrders = pgTable('purchase_orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  siteId: text('site_id').notNull(),
  orderNo: text('order_no').notNull(),
  supplierName: text('supplier_name').notNull(),
  deliveryDate: text('delivery_date').notNull(),
  totalAmount: integer('total_amount').notNull(),
  itemCount: integer('item_count').notNull(),
  status: text('status').notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_purchase_orders_tenant_no').on(table.tenantId, table.orderNo),
  index('idx_purchase_orders_tenant_status').on(table.tenantId, table.status),
  foreignKey({
    columns: [table.tenantId, table.siteId],
    foreignColumns: [sites.tenantId, sites.id],
    name: 'fk_purchase_orders_tenant_site',
  }),
]);

export const inventoryLots = pgTable('inventory_lots', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  siteId: text('site_id').notNull(),
  ingredientName: text('ingredient_name').notNull(),
  lotNo: text('lot_no').notNull(),
  quantity: integer('quantity').notNull(),
  unit: text('unit').notNull(),
  expiresAt: text('expires_at').notNull(),
  location: text('location').notNull(),
  status: text('status').notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_inventory_lots_tenant_lot').on(table.tenantId, table.lotNo),
  index('idx_inventory_lots_tenant_expiry').on(table.tenantId, table.expiresAt),
  index('idx_inventory_lots_tenant_status').on(table.tenantId, table.status),
  check('chk_inventory_quantity_nonnegative', sql`${table.quantity} >= 0`),
  foreignKey({
    columns: [table.tenantId, table.siteId],
    foreignColumns: [sites.tenantId, sites.id],
    name: 'fk_inventory_lots_tenant_site',
  }),
]);

export const productionOrders = pgTable('production_orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  siteId: text('site_id').notNull(),
  serviceDate: text('service_date').notNull(),
  menuName: text('menu_name').notNull(),
  plannedQuantity: integer('planned_quantity').notNull(),
  actualQuantity: integer('actual_quantity'),
  coreTemperature: integer('core_temperature'),
  status: text('status').notNull(),
  ...auditColumns,
}, (table) => [
  index('idx_production_orders_tenant_date').on(table.tenantId, table.serviceDate),
  index('idx_production_orders_tenant_status').on(table.tenantId, table.status),
  foreignKey({
    columns: [table.tenantId, table.siteId],
    foreignColumns: [sites.tenantId, sites.id],
    name: 'fk_production_orders_tenant_site',
  }),
]);

export const deliveries = pgTable('deliveries', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  siteId: text('site_id').notNull(),
  deliveryNo: text('delivery_no').notNull(),
  scheduledAt: text('scheduled_at').notNull(),
  driverName: text('driver_name').notNull(),
  vehicleNo: text('vehicle_no').notNull(),
  servings: integer('servings').notNull(),
  temperature: integer('temperature'),
  status: text('status').notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_deliveries_tenant_no').on(table.tenantId, table.deliveryNo),
  index('idx_deliveries_tenant_status').on(table.tenantId, table.status),
  foreignKey({
    columns: [table.tenantId, table.siteId],
    foreignColumns: [sites.tenantId, sites.id],
    name: 'fk_deliveries_tenant_site',
  }),
]);

export const settlements = pgTable('settlements', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  siteId: text('site_id').notNull(),
  settlementMonth: text('settlement_month').notNull(),
  actualServings: integer('actual_servings').notNull(),
  salesAmount: integer('sales_amount').notNull(),
  ingredientCost: integer('ingredient_cost').notNull(),
  status: text('status').notNull(),
  ...auditColumns,
}, (table) => [
  uniqueIndex('uq_settlements_tenant_site_month').on(table.tenantId, table.siteId, table.settlementMonth),
  index('idx_settlements_tenant_month').on(table.tenantId, table.settlementMonth),
  foreignKey({
    columns: [table.tenantId, table.siteId],
    foreignColumns: [sites.tenantId, sites.id],
    name: 'fk_settlements_tenant_site',
  }),
]);

export const haccpChecks = pgTable('haccp_checks', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  siteId: text('site_id').notNull(),
  checkDate: text('check_date').notNull(),
  category: text('category').notNull(),
  itemName: text('item_name').notNull(),
  measuredValue: text('measured_value').notNull(),
  assigneeName: text('assignee_name').notNull(),
  correctiveAction: text('corrective_action'),
  verificationValue: text('verification_value'),
  verifiedBy: text('verified_by'),
  verifiedAt: text('verified_at'),
  status: text('status').notNull(),
  ...auditColumns,
}, (table) => [
  index('idx_haccp_checks_tenant_date').on(table.tenantId, table.checkDate),
  index('idx_haccp_checks_tenant_status').on(table.tenantId, table.status),
  foreignKey({
    columns: [table.tenantId, table.siteId],
    foreignColumns: [sites.tenantId, sites.id],
    name: 'fk_haccp_checks_tenant_site',
  }),
]);

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').notNull(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  requestHash: text('request_hash').notNull(),
  responseJson: text('response_json').notNull(),
  leaseToken: text('lease_token').notNull().default(''),
  leaseExpiresAt: text('lease_expires_at'),
  createdAt: text('created_at').notNull(),
}, (table) => [primaryKey({ columns: [table.tenantId, table.key] })]);

export const productBulkStaging = pgTable('product_bulk_staging', {
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  idempotencyKey: text('idempotency_key').notNull(),
  leaseToken: text('lease_token').notNull(),
  rowNumber: integer('row_number').notNull(),
  action: text('action').notNull(),
  productId: text('product_id').notNull(),
  expectedVersion: integer('expected_version'),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  category: text('category').notNull(),
  specification: text('specification').notNull(),
  unit: text('unit').notNull(),
  schoolPriceKg: integer('school_price_kg').notNull(),
  schoolPriceSpec: integer('school_price_spec').notNull(),
  schoolPriceEach: integer('school_price_each').notNull(),
  vendorPriceKg: integer('vendor_price_kg').notNull(),
  vendorPriceSpec: integer('vendor_price_spec').notNull(),
  vendorPriceEach: integer('vendor_price_each').notNull(),
  purchasePriceKg: integer('purchase_price_kg').notNull(),
  purchasePriceSpec: integer('purchase_price_spec').notNull(),
  purchasePriceEach: integer('purchase_price_each').notNull(),
  supplierName: text('supplier_name').notNull(),
  storageType: text('storage_type').notNull(),
  allergens: text('allergens').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.idempotencyKey, table.leaseToken, table.rowNumber] }),
  check('chk_product_bulk_staging_action', sql`${table.action} IN ('create', 'update')`),
  index('idx_product_bulk_staging_scope_action').on(
    table.tenantId,
    table.idempotencyKey,
    table.leaseToken,
    table.action,
  ),
  index('idx_product_bulk_staging_created_at').on(table.createdAt),
]);

export const productPriceBulkStaging = pgTable('product_price_bulk_staging', {
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  idempotencyKey: text('idempotency_key').notNull(),
  leaseToken: text('lease_token').notNull(),
  rowNumber: integer('row_number').notNull(),
  productId: text('product_id').notNull(),
  expectedVersion: integer('expected_version').notNull(),
  expectedSourceMonth: text('expected_source_month'),
  expectedSourceVersion: integer('expected_source_version').notNull(),
  schoolPriceKg: integer('school_price_kg').notNull(),
  schoolPriceSpec: integer('school_price_spec').notNull(),
  schoolPriceEach: integer('school_price_each').notNull(),
  vendorPriceKg: integer('vendor_price_kg').notNull(),
  vendorPriceSpec: integer('vendor_price_spec').notNull(),
  vendorPriceEach: integer('vendor_price_each').notNull(),
  purchasePriceKg: integer('purchase_price_kg').notNull(),
  purchasePriceSpec: integer('purchase_price_spec').notNull(),
  purchasePriceEach: integer('purchase_price_each').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.idempotencyKey, table.leaseToken, table.rowNumber] }),
  check('chk_product_price_bulk_staging_version', sql`${table.expectedVersion} >= 0`),
  check('chk_product_price_bulk_staging_source_version', sql`${table.expectedSourceVersion} >= 1`),
  index('idx_product_price_bulk_staging_scope').on(
    table.tenantId,
    table.idempotencyKey,
    table.leaseToken,
  ),
  index('idx_product_price_bulk_staging_created_at').on(table.createdAt),
]);

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  detail: text('detail').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  index('idx_audit_logs_tenant_created').on(table.tenantId, table.createdAt),
]);

export const productPriceV2Backup = pgTable('product_price_v2_backup', {
  productId: text('product_id').primaryKey(),
  schoolPriceKg: integer('school_price_kg').notNull(),
  schoolPriceSpec: integer('school_price_spec').notNull(),
  schoolPriceEach: integer('school_price_each').notNull(),
  vendorPriceKg: integer('vendor_price_kg').notNull(),
  vendorPriceSpec: integer('vendor_price_spec').notNull(),
  vendorPriceEach: integer('vendor_price_each').notNull(),
  purchasePriceKg: integer('purchase_price_kg').notNull(),
  purchasePriceSpec: integer('purchase_price_spec').notNull(),
  purchasePriceEach: integer('purchase_price_each').notNull(),
});

export const schemaMigrations = pgTable('schema_migrations', {
  version: integer('version').primaryKey(),
  name: text('name').notNull(),
  checksum: text('checksum'),
  appliedAt: text('applied_at').notNull(),
});

export const erpEmbeddings = pgTable('erp_embeddings', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  model: text('model').notNull(),
  dimension: integer('dimension').notNull(),
  contentHash: text('content_hash').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  embedding: vector('embedding').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('uq_erp_embeddings_entity_model').on(
    table.tenantId,
    table.entityType,
    table.entityId,
    table.model,
  ),
  index('idx_erp_embeddings_tenant_entity').on(table.tenantId, table.entityType, table.entityId),
  check('chk_erp_embeddings_dimension_positive', sql`${table.dimension} > 0`),
  check('chk_erp_embeddings_dimension_matches', sql`vector_dims(${table.embedding}) = ${table.dimension}`),
]);
