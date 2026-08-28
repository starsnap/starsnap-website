export interface NeisMealQuery {
  schoolBidId: string;
  fromDate: string;
  toDate: string;
}
const schoolBidIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateNumber(value: string) {
  const match = isoDatePattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return timestamp;
}

export function parseNeisMealQuery(parameters: URLSearchParams):
  | { ok: true; query: NeisMealQuery }
  | { ok: false; message: string } {
  const schoolBidId = parameters.get('schoolBidId')?.trim() ?? '';
  if (!schoolBidIdPattern.test(schoolBidId)) {
    return { ok: false, message: '조회할 계약 학교를 선택해 주세요.' };
  }

  const fromDate = parameters.get('fromDate')?.trim() ?? '';
  const toDate = parameters.get('toDate')?.trim() ?? '';
  const from = dateNumber(fromDate);
  const to = dateNumber(toDate);
  if (from === null || to === null) {
    return { ok: false, message: '조회 기간을 올바른 날짜로 입력해 주세요.' };
  }
  if (from > to) {
    return { ok: false, message: '조회 시작일은 종료일보다 늦을 수 없습니다.' };
  }
  const inclusiveDays = Math.floor((to - from) / 86_400_000) + 1;
  if (inclusiveDays > 31) {
    return { ok: false, message: '급식식단정보는 한 번에 최대 31일까지 조회할 수 있습니다.' };
  }
  return { ok: true, query: { schoolBidId, fromDate, toDate } };
}
