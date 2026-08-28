import type { EatBidAnnouncement, EatBidQuery } from './eat-bid-types';
import {
  bidAreaOption,
  bidAreasForProvince,
  bidProvinceOptions,
  isBidAreaCode,
  isBidProvinceCode,
} from './bid-regions';

export interface EatDeliveryRegionFieldErrors {
  deliveryProvinceCode?: string;
  deliveryAreaCode?: string;
  deliveryRegionCodes?: string;
}

const provinceAliasOverrides: Readonly<Record<string, readonly string[]>> = {
  '11': ['서울시'],
  '12': ['광주광역시', '전라남도', '전남'],
  '26': ['부산시'],
  '27': ['대구시'],
  '28': ['인천시'],
  '30': ['대전시'],
  '31': ['울산시'],
  '50': ['제주도'],
  '51': ['강원도'],
  '52': ['전라북도'],
};

const contextualProvinceAliases: Readonly<Record<string, readonly string[]>> = {
  '12': ['광주시', '광주'],
};

const strongProvinceAliasOverrides: Readonly<Record<string, readonly string[]>> = {
  '12': ['광주광역시', '전라남도'],
  '50': ['제주도'],
  '51': ['강원도'],
  '52': ['전라북도'],
};

const areasByProvince = new Map(
  bidProvinceOptions.map((province) => [
    province.code,
    bidAreasForProvince(province.code),
  ]),
);

function normalizeCode(value: string | null | undefined) {
  return (value ?? '').normalize('NFKC').trim();
}

function compactAddressText(value: string) {
  return value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
}

function compactAliases(values: readonly string[]) {
  return [...new Set(values.map(compactAddressText).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

type ProvinceAliasStrength = 'STRONG' | 'WEAK' | 'CONTEXTUAL';

interface ProvinceAliasEntry {
  alias: string;
  strength: ProvinceAliasStrength;
}

function provinceAliasEntries(code: string): ProvinceAliasEntry[] {
  const option = bidProvinceOptions.find((candidate) => candidate.code === code);
  if (!option) return [];
  const strongAliases = new Set(compactAliases([
    option.label,
    ...(strongProvinceAliasOverrides[code] ?? []),
  ]));
  const contextualAliases = new Set(compactAliases(
    contextualProvinceAliases[code] ?? [],
  ));
  return compactAliases([
    ...strongAliases,
    ...(code === '36' ? [] : [option.shortLabel]),
    ...(provinceAliasOverrides[code] ?? []),
    ...contextualAliases,
  ]).map((alias) => ({
    alias,
    strength: strongAliases.has(alias)
      ? 'STRONG'
      : contextualAliases.has(alias)
        ? 'CONTEXTUAL'
        : 'WEAK',
  }));
}

interface ProvinceAddressMatch {
  code: string;
  start: number;
  end: number;
  alias: string;
  strength: ProvinceAliasStrength;
}

function areaAliases(area: NonNullable<ReturnType<typeof bidAreaOption>>) {
  return [...new Set(
    area.level === 'ADMIN_DISTRICT'
      ? [area.localName]
      : [area.localName, area.name],
  )].map((value) => value.normalize('NFKC').trim()).filter(Boolean);
}

const uniqueAreaCodesByAlias = new Map<string, Set<string>>();
for (const areas of areasByProvince.values()) {
  for (const area of areas) {
    for (const alias of areaAliases(area)) {
      const compactAlias = compactAddressText(alias);
      const areaCodes = uniqueAreaCodesByAlias.get(compactAlias) ?? new Set<string>();
      areaCodes.add(area.code);
      uniqueAreaCodesByAlias.set(compactAlias, areaCodes);
    }
  }
}

function rawProvinceAddressMatches(address: string) {
  const candidates: ProvinceAddressMatch[] = [];
  for (const option of bidProvinceOptions) {
    for (const { alias, strength } of provinceAliasEntries(option.code)) {
      let start = address.indexOf(alias);
      while (start >= 0) {
        candidates.push({
          code: option.code,
          start,
          end: start + alias.length,
          alias,
          strength,
        });
        start = address.indexOf(alias, start + 1);
      }
    }
  }
  candidates.sort((left, right) => (
    left.start - right.start
    || right.alias.length - left.alias.length
  ));
  const matches: ProvinceAddressMatch[] = [];
  for (const candidate of candidates) {
    if (matches.some((match) => (
      candidate.start >= match.start && candidate.end <= match.end
    ))) continue;
    matches.push(candidate);
  }
  return matches;
}

function looksLikeAddressContinuation(value: string) {
  if (!value) return true;
  if (/^(?:청사?|구매|매팀|매입|협동조합|교육청|본부|팀|센터|사무소|지점|영업소|공장)/u.test(value)) {
    return false;
  }
  return /\d|대로|로|길|동|읍|면|리/u.test(value);
}

function areaStartsAddressSegment(segment: string, aliases: readonly string[]) {
  return aliases.some((alias) => {
    const normalizedSegment = segment.replace(/^[\s,./:;|：\-–—()[\]{}·]+/u, '');
    const areaPattern = alias
      .split(/\s+/u)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s\\-]*');
    const match = normalizedSegment.match(new RegExp(`^${areaPattern}`, 'u'));
    if (!match) return false;
    const remainder = normalizedSegment.slice(match[0].length);
    if (!remainder || /^[\s,./:;|()[\]{}\-]/u.test(remainder)) return true;
    return looksLikeAddressContinuation(compactAddressText(remainder));
  });
}

function provinceSegmentMatchesArea(
  provinceCode: string,
  deliveryAreaCode: string,
  segment: string,
) {
  if (deliveryAreaCode) {
    const area = isBidAreaCode(deliveryAreaCode)
      ? bidAreaOption(deliveryAreaCode)
      : null;
    if (!area || area.provinceCode !== provinceCode) return false;
    if (provinceCode === '36' && deliveryAreaCode === '36110') {
      if (!segment || /^[\s,./:;|()[\]{}\-]/u.test(segment)) return true;
      return looksLikeAddressContinuation(compactAddressText(segment));
    }
    return areaStartsAddressSegment(segment, areaAliases(area));
  }

  if (provinceCode === '36') {
    if (!segment || /^[\s,./:;|()[\]{}\-]/u.test(segment)) return true;
    return looksLikeAddressContinuation(compactAddressText(segment));
  }
  return (areasByProvince.get(provinceCode) ?? []).some((area) => (
    areaStartsAddressSegment(segment, areaAliases(area))
  ));
}

function provinceAddressMatches(address: string) {
  return rawProvinceAddressMatches(address).filter((candidate) => {
    if (candidate.strength === 'STRONG') return true;
    if (candidate.strength === 'CONTEXTUAL' && candidate.start !== 0) return false;
    return provinceSegmentMatchesArea(
      candidate.code,
      '',
      address.slice(candidate.end),
    );
  });
}

function addressClauseStart(value: string) {
  return value
    .trim()
    .replace(/^(?:(?:\d+\s*[.)]|[①-⑳]|[-•·])\s*)+/u, '')
    .replace(/^(?:납품장소|납품처|납품지|배송지|주소|소재지|장소)\s*[:：\-]?\s*/u, '');
}

function addressClauses(value: string) {
  const clauses = new Set<string>();
  const hardParts = value
    .normalize('NFKC')
    .split(/[\/;|\r\n]+|(?=\s*(?:\d+\s*[.)]|[①-⑳])\s*)/u);
  for (const hardPart of hardParts) {
    const fullClause = addressClauseStart(hardPart);
    if (fullClause) clauses.add(fullClause);
    const suffixParts = hardPart.split(/,|\s+(?:및|또는)\s+|\s+·\s+/u);
    for (let index = 1; index < suffixParts.length; index += 1) {
      const suffixClause = addressClauseStart(suffixParts[index]);
      if (suffixClause) clauses.add(suffixClause);
    }
  }
  return [...clauses];
}

function uniquelyInfersSelectedArea(
  clause: string,
  provinceCode: string,
  deliveryAreaCode: string,
) {
  const areas = deliveryAreaCode && isBidAreaCode(deliveryAreaCode)
    ? [bidAreaOption(deliveryAreaCode)].filter(Boolean)
    : (areasByProvince.get(provinceCode) ?? []);
  return areas.some((area) => areaAliases(area).some((alias) => (
    uniqueAreaCodesByAlias.get(compactAddressText(alias))?.size === 1
    && areaStartsAddressSegment(clause, [alias])
  )));
}

export function validateEatDeliveryRegionCodes(
  provinceCodeInput: string | null | undefined,
  areaCodeInput: string | null | undefined,
): EatDeliveryRegionFieldErrors {
  const deliveryProvinceCode = normalizeCode(provinceCodeInput);
  const deliveryAreaCode = normalizeCode(areaCodeInput);
  const errors: EatDeliveryRegionFieldErrors = {};

  if (deliveryProvinceCode && !isBidProvinceCode(deliveryProvinceCode)) {
    errors.deliveryProvinceCode = '시·도를 다시 선택해 주세요.';
  }

  if (deliveryAreaCode) {
    const area = isBidAreaCode(deliveryAreaCode)
      ? bidAreaOption(deliveryAreaCode)
      : null;
    if (
      !deliveryProvinceCode
      || !isBidProvinceCode(deliveryProvinceCode)
      || !area
      || area.provinceCode !== deliveryProvinceCode
    ) {
      errors.deliveryAreaCode = '선택한 시·도에 속한 행정구를 선택해 주세요.';
    }
  }

  return errors;
}

export function normalizeEatDeliveryRegionCodes(
  provinceCodeInput: string | null | undefined,
  areaCodeInput: string | null | undefined,
) {
  const deliveryProvinceCode = normalizeCode(provinceCodeInput);
  const deliveryAreaCode = normalizeCode(areaCodeInput);
  const errors = validateEatDeliveryRegionCodes(deliveryProvinceCode, deliveryAreaCode);
  const firstError = errors.deliveryProvinceCode ?? errors.deliveryAreaCode;
  if (firstError) throw new Error(firstError);
  return { deliveryProvinceCode, deliveryAreaCode };
}

export function normalizeEatDeliveryRegionSelections(
  values: readonly unknown[],
) {
  const normalized = [...new Set(values.map((value) => (
    typeof value === 'string' ? normalizeCode(value) : ''
  )).filter(Boolean))];
  if (normalized.some((code) => !isBidProvinceCode(code) && !isBidAreaCode(code))) {
    throw new Error('납품 지역을 다시 선택해 주세요.');
  }

  const selected = new Set(normalized);
  const canonical: string[] = [];
  for (const province of bidProvinceOptions) {
    const areas = bidAreasForProvince(province.code);
    if (selected.has(province.code)) {
      canonical.push(province.code);
      continue;
    }
    const selectedAreas = areas.filter((area) => selected.has(area.code));
    if (selectedAreas.length === areas.length && areas.length > 0) {
      canonical.push(province.code);
    } else {
      canonical.push(...selectedAreas.map((area) => area.code));
    }
  }
  return canonical;
}

export function effectiveEatDeliveryRegionCodes(
  query: Pick<EatBidQuery, 'deliveryProvinceCode' | 'deliveryAreaCode' | 'deliveryRegionCodes'>,
) {
  if (query.deliveryRegionCodes?.length) {
    return normalizeEatDeliveryRegionSelections(query.deliveryRegionCodes);
  }
  const legacy = normalizeEatDeliveryRegionCodes(
    query.deliveryProvinceCode,
    query.deliveryAreaCode,
  );
  return legacy.deliveryAreaCode
    ? [legacy.deliveryAreaCode]
    : legacy.deliveryProvinceCode
      ? [legacy.deliveryProvinceCode]
      : [];
}

export function hasEatDeliveryRegionFilter(query: EatBidQuery) {
  return effectiveEatDeliveryRegionCodes(query).length > 0;
}

export function matchesEatDeliveryRegion(
  announcement: Pick<EatBidAnnouncement, 'deliveryAddress'>,
  deliveryProvinceCode: string,
  deliveryAreaCode: string,
) {
  if (!deliveryProvinceCode) return true;
  const clauses = addressClauses(announcement.deliveryAddress);
  for (const clause of clauses) {
    const provinceMatches = provinceAddressMatches(clause);
    for (const provinceMatch of provinceMatches) {
      if (provinceMatch.code !== deliveryProvinceCode) continue;
      if (!deliveryAreaCode && provinceMatch.strength === 'STRONG') return true;
      const segment = clause.slice(provinceMatch.end);
      if (provinceSegmentMatchesArea(
        deliveryProvinceCode,
        deliveryAreaCode,
        segment,
      )) return true;
    }
    if (provinceMatches.length === 0 && uniquelyInfersSelectedArea(
      clause,
      deliveryProvinceCode,
      deliveryAreaCode,
    )) return true;
  }
  return false;
}

export function filterEatBidsByDeliveryRegion(
  items: readonly EatBidAnnouncement[],
  deliveryProvinceCode: string,
  deliveryAreaCode: string,
) {
  return items.filter((item) => matchesEatDeliveryRegion(
    item,
    deliveryProvinceCode,
    deliveryAreaCode,
  ));
}

export function matchesEatDeliveryRegions(
  announcement: Pick<EatBidAnnouncement, 'deliveryAddress'>,
  deliveryRegionCodes: readonly unknown[],
) {
  const normalized = normalizeEatDeliveryRegionSelections(deliveryRegionCodes);
  if (normalized.length === 0) return true;
  return normalized.some((code) => {
    if (isBidProvinceCode(code)) {
      return matchesEatDeliveryRegion(announcement, code, '');
    }
    const area = isBidAreaCode(code) ? bidAreaOption(code) : null;
    return Boolean(area && matchesEatDeliveryRegion(
      announcement,
      area.provinceCode,
      area.code,
    ));
  });
}

export function filterEatBidsByDeliveryRegions(
  items: readonly EatBidAnnouncement[],
  deliveryRegionCodes: readonly unknown[],
) {
  return items.filter((item) => matchesEatDeliveryRegions(item, deliveryRegionCodes));
}
