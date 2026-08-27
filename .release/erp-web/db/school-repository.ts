import type { PoolClient } from 'pg';
import { ensureDatabase } from './bootstrap';
import { queryAll, queryOne } from './postgres';

export interface SchoolSearchInput {
  query: string;
  provinceCode?: string;
  limit?: number;
}

export interface SchoolSearchResult {
  id: string;
  schoolCode: string;
  name: string;
  englishName: string | null;
  schoolKind: string;
  foundationType: string | null;
  educationOfficeName: string | null;
  roadAddress: string;
  roadDetailAddress: string | null;
  address: string;
  areaCode: string;
  areaName: string;
  provinceCode: string;
}

export interface SchoolSearchPage {
  items: SchoolSearchResult[];
  total: number;
}

export type SelectableSchoolForBid = SchoolSearchResult;
type SchoolSearchRow = SchoolSearchResult & { totalCount: number };

const MAX_SEARCH_LIMIT = 50;
const SCHOOL_SOURCE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,63}$/;

function normalizeSource(source: string) {
  const normalized = source.trim().toUpperCase();
  if (!SCHOOL_SOURCE_PATTERN.test(normalized)) {
    throw new Error('학교 데이터 출처는 영문 대문자, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.');
  }
  return normalized;
}

function requiredText(value: string, label: string) {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) throw new Error(`${label} 값이 비어 있습니다.`);
  return normalized;
}

function nullableText(value: string | null | undefined) {
  const normalized = value?.normalize('NFC').trim();
  return normalized || null;
}

function escapeLike(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function searchLimit(value: number | undefined) {
  if (value === undefined) return 20;
  if (!Number.isFinite(value)) return 20;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_SEARCH_LIMIT);
}

function stripTotalCount(row: SchoolSearchRow): SchoolSearchResult {
  const school: Partial<SchoolSearchRow> = { ...row };
  delete school.totalCount;
  return school as SchoolSearchResult;
}

export function schoolIdForExternalIdentity(
  source: string,
  sourceOfficeCode: string,
  sourceSchoolCode: string,
) {
  const parts = [
    normalizeSource(source),
    requiredText(sourceOfficeCode, '교육청 코드'),
    requiredText(sourceSchoolCode, '학교 코드'),
  ].map((part) => encodeURIComponent(part));
  return `school:${parts.join(':')}`;
}

export async function searchSchools(input: SchoolSearchInput): Promise<SchoolSearchPage> {
  const query = input.query.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!query) return { items: [], total: 0 };
  const provinceCode = nullableText(input.provinceCode);
  if (provinceCode && !/^[0-9]{2}$/.test(provinceCode)) return { items: [], total: 0 };

  const escapedQuery = escapeLike(query);
  await ensureDatabase();
  const rows = await queryAll<SchoolSearchRow>(
    `SELECT school.id, school.source_school_code AS "schoolCode",
       school.name, school.english_name AS "englishName",
       school.school_kind AS "schoolKind",
       school.foundation_type AS "foundationType",
       school.education_office_name AS "educationOfficeName",
       school.road_address AS "roadAddress",
       school.road_detail_address AS "roadDetailAddress",
       concat_ws(' ', school.road_address, NULLIF(btrim(school.road_detail_address), '')) AS address,
       area.code AS "areaCode", area.full_name AS "areaName",
       area.province_code AS "provinceCode",
       count(*) OVER()::integer AS "totalCount"
     FROM schools school
     JOIN administrative_areas area
       ON area.code = school.area_code
      AND area.active = TRUE
      AND area.selectable = TRUE
     WHERE school.active = TRUE
       AND school.mapping_status = 'MAPPED'
       AND (
         lower(school.name) LIKE lower($1) ESCAPE '\\'
         OR lower(school.road_address) LIKE lower($1) ESCAPE '\\'
       )
       AND ($2::text IS NULL OR area.province_code = $2)
     ORDER BY CASE
         WHEN lower(school.name) = lower($3)
           OR lower(school.road_address) = lower($3) THEN 0
         WHEN lower(school.name) LIKE lower($4) ESCAPE '\\'
           OR lower(school.road_address) LIKE lower($4) ESCAPE '\\' THEN 1
         ELSE 2
       END,
       CASE WHEN lower(school.name) LIKE lower($1) ESCAPE '\\' THEN 0 ELSE 1 END,
       GREATEST(
         similarity(lower(school.name), lower($3)),
         similarity(lower(school.road_address), lower($3))
       ) DESC,
       school.name, school.source_office_code, school.source_school_code
     LIMIT $5`,
    [`%${escapedQuery}%`, provinceCode, query, `${escapedQuery}%`, searchLimit(input.limit)],
  );
  return {
    items: rows.map(stripTotalCount),
    total: rows[0]?.totalCount ?? 0,
  };
}

export async function getSelectableSchoolForBid(
  client: PoolClient,
  schoolId: string,
): Promise<SelectableSchoolForBid | undefined> {
  return queryOne<SelectableSchoolForBid>(
    `SELECT school.id, school.source_school_code AS "schoolCode",
       school.name, school.english_name AS "englishName",
       school.school_kind AS "schoolKind",
       school.foundation_type AS "foundationType",
       school.education_office_name AS "educationOfficeName",
       school.road_address AS "roadAddress",
       school.road_detail_address AS "roadDetailAddress",
       concat_ws(' ', school.road_address, NULLIF(btrim(school.road_detail_address), '')) AS address,
       area.code AS "areaCode", area.full_name AS "areaName",
       area.province_code AS "provinceCode"
     FROM schools school
     JOIN administrative_areas area
       ON area.code = school.area_code
      AND area.active = TRUE
      AND area.selectable = TRUE
     WHERE school.id = $1
       AND school.active = TRUE
       AND school.mapping_status = 'MAPPED'
     FOR SHARE OF school, area`,
    [schoolId],
    client,
  );
}
