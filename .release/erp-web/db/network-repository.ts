import type { PoolClient } from 'pg';
import type { AuthRole } from '@/app/lib/auth-types';
import {
  bidAreaLabel,
  bidAreaSummary,
  isBidAreaCode,
  isBidRegionCode,
  type BidAreaCode,
} from '@/app/lib/bid-regions';
import type {
  ChannelOrder,
  ChannelOrderStatus,
  ErpData,
  NetworkMutation,
  NetworkMutationResult,
  OrganizationType,
  PartnerRelationship,
  PartnerRelationshipStatus,
  SchoolBid,
  TenantCode,
  TenantSummary,
} from '@/app/lib/erp-types';
import { ensureDatabase } from './bootstrap';
import { claimIdempotency, commitIdempotency, releaseIdempotency } from './idempotency';
import { queryAll, queryOne, withTransaction } from './postgres';
import { getSelectableSchoolForBid } from './school-repository';

type NetworkData = Pick<
  ErpData,
  | 'networkMetrics'
  | 'bidderTargetAreaCodes'
  | 'bidderTargetRegionCodes'
  | 'partners'
  | 'schoolBids'
  | 'channelOrders'
>;

interface PartnerRow {
  id: string;
  type: PartnerRelationship['type'];
  region: string | null;
  areaCodes: string[];
  regionCodes: string[];
  status: PartnerRelationshipStatus;
  createdAt: string;
  updatedAt: string;
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  partnerBrandColor: string;
  partnerOrganizationType: OrganizationType;
}

interface SchoolBidRow extends Omit<SchoolBid, 'bidder' | 'areaCode' | 'regionCode'> {
  areaCode: string | null;
  regionCode: string | null;
  bidderId: string;
  bidderCode: string;
  bidderName: string;
  bidderBrandColor: string;
  bidderOrganizationType: OrganizationType;
}

interface BidderTargetAreaRow {
  areaCode: string;
}

interface BidderTargetRegionRow {
  regionCode: string;
}

interface ChannelOrderRow extends Omit<ChannelOrder, 'buyer' | 'supplier'> {
  buyerId: string;
  buyerCode: string;
  buyerName: string;
  buyerBrandColor: string;
  buyerOrganizationType: OrganizationType;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  supplierBrandColor: string;
  supplierOrganizationType: OrganizationType;
}

interface TenantRecord extends TenantSummary {
  status: string;
}

interface NetworkIdentity {
  actor: string;
  role: AuthRole;
  tenantId: string;
}

type MutationResponse = { status: number; body: NetworkMutationResult };

function tenantSummary(
  id: string,
  code: string,
  name: string,
  brandColor: string,
  organizationType: OrganizationType,
): TenantSummary {
  return { id, code: code as TenantCode, name, brandColor, organizationType };
}

export async function fetchNetworkDataWithClient(
  tenant: TenantSummary,
  client: PoolClient,
): Promise<NetworkData> {
  const [
    partnerRows,
    schoolBidRows,
    channelOrderRows,
    bidderTargetAreaRows,
    bidderTargetRegionRows,
  ] = await Promise.all([
    queryAll<PartnerRow>(
      `SELECT bd.id, 'BRAND_DEALER'::text AS type, bd.region,
         ARRAY(
           SELECT coverage.area_code
           FROM brand_dealer_areas coverage
           JOIN administrative_areas area
             ON area.code = coverage.area_code
            AND area.active = TRUE
            AND area.selectable = TRUE
           WHERE coverage.assignment_id = bd.id
           ORDER BY coverage.area_code
         ) AS "areaCodes",
         ARRAY(
           SELECT coverage.region_code
           FROM brand_dealer_regions coverage
           WHERE coverage.assignment_id = bd.id
           ORDER BY coverage.region_code
         ) AS "regionCodes",
         bd.status,
         bd.created_at AS "createdAt", bd.updated_at AS "updatedAt",
         CASE WHEN bd.brand_tenant_id = $1 THEN dealer.id ELSE brand.id END AS "partnerId",
         CASE WHEN bd.brand_tenant_id = $1 THEN dealer.code ELSE brand.code END AS "partnerCode",
         CASE WHEN bd.brand_tenant_id = $1 THEN dealer.name ELSE brand.name END AS "partnerName",
         CASE WHEN bd.brand_tenant_id = $1 THEN dealer.brand_color ELSE brand.brand_color END AS "partnerBrandColor",
         CASE WHEN bd.brand_tenant_id = $1 THEN dealer.organization_type ELSE brand.organization_type END AS "partnerOrganizationType"
       FROM brand_dealer_assignments bd
       JOIN tenants brand ON brand.id = bd.brand_tenant_id AND brand.status = 'ACTIVE'
       JOIN tenants dealer ON dealer.id = bd.dealer_tenant_id AND dealer.status = 'ACTIVE'
       WHERE bd.brand_tenant_id = $1 OR bd.dealer_tenant_id = $1
       UNION ALL
       SELECT link.id, 'DEALER_BIDDER'::text AS type, NULL::text AS region,
         CASE WHEN link.dealer_tenant_id = $1 THEN
           ARRAY(
             SELECT target.area_code
             FROM bidder_target_areas target
             JOIN administrative_areas area
               ON area.code = target.area_code
              AND area.active = TRUE
              AND area.selectable = TRUE
             WHERE target.bidder_tenant_id = link.bidder_tenant_id
             ORDER BY target.area_code
           )
         ELSE
           ARRAY(
             SELECT coverage.area_code
             FROM brand_dealer_assignments assignment
             JOIN tenants brand
               ON brand.id = assignment.brand_tenant_id
             AND brand.status = 'ACTIVE'
              AND brand.organization_type = 'BRAND'
             JOIN brand_dealer_areas coverage ON coverage.assignment_id = assignment.id
             JOIN administrative_areas area
               ON area.code = coverage.area_code
              AND area.active = TRUE
              AND area.selectable = TRUE
             WHERE assignment.dealer_tenant_id = link.dealer_tenant_id
               AND assignment.status = 'ACTIVE'
             ORDER BY coverage.area_code
           )
         END AS "areaCodes",
         CASE WHEN link.dealer_tenant_id = $1 THEN
           ARRAY(
             SELECT target.region_code
             FROM bidder_target_regions target
             WHERE target.bidder_tenant_id = link.bidder_tenant_id
             ORDER BY target.region_code
           )
         ELSE
           ARRAY(
             SELECT coverage.region_code
             FROM brand_dealer_assignments assignment
             JOIN tenants brand
               ON brand.id = assignment.brand_tenant_id
              AND brand.status = 'ACTIVE'
              AND brand.organization_type = 'BRAND'
             JOIN brand_dealer_regions coverage ON coverage.assignment_id = assignment.id
             WHERE assignment.dealer_tenant_id = link.dealer_tenant_id
               AND assignment.status = 'ACTIVE'
             ORDER BY coverage.region_code
           )
         END AS "regionCodes",
         link.status,
         link.created_at AS "createdAt", link.updated_at AS "updatedAt",
         CASE WHEN link.dealer_tenant_id = $1 THEN bidder.id ELSE dealer.id END AS "partnerId",
         CASE WHEN link.dealer_tenant_id = $1 THEN bidder.code ELSE dealer.code END AS "partnerCode",
         CASE WHEN link.dealer_tenant_id = $1 THEN bidder.name ELSE dealer.name END AS "partnerName",
         CASE WHEN link.dealer_tenant_id = $1 THEN bidder.brand_color ELSE dealer.brand_color END AS "partnerBrandColor",
         CASE WHEN link.dealer_tenant_id = $1 THEN bidder.organization_type ELSE dealer.organization_type END AS "partnerOrganizationType"
       FROM dealer_bidder_links link
       JOIN tenants dealer ON dealer.id = link.dealer_tenant_id AND dealer.status = 'ACTIVE'
       JOIN tenants bidder ON bidder.id = link.bidder_tenant_id AND bidder.status = 'ACTIVE'
       WHERE link.dealer_tenant_id = $1 OR link.bidder_tenant_id = $1
       ORDER BY "partnerName", type`,
      [tenant.id],
      client,
    ),
    queryAll<SchoolBidRow>(
      `SELECT sb.id, sb.school_id AS "schoolId", sb.bid_no AS "bidNo",
         sb.school_name AS "schoolName", sb.school_address AS "schoolAddress", sb.title,
         sb.region,
         CASE WHEN area.active = TRUE AND area.selectable = TRUE THEN sb.area_code END AS "areaCode",
         sb.region_code AS "regionCode",
         sb.awarded_at AS "awardedAt",
         sb.contract_start AS "contractStart",
         sb.contract_end AS "contractEnd", sb.contract_amount AS "contractAmount", sb.status,
         bidder.id AS "bidderId", bidder.code AS "bidderCode", bidder.name AS "bidderName",
         bidder.brand_color AS "bidderBrandColor",
         bidder.organization_type AS "bidderOrganizationType"
       FROM school_bids sb
       JOIN tenants bidder ON bidder.id = sb.bidder_tenant_id AND bidder.status = 'ACTIVE'
       LEFT JOIN administrative_areas area ON area.code = sb.area_code
       WHERE sb.bidder_tenant_id = $1
          OR EXISTS (
            SELECT 1 FROM dealer_bidder_links link
            WHERE link.dealer_tenant_id = $1
              AND link.bidder_tenant_id = sb.bidder_tenant_id
              AND link.status = 'ACTIVE'
          )
       ORDER BY sb.contract_start DESC, sb.bid_no DESC`,
      [tenant.id],
      client,
    ),
    queryAll<ChannelOrderRow>(
      `SELECT co.id, co.order_no AS "orderNo", co.direction,
         co.school_bid_id AS "schoolBidId", bid.bid_no AS "schoolBidNo",
         bid.school_name AS "schoolName", co.delivery_date AS "deliveryDate",
         co.total_amount AS "totalAmount", co.item_count AS "itemCount", co.note,
         co.status, co.created_at AS "createdAt", co.updated_at AS "updatedAt",
         buyer.id AS "buyerId", buyer.code AS "buyerCode", buyer.name AS "buyerName",
         buyer.brand_color AS "buyerBrandColor",
         buyer.organization_type AS "buyerOrganizationType",
         supplier.id AS "supplierId", supplier.code AS "supplierCode",
         supplier.name AS "supplierName", supplier.brand_color AS "supplierBrandColor",
         supplier.organization_type AS "supplierOrganizationType"
       FROM channel_orders co
       JOIN tenants buyer ON buyer.id = co.buyer_tenant_id AND buyer.status = 'ACTIVE'
       JOIN tenants supplier ON supplier.id = co.supplier_tenant_id AND supplier.status = 'ACTIVE'
       LEFT JOIN school_bids bid ON bid.id = co.school_bid_id
       WHERE co.buyer_tenant_id = $1 OR co.supplier_tenant_id = $1
       ORDER BY co.created_at DESC, co.order_no DESC`,
      [tenant.id],
      client,
    ),
    queryAll<BidderTargetAreaRow>(
      `SELECT target.area_code AS "areaCode"
       FROM bidder_target_areas target
       JOIN administrative_areas area
         ON area.code = target.area_code
        AND area.active = TRUE
        AND area.selectable = TRUE
       WHERE target.bidder_tenant_id = $1
       ORDER BY target.area_code`,
      [tenant.id],
      client,
    ),
    queryAll<BidderTargetRegionRow>(
      `SELECT region_code AS "regionCode"
       FROM bidder_target_regions
       WHERE bidder_tenant_id = $1
       ORDER BY region_code`,
      [tenant.id],
      client,
    ),
  ]);

  const partners = partnerRows.map<PartnerRelationship>((row) => ({
    id: row.id,
    type: row.type,
    partner: tenantSummary(
      row.partnerId,
      row.partnerCode,
      row.partnerName,
      row.partnerBrandColor,
      row.partnerOrganizationType,
    ),
    region: row.region,
    areaCodes: row.areaCodes.filter(isBidAreaCode),
    regionCodes: row.regionCodes.filter(isBidRegionCode),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  const schoolBids = schoolBidRows.map<SchoolBid>((row) => ({
    id: row.id,
    schoolId: row.schoolId,
    bidNo: row.bidNo,
    schoolName: row.schoolName,
    schoolAddress: row.schoolAddress,
    title: row.title,
    region: row.region,
    areaCode: row.areaCode && isBidAreaCode(row.areaCode) ? row.areaCode : null,
    regionCode: row.regionCode && isBidRegionCode(row.regionCode) ? row.regionCode : null,
    awardedAt: row.awardedAt,
    contractStart: row.contractStart,
    contractEnd: row.contractEnd,
    contractAmount: row.contractAmount,
    status: row.status,
    bidder: tenantSummary(
      row.bidderId,
      row.bidderCode,
      row.bidderName,
      row.bidderBrandColor,
      row.bidderOrganizationType,
    ),
  }));
  const channelOrders = channelOrderRows.map<ChannelOrder>((row) => ({
    id: row.id,
    orderNo: row.orderNo,
    direction: row.direction,
    buyer: tenantSummary(
      row.buyerId,
      row.buyerCode,
      row.buyerName,
      row.buyerBrandColor,
      row.buyerOrganizationType,
    ),
    supplier: tenantSummary(
      row.supplierId,
      row.supplierCode,
      row.supplierName,
      row.supplierBrandColor,
      row.supplierOrganizationType,
    ),
    schoolBidId: row.schoolBidId,
    schoolBidNo: row.schoolBidNo,
    schoolName: row.schoolName,
    deliveryDate: row.deliveryDate,
    totalAmount: row.totalAmount,
    itemCount: row.itemCount,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
  const openOrderStatuses: ChannelOrderStatus[] = ['REQUESTED', 'ACCEPTED', 'SHIPPED'];

  return {
    bidderTargetAreaCodes: bidderTargetAreaRows
      .map((row) => row.areaCode)
      .filter(isBidAreaCode),
    bidderTargetRegionCodes: bidderTargetRegionRows
      .map((row) => row.regionCode)
      .filter(isBidRegionCode),
    partners,
    schoolBids,
    channelOrders,
    networkMetrics: {
      activePartners: partners.filter((item) => item.status === 'ACTIVE').length,
      openBids: schoolBids.filter((item) => item.status !== 'CLOSED').length,
      incomingOrders: channelOrders.filter(
        (item) => item.supplier.id === tenant.id && openOrderStatuses.includes(item.status),
      ).length,
      outgoingOrders: channelOrders.filter(
        (item) => item.buyer.id === tenant.id && openOrderStatuses.includes(item.status),
      ).length,
    },
  };
}

async function requestHash(mutation: NetworkMutation) {
  const canonical = JSON.stringify(mutation);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function releaseAndReturn(
  client: PoolClient,
  tenantId: string,
  key: string,
  fingerprint: string,
  leaseToken: string,
  result: MutationResponse,
) {
  await releaseIdempotency(client, tenantId, key, fingerprint, leaseToken);
  return result;
}

async function auditNetwork(
  client: PoolClient,
  tenantIds: string[],
  actor: string,
  action: string,
  entityType: string,
  entityId: string,
  detail: string,
  now: string,
) {
  for (const tenantId of new Set(tenantIds)) {
    await client.query(
      `INSERT INTO audit_logs
        (id, tenant_id, actor, action, entity_type, entity_id, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [crypto.randomUUID(), tenantId, actor, action, entityType, entityId, detail, now],
    );
  }
}

async function commitAndReturn(
  client: PoolClient,
  tenantId: string,
  key: string,
  fingerprint: string,
  leaseToken: string,
  body: NetworkMutationResult,
  status = 200,
): Promise<MutationResponse> {
  await commitIdempotency(client, tenantId, key, fingerprint, leaseToken, body);
  return { status, body };
}

function failure(status: number, message: string): MutationResponse {
  return { status, body: { ok: false, message } };
}

async function hasOnlyActiveSelectableAreas(client: PoolClient, areaCodes: readonly BidAreaCode[]) {
  const uniqueAreaCodes = [...new Set(areaCodes)];
  if (uniqueAreaCodes.length === 0) return true;
  const rows = await queryAll<{ code: string }>(
    `SELECT code
     FROM administrative_areas
     WHERE code = ANY($1::text[])
       AND active = TRUE
       AND selectable = TRUE
     FOR SHARE`,
    [uniqueAreaCodes],
    client,
  );
  return rows.length === uniqueAreaCodes.length;
}

async function connectPartner(
  client: PoolClient,
  tenant: TenantRecord,
  mutation: Extract<NetworkMutation, { module: 'partners'; action: 'connect' }>,
  actor: string,
  now: string,
): Promise<MutationResponse> {
  const partner = await queryOne<TenantRecord>(
    `SELECT id, code, name, organization_type AS "organizationType", status,
       brand_color AS "brandColor"
     FROM tenants WHERE code = $1 AND status = 'ACTIVE' FOR KEY SHARE`,
    [mutation.partnerCode],
    client,
  );
  if (!partner) return failure(404, '입력한 업체 코드를 찾을 수 없습니다.');
  if (partner.id === tenant.id) return failure(422, '현재 업체를 거래처로 연결할 수 없습니다.');

  if (tenant.organizationType === 'BRAND') {
    if (partner.organizationType !== 'DEALER') return failure(422, '브랜드는 대리점 업체만 지정할 수 있습니다.');
    const areaCodes = mutation.areaCodes ?? [];
    if (areaCodes.length === 0) return failure(422, '대리점 담당 시·군·구 또는 행정구를 하나 이상 선택해 주세요.');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-dealer:${partner.id}`]);
    if (!(await hasOnlyActiveSelectableAreas(client, areaCodes))) {
      return failure(422, '현재 사용할 수 있는 최종 행정구역만 담당 권역으로 선택해 주세요.');
    }
    const region = bidAreaSummary(areaCodes);
    const conflict = await queryOne<{ brandName: string }>(
      `SELECT brand.name AS "brandName"
       FROM brand_dealer_assignments relation
       JOIN tenants brand ON brand.id = relation.brand_tenant_id
       WHERE relation.dealer_tenant_id = $1 AND relation.status = 'ACTIVE'
         AND relation.brand_tenant_id <> $2
       LIMIT 1`,
      [partner.id, tenant.id],
      client,
    );
    if (conflict) return failure(409, `이미 ${conflict.brandName} 브랜드에 지정된 대리점입니다.`);
    const relation = await queryOne<{ id: string }>(
      `INSERT INTO brand_dealer_assignments
        (id, brand_tenant_id, dealer_tenant_id, region, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)
       ON CONFLICT (brand_tenant_id, dealer_tenant_id) DO UPDATE SET
         region = EXCLUDED.region, status = 'ACTIVE', updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [`brand-dealer-${crypto.randomUUID()}`, tenant.id, partner.id, region, now],
      client,
    );
    if (!relation) throw new Error('대리점 지정 결과를 확인할 수 없습니다.');
    await client.query('DELETE FROM brand_dealer_areas WHERE assignment_id = $1', [relation.id]);
    await client.query(
      `INSERT INTO brand_dealer_areas
        (assignment_id, area_code, created_at, updated_at)
       SELECT $1, area_code, $3, $3
       FROM unnest($2::text[]) AS area_code`,
      [relation.id, areaCodes, now],
    );
    await auditNetwork(
      client,
      [tenant.id, partner.id],
      actor,
      'connect',
      'brand_dealer',
      relation.id,
      `${tenant.name} → ${partner.name} / ${region}`,
      now,
    );
    return { status: 201, body: { ok: true, id: relation.id, status: 'ACTIVE', message: `${partner.name} 대리점을 ${region} 권역에 지정했습니다.` } };
  }

  if (tenant.organizationType === 'DEALER') {
    if (partner.organizationType !== 'BIDDER') return failure(422, '대리점은 입찰업체만 연결할 수 있습니다.');
    const relation = await queryOne<{ id: string }>(
      `INSERT INTO dealer_bidder_links
        (id, dealer_tenant_id, bidder_tenant_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $4)
       ON CONFLICT (dealer_tenant_id, bidder_tenant_id) DO UPDATE SET
         status = 'ACTIVE', updated_at = EXCLUDED.updated_at
       RETURNING id`,
      [`dealer-bidder-${crypto.randomUUID()}`, tenant.id, partner.id, now],
      client,
    );
    if (!relation) throw new Error('입찰업체 연결 결과를 확인할 수 없습니다.');
    await auditNetwork(
      client,
      [tenant.id, partner.id],
      actor,
      'connect',
      'dealer_bidder',
      relation.id,
      `${tenant.name} ↔ ${partner.name}`,
      now,
    );
    return { status: 201, body: { ok: true, id: relation.id, status: 'ACTIVE', message: `${partner.name} 입찰업체를 거래처로 연결했습니다.` } };
  }

  return failure(403, '입찰업체는 대리점의 연결 승인을 받은 뒤 거래할 수 있습니다.');
}

async function setPartnerStatus(
  client: PoolClient,
  tenant: TenantRecord,
  mutation: Extract<NetworkMutation, { module: 'partners'; action: 'set-status' }>,
  actor: string,
  now: string,
): Promise<MutationResponse> {
  if (tenant.organizationType === 'BRAND') {
    const relationIdentity = await queryOne<{ dealerTenantId: string }>(
      `SELECT dealer_tenant_id AS "dealerTenantId"
       FROM brand_dealer_assignments
       WHERE id = $1 AND brand_tenant_id = $2`,
      [mutation.id, tenant.id],
      client,
    );
    if (!relationIdentity) return failure(404, '관리할 수 있는 대리점 관계를 찾을 수 없습니다.');
    // Keep the lock order identical to connectPartner: dealer advisory lock,
    // then the relationship row. This avoids a row/advisory lock inversion.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-dealer:${relationIdentity.dealerTenantId}`]);
    const relation = await queryOne<{ id: string; dealerTenantId: string; partnerName: string; status: PartnerRelationshipStatus }>(
      `SELECT relation.id, relation.dealer_tenant_id AS "dealerTenantId",
         dealer.name AS "partnerName", relation.status
       FROM brand_dealer_assignments relation
       JOIN tenants dealer ON dealer.id = relation.dealer_tenant_id
       WHERE relation.id = $1 AND relation.brand_tenant_id = $2
       FOR UPDATE`,
      [mutation.id, tenant.id],
      client,
    );
    if (!relation) return failure(404, '관리할 수 있는 대리점 관계를 찾을 수 없습니다.');
    if (relation.status === mutation.status) {
      return { status: 200, body: { ok: true, id: relation.id, status: relation.status, alreadyApplied: true, message: '이미 같은 상태로 반영되어 있습니다.' } };
    }
    if (mutation.status === 'ACTIVE') {
      const conflict = await queryOne<{ found: boolean }>(
        `SELECT TRUE AS found FROM brand_dealer_assignments
         WHERE dealer_tenant_id = $1 AND status = 'ACTIVE' AND id <> $2`,
        [relation.dealerTenantId, relation.id],
        client,
      );
      if (conflict) return failure(409, '이 대리점은 다른 브랜드와 활성 관계가 있어 다시 지정할 수 없습니다.');
    }
    await client.query(
      'UPDATE brand_dealer_assignments SET status = $1, updated_at = $2 WHERE id = $3',
      [mutation.status, now, relation.id],
    );
    await auditNetwork(client, [tenant.id, relation.dealerTenantId], actor, 'set-status', 'brand_dealer', relation.id, `${relation.status} → ${mutation.status}`, now);
    return { status: 200, body: { ok: true, id: relation.id, status: mutation.status, message: `${relation.partnerName} 대리점 관계를 변경했습니다.` } };
  }

  if (tenant.organizationType === 'DEALER') {
    const relation = await queryOne<{ id: string; bidderTenantId: string; partnerName: string; status: PartnerRelationshipStatus }>(
      `SELECT relation.id, relation.bidder_tenant_id AS "bidderTenantId",
         bidder.name AS "partnerName", relation.status
       FROM dealer_bidder_links relation
       JOIN tenants bidder ON bidder.id = relation.bidder_tenant_id
       WHERE relation.id = $1 AND relation.dealer_tenant_id = $2
       FOR UPDATE`,
      [mutation.id, tenant.id],
      client,
    );
    if (!relation) return failure(404, '관리할 수 있는 입찰업체 관계를 찾을 수 없습니다.');
    if (relation.status === mutation.status) {
      return { status: 200, body: { ok: true, id: relation.id, status: relation.status, alreadyApplied: true, message: '이미 같은 상태로 반영되어 있습니다.' } };
    }
    await client.query(
      'UPDATE dealer_bidder_links SET status = $1, updated_at = $2 WHERE id = $3',
      [mutation.status, now, relation.id],
    );
    await auditNetwork(client, [tenant.id, relation.bidderTenantId], actor, 'set-status', 'dealer_bidder', relation.id, `${relation.status} → ${mutation.status}`, now);
    return { status: 200, body: { ok: true, id: relation.id, status: mutation.status, message: `${relation.partnerName} 입찰업체 관계를 변경했습니다.` } };
  }

  return failure(403, '입찰업체는 연결 상태를 변경할 수 없습니다.');
}

async function createSchoolBid(
  client: PoolClient,
  tenant: TenantRecord,
  mutation: Extract<NetworkMutation, { module: 'bids'; action: 'create' }>,
  actor: string,
  now: string,
): Promise<MutationResponse> {
  if (tenant.organizationType !== 'BIDDER') return failure(403, '학교 입찰은 입찰업체에서만 등록할 수 있습니다.');
  const school = await getSelectableSchoolForBid(client, mutation.bid.schoolId);
  if (!school || !isBidAreaCode(school.areaCode)) {
    return failure(422, '현재 입찰에 사용할 수 있는 공식 학교를 다시 선택해 주세요.');
  }
  const id = `school-bid-${crypto.randomUUID()}`;
  const region = bidAreaLabel(school.areaCode);
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO school_bids
      (id, bidder_tenant_id, school_id, bid_no, school_name, school_address, title, region,
       area_code, region_code, awarded_at, contract_start, contract_end, contract_amount,
       status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, $12, $13,
       'AWARDED', $14, $14)
     ON CONFLICT (bidder_tenant_id, bid_no) DO NOTHING
     RETURNING id`,
    [id, tenant.id, school.id, mutation.bid.bidNo, school.name, school.address,
      mutation.bid.title, region, school.areaCode, mutation.bid.awardedAt,
      mutation.bid.contractStart, mutation.bid.contractEnd, mutation.bid.contractAmount, now],
    client,
  );
  if (!inserted) return failure(409, '같은 입찰 공고번호가 이미 등록되어 있습니다.');
  await auditNetwork(client, [tenant.id], actor, 'create', 'school_bid', id, `${mutation.bid.bidNo} / ${school.name}`, now);
  return { status: 201, body: { ok: true, id, message: `${school.name} 낙찰 계약을 등록했습니다.` } };
}

async function setBidderTargetAreas(
  client: PoolClient,
  tenant: TenantRecord,
  mutation: Extract<NetworkMutation, { module: 'bid-target-areas'; action: 'set' }>,
  actor: string,
  now: string,
): Promise<MutationResponse> {
  if (tenant.organizationType !== 'BIDDER') {
    return failure(403, '관심 입찰 지역은 입찰업체에서만 설정할 수 있습니다.');
  }
  if (!(await hasOnlyActiveSelectableAreas(client, mutation.areaCodes))) {
    return failure(422, '현재 사용할 수 있는 최종 행정구역만 관심 지역으로 선택해 주세요.');
  }
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1))',
    [`bidder-target-areas:${tenant.id}`],
  );
  await client.query(
    'DELETE FROM bidder_target_areas WHERE bidder_tenant_id = $1',
    [tenant.id],
  );
  if (mutation.areaCodes.length > 0) {
    await client.query(
      `INSERT INTO bidder_target_areas
        (bidder_tenant_id, area_code, created_at, updated_at)
       SELECT $1, area_code, $3, $3
       FROM unnest($2::text[]) AS area_code`,
      [tenant.id, mutation.areaCodes, now],
    );
  }
  const summary = mutation.areaCodes.length > 0
    ? bidAreaSummary(mutation.areaCodes)
    : '설정 없음';
  await auditNetwork(
    client,
    [tenant.id],
    actor,
    'set',
    'bidder_target_areas',
    tenant.id,
    summary,
    now,
  );
  return {
    status: 200,
    body: {
      ok: true,
      id: tenant.id,
      message: mutation.areaCodes.length > 0
        ? `관심 입찰 지역을 ${summary}(으)로 설정했습니다.`
        : '관심 입찰 지역 설정을 비웠습니다.',
    },
  };
}

function orderNumber(now: string) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now)).replaceAll('-', '');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  return `CO-${date}-${suffix}`;
}

async function createChannelOrder(
  client: PoolClient,
  tenant: TenantRecord,
  mutation: Extract<NetworkMutation, { module: 'channel-orders'; action: 'create' }>,
  actor: string,
  now: string,
): Promise<MutationResponse> {
  const partner = await queryOne<TenantRecord>(
    `SELECT id, code, name, organization_type AS "organizationType", status,
       brand_color AS "brandColor"
     FROM tenants WHERE code = $1 AND status = 'ACTIVE' FOR KEY SHARE`,
    [mutation.order.partnerCode],
    client,
  );
  if (!partner) return failure(404, '발주 대상 업체를 찾을 수 없습니다.');

  let direction: ChannelOrder['direction'];
  let schoolBidId: string | null = null;
  if (tenant.organizationType === 'BIDDER') {
    if (partner.organizationType !== 'DEALER') return failure(422, '입찰업체는 연결된 대리점에만 발주할 수 있습니다.');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`brand-dealer:${partner.id}`]);
    const relation = await queryOne<{ found: boolean }>(
      `SELECT TRUE AS found FROM dealer_bidder_links
       WHERE dealer_tenant_id = $1 AND bidder_tenant_id = $2 AND status = 'ACTIVE'
       FOR SHARE`,
      [partner.id, tenant.id],
      client,
    );
    if (!relation) return failure(403, '이 대리점과 활성 거래 관계가 없습니다.');
    if (!mutation.order.schoolBidId) return failure(422, '학교 낙찰 계약을 선택해 주세요.');
    const bid = await queryOne<{
      id: string;
      areaCode: BidAreaCode | null;
      areaSelectable: boolean | null;
      contractStart: string;
      contractEnd: string;
    }>(
      `SELECT bid.id, bid.area_code AS "areaCode",
         (area.active = TRUE AND area.selectable = TRUE) AS "areaSelectable",
         bid.contract_start AS "contractStart", bid.contract_end AS "contractEnd"
       FROM school_bids bid
       LEFT JOIN administrative_areas area ON area.code = bid.area_code
       WHERE bid.id = $1 AND bid.bidder_tenant_id = $2 AND bid.status IN ('AWARDED', 'ACTIVE')
       FOR SHARE OF bid`,
      [mutation.order.schoolBidId, tenant.id],
      client,
    );
    if (!bid) return failure(422, '발주에 사용할 수 있는 학교 낙찰 계약이 아닙니다.');
    if (!bid.areaCode || !isBidAreaCode(bid.areaCode) || !bid.areaSelectable) {
      return failure(422, '선택한 학교 낙찰 계약에 세부 행정구역이 설정되어 있지 않습니다.');
    }
    const matchingCoverage = await queryOne<{ found: boolean }>(
      `SELECT TRUE AS found
       FROM brand_dealer_assignments assignment
       JOIN tenants brand
         ON brand.id = assignment.brand_tenant_id
        AND brand.status = 'ACTIVE'
        AND brand.organization_type = 'BRAND'
       JOIN brand_dealer_areas coverage ON coverage.assignment_id = assignment.id
       JOIN administrative_areas area
         ON area.code = coverage.area_code
        AND area.active = TRUE
        AND area.selectable = TRUE
       WHERE assignment.dealer_tenant_id = $1
         AND assignment.status = 'ACTIVE'
         AND coverage.area_code = $2
       FOR SHARE OF assignment, brand, coverage, area`,
      [partner.id, bid.areaCode],
      client,
    );
    if (!matchingCoverage) {
      return failure(422, `${bidAreaLabel(bid.areaCode)} 지역을 담당하는 대리점이 아닙니다.`);
    }
    if (mutation.order.deliveryDate < bid.contractStart || mutation.order.deliveryDate > bid.contractEnd) {
      return failure(422, `납품 예정일은 계약 기간(${bid.contractStart}~${bid.contractEnd}) 안이어야 합니다.`);
    }
    schoolBidId = bid.id;
    direction = 'BIDDER_TO_DEALER';
  } else if (tenant.organizationType === 'DEALER') {
    if (partner.organizationType !== 'BRAND') return failure(422, '대리점은 지정된 브랜드 업체에만 발주할 수 있습니다.');
    const relation = await queryOne<{ found: boolean }>(
      `SELECT TRUE AS found FROM brand_dealer_assignments
       WHERE brand_tenant_id = $1 AND dealer_tenant_id = $2 AND status = 'ACTIVE'
       FOR SHARE`,
      [partner.id, tenant.id],
      client,
    );
    if (!relation) return failure(403, '이 브랜드와 활성 대리점 관계가 없습니다.');
    direction = 'DEALER_TO_BRAND';
  } else {
    return failure(403, '브랜드 업체는 수신 주문을 처리하며 직접 상위 발주를 만들 수 없습니다.');
  }

  const id = `channel-order-${crypto.randomUUID()}`;
  const orderNo = orderNumber(now);
  await client.query(
    `INSERT INTO channel_orders
      (id, order_no, direction, buyer_tenant_id, supplier_tenant_id, school_bid_id,
       delivery_date, total_amount, item_count, note, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'REQUESTED', $11, $11)`,
    [id, orderNo, direction, tenant.id, partner.id, schoolBidId,
      mutation.order.deliveryDate, mutation.order.totalAmount, mutation.order.itemCount,
      mutation.order.note?.trim() ?? '', now],
  );
  await auditNetwork(client, [tenant.id, partner.id], actor, 'create', 'channel_order', id, `${orderNo} / ${tenant.name} → ${partner.name}`, now);
  return { status: 201, body: { ok: true, id, status: 'REQUESTED', message: `${partner.name}에 ${orderNo} 발주를 요청했습니다.` } };
}

async function transitionChannelOrder(
  client: PoolClient,
  tenant: TenantRecord,
  mutation: Extract<NetworkMutation, { module: 'channel-orders'; action: 'transition' }>,
  actor: string,
  now: string,
): Promise<MutationResponse> {
  const order = await queryOne<{
    id: string;
    orderNo: string;
    buyerTenantId: string;
    supplierTenantId: string;
    status: ChannelOrderStatus;
  }>(
    `SELECT id, order_no AS "orderNo", buyer_tenant_id AS "buyerTenantId",
       supplier_tenant_id AS "supplierTenantId", status
     FROM channel_orders
     WHERE id = $1 AND (buyer_tenant_id = $2 OR supplier_tenant_id = $2)
     FOR UPDATE`,
    [mutation.id, tenant.id],
    client,
  );
  if (!order) return failure(404, '현재 업체가 처리할 수 있는 발주를 찾을 수 없습니다.');
  if (order.status === mutation.status) {
    return { status: 200, body: { ok: true, id: order.id, status: order.status, alreadyApplied: true, message: '이미 같은 상태로 처리된 발주입니다.' } };
  }

  const allowed: Partial<Record<ChannelOrderStatus, ChannelOrderStatus[]>> = {
    REQUESTED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
    ACCEPTED: ['SHIPPED', 'CANCELLED'],
    SHIPPED: ['COMPLETED'],
  };
  if (!allowed[order.status]?.includes(mutation.status)) {
    return failure(409, `${order.status} 상태에서는 ${mutation.status} 상태로 변경할 수 없습니다.`);
  }
  const supplierActions: ChannelOrderStatus[] = ['ACCEPTED', 'REJECTED', 'SHIPPED'];
  const buyerActions: ChannelOrderStatus[] = ['COMPLETED', 'CANCELLED'];
  if (supplierActions.includes(mutation.status) && order.supplierTenantId !== tenant.id) {
    return failure(403, '발주 공급업체만 이 상태로 변경할 수 있습니다.');
  }
  if (buyerActions.includes(mutation.status) && order.buyerTenantId !== tenant.id) {
    return failure(403, '발주 요청업체만 이 상태로 변경할 수 있습니다.');
  }

  const updated = await client.query(
    `UPDATE channel_orders SET status = $1, updated_at = $2
     WHERE id = $3 AND status = $4`,
    [mutation.status, now, order.id, order.status],
  );
  if (updated.rowCount !== 1) return failure(409, '다른 요청이 먼저 발주 상태를 변경했습니다. 새로고침 후 다시 시도해 주세요.');
  await auditNetwork(
    client,
    [order.buyerTenantId, order.supplierTenantId],
    actor,
    'transition',
    'channel_order',
    order.id,
    `${order.status} → ${mutation.status}`,
    now,
  );
  return { status: 200, body: { ok: true, id: order.id, status: mutation.status, message: `${order.orderNo} 발주 상태를 변경했습니다.` } };
}

export async function applyNetworkMutation(
  mutation: NetworkMutation,
  idempotencyKey: string,
  identity: NetworkIdentity,
): Promise<MutationResponse> {
  await ensureDatabase();
  const fingerprint = await requestHash(mutation);
  return withTransaction(async (client) => {
    const tenant = await queryOne<TenantRecord>(
      `SELECT id, code, name, organization_type AS "organizationType", status,
         brand_color AS "brandColor"
       FROM tenants WHERE id = $1 AND code = $2 AND status = 'ACTIVE' FOR KEY SHARE`,
      [identity.tenantId, mutation.tenant],
      client,
    );
    if (!tenant) return failure(404, '회사를 찾을 수 없습니다.');
    if (mutation.module === 'partners' && identity.role !== 'admin') {
      return failure(403, '업체 관계와 담당 권역은 관리자만 변경할 수 있습니다.');
    }

    const now = new Date().toISOString();
    const claim = await claimIdempotency(client, tenant.id, idempotencyKey, fingerprint, now, 60_000);
    if (claim.kind === 'result') return claim.result as MutationResponse;
    const { leaseToken } = claim;

    let result: MutationResponse;
    if (mutation.module === 'partners' && mutation.action === 'connect') {
      result = await connectPartner(client, tenant, mutation, identity.actor, now);
    } else if (mutation.module === 'partners' && mutation.action === 'set-status') {
      result = await setPartnerStatus(client, tenant, mutation, identity.actor, now);
    } else if (mutation.module === 'bids' && mutation.action === 'create') {
      result = await createSchoolBid(client, tenant, mutation, identity.actor, now);
    } else if (mutation.module === 'bid-target-areas' && mutation.action === 'set') {
      result = await setBidderTargetAreas(client, tenant, mutation, identity.actor, now);
    } else if (mutation.module === 'channel-orders' && mutation.action === 'create') {
      result = await createChannelOrder(client, tenant, mutation, identity.actor, now);
    } else if (mutation.module === 'channel-orders' && mutation.action === 'transition') {
      result = await transitionChannelOrder(client, tenant, mutation, identity.actor, now);
    } else {
      result = failure(422, '지원하지 않는 유통 네트워크 요청입니다.');
    }

    if (!result.body.ok) {
      return releaseAndReturn(client, tenant.id, idempotencyKey, fingerprint, leaseToken, result);
    }
    return commitAndReturn(
      client,
      tenant.id,
      idempotencyKey,
      fingerprint,
      leaseToken,
      result.body,
      result.status,
    );
  });
}
