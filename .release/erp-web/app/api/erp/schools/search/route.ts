import { NextResponse } from 'next/server';
import { withHubServerLog } from '@/app/lib/hub-server-log';
import {
  isBidAreaCode,
  isBidProvinceCode,
} from '@/app/lib/bid-regions';
import { authorizeTenant, isAllowedOrigin } from '@/app/lib/request-access';
import { normalizeTenantCode } from '@/app/lib/tenant-code';
import { searchSchools } from '@/db/school-repository';

const resultLimit = 20;

function responseHeaders(request: Request) {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  });
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(request)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

function failure(request: Request, status: number, message: string) {
  return NextResponse.json(
    { message },
    { status, headers: responseHeaders(request) },
  );
}

export async function OPTIONS(request: Request) {
  if (!isAllowedOrigin(request)) return failure(request, 403, '허용되지 않은 출처입니다.');
  return new NextResponse(null, { status: 204, headers: responseHeaders(request) });
}

async function handleGet(request: Request) {
  if (!isAllowedOrigin(request)) return failure(request, 403, '허용되지 않은 출처입니다.');

  const parameters = new URL(request.url).searchParams;
  const tenant = normalizeTenantCode(parameters.get('tenant'));
  const query = parameters.get('q')?.normalize('NFKC').trim().replace(/\s+/g, ' ') ?? '';
  const provinceValue = parameters.get('provinceCode')?.trim() ?? '';
  const provinceCode = provinceValue && isBidProvinceCode(provinceValue)
    ? provinceValue
    : undefined;

  if (!tenant) return failure(request, 400, 'tenant 회사 코드 형식이 올바르지 않습니다.');
  if (query.length < 2 || query.length > 100 || !/[\p{L}\p{N}]/u.test(query)) {
    return failure(request, 400, '학교명 또는 주소 검색어를 2~100자로 입력해 주세요.');
  }
  if (provinceValue && !provinceCode) {
    return failure(request, 400, '지원하는 시·도 코드를 선택해 주세요.');
  }

  const access = await authorizeTenant(request, tenant);
  if (!access.ok) return failure(request, access.status, access.message);

  try {
    const result = await searchSchools({ query, provinceCode, limit: resultLimit });
    const items = result.items.flatMap((school) => {
      if (!isBidAreaCode(school.areaCode) || !isBidProvinceCode(school.provinceCode)) return [];
      return [{
        id: school.id,
        schoolCode: school.schoolCode,
        name: school.name,
        schoolLevel: school.schoolKind,
        foundationType: school.foundationType ?? '',
        roadAddress: school.address,
        provinceCode: school.provinceCode,
        areaCode: school.areaCode,
        areaLabel: school.areaName,
      }];
    });
    return NextResponse.json(
      { items, total: result.total, limit: resultLimit },
      { headers: responseHeaders(request) },
    );
  } catch (error) {
    console.error('School search failed', error);
    return failure(request, 500, '학교 정보를 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

export const GET = withHubServerLog(handleGet);
