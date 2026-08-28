import type { NeisMealQuery } from '@/app/lib/neis-meal-validation';
import { fetchNeisMeals } from './neis-meal-client';
import { getNeisMealSchoolForBidder } from './school-repository';

interface LookupInput extends NeisMealQuery {
  bidderTenantId: string;
}
interface LookupDependencies {
  findSchool: typeof getNeisMealSchoolForBidder;
  fetchMeals: typeof fetchNeisMeals;
}

const defaultDependencies: LookupDependencies = {
  findSchool: getNeisMealSchoolForBidder,
  fetchMeals: fetchNeisMeals,
};

export class NeisMealLookupError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'NeisMealLookupError';
  }
}

export async function lookupNeisMealsForBidder(
  input: LookupInput,
  dependencies: LookupDependencies = defaultDependencies,
) {
  const school = await dependencies.findSchool(input.bidderTenantId, input.schoolBidId);
  if (!school) {
    throw new NeisMealLookupError(
      404,
      '조회 가능한 계약 학교를 찾을 수 없습니다. 학교 입찰 정보를 확인해 주세요.',
    );
  }
  if (input.fromDate < school.contractStart || input.toDate > school.contractEnd) {
    throw new NeisMealLookupError(
      400,
      `조회 기간은 계약 기간(${school.contractStart}~${school.contractEnd}) 안에서 선택해 주세요.`,
    );
  }

  const result = await dependencies.fetchMeals({
    officeCode: school.officeCode,
    schoolCode: school.schoolCode,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });
  return {
    source: 'NEIS' as const,
    school: { bidId: school.bidId, name: school.schoolName },
    fromDate: input.fromDate,
    toDate: input.toDate,
    ...result,
  };
}
