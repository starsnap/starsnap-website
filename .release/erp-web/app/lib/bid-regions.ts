/**
 * 대한민국 행정안전부 행정표준코드관리시스템의 법정동 코드 전체자료에서
 * 폐지여부가 "존재"인 시·도, 시·군·구, 일반구만 추린 2026-08-27 스냅샷입니다.
 * https://www.code.go.kr/stdcode/regCodeL.do?menuNo=101010100010
 *
 * 학교 입찰과 공급 권역에는 selectable=true인 최종 노드만 저장합니다.
 * 일반구가 있는 시는 부모 탐색용 노드이며 직접 저장하지 않습니다.
 */
export const bidAreaDataVersion = 'MOIS_LEGAL_DONG_2026-08-27';

export type BidAreaLevel = 'SIDO' | 'CITY_COUNTY' | 'ADMIN_DISTRICT';

export interface BidAdministrativeAreaNode {
  code: string;
  parentCode: string | null;
  provinceCode: string;
  name: string;
  localName: string;
  fullName: string;
  level: BidAreaLevel;
  selectable: boolean;
}

export const bidProvinceOptions = [
  { code: '11', label: '서울특별시', shortLabel: '서울' },
  { code: '12', label: '전남광주통합특별시', shortLabel: '전남광주' },
  { code: '26', label: '부산광역시', shortLabel: '부산' },
  { code: '27', label: '대구광역시', shortLabel: '대구' },
  { code: '28', label: '인천광역시', shortLabel: '인천' },
  { code: '30', label: '대전광역시', shortLabel: '대전' },
  { code: '31', label: '울산광역시', shortLabel: '울산' },
  { code: '36', label: '세종특별자치시', shortLabel: '세종' },
  { code: '41', label: '경기도', shortLabel: '경기' },
  { code: '43', label: '충청북도', shortLabel: '충북' },
  { code: '44', label: '충청남도', shortLabel: '충남' },
  { code: '47', label: '경상북도', shortLabel: '경북' },
  { code: '48', label: '경상남도', shortLabel: '경남' },
  { code: '50', label: '제주특별자치도', shortLabel: '제주' },
  { code: '51', label: '강원특별자치도', shortLabel: '강원' },
  { code: '52', label: '전북특별자치도', shortLabel: '전북' },
] as const;

export type BidProvinceCode = (typeof bidProvinceOptions)[number]['code'];
export type BidAreaCode = string & { readonly __bidAreaCode: unique symbol };

export const bidAdministrativeAreaNodes = [
  { code: '11', parentCode: null, provinceCode: '11', name: '서울특별시', localName: '서울특별시', fullName: '서울특별시', level: 'SIDO', selectable: false },
  { code: '12', parentCode: null, provinceCode: '12', name: '전남광주통합특별시', localName: '전남광주통합특별시', fullName: '전남광주통합특별시', level: 'SIDO', selectable: false },
  { code: '26', parentCode: null, provinceCode: '26', name: '부산광역시', localName: '부산광역시', fullName: '부산광역시', level: 'SIDO', selectable: false },
  { code: '27', parentCode: null, provinceCode: '27', name: '대구광역시', localName: '대구광역시', fullName: '대구광역시', level: 'SIDO', selectable: false },
  { code: '28', parentCode: null, provinceCode: '28', name: '인천광역시', localName: '인천광역시', fullName: '인천광역시', level: 'SIDO', selectable: false },
  { code: '30', parentCode: null, provinceCode: '30', name: '대전광역시', localName: '대전광역시', fullName: '대전광역시', level: 'SIDO', selectable: false },
  { code: '31', parentCode: null, provinceCode: '31', name: '울산광역시', localName: '울산광역시', fullName: '울산광역시', level: 'SIDO', selectable: false },
  { code: '36', parentCode: null, provinceCode: '36', name: '세종특별자치시', localName: '세종특별자치시', fullName: '세종특별자치시', level: 'SIDO', selectable: false },
  { code: '41', parentCode: null, provinceCode: '41', name: '경기도', localName: '경기도', fullName: '경기도', level: 'SIDO', selectable: false },
  { code: '43', parentCode: null, provinceCode: '43', name: '충청북도', localName: '충청북도', fullName: '충청북도', level: 'SIDO', selectable: false },
  { code: '44', parentCode: null, provinceCode: '44', name: '충청남도', localName: '충청남도', fullName: '충청남도', level: 'SIDO', selectable: false },
  { code: '47', parentCode: null, provinceCode: '47', name: '경상북도', localName: '경상북도', fullName: '경상북도', level: 'SIDO', selectable: false },
  { code: '48', parentCode: null, provinceCode: '48', name: '경상남도', localName: '경상남도', fullName: '경상남도', level: 'SIDO', selectable: false },
  { code: '50', parentCode: null, provinceCode: '50', name: '제주특별자치도', localName: '제주특별자치도', fullName: '제주특별자치도', level: 'SIDO', selectable: false },
  { code: '51', parentCode: null, provinceCode: '51', name: '강원특별자치도', localName: '강원특별자치도', fullName: '강원특별자치도', level: 'SIDO', selectable: false },
  { code: '52', parentCode: null, provinceCode: '52', name: '전북특별자치도', localName: '전북특별자치도', fullName: '전북특별자치도', level: 'SIDO', selectable: false },
  { code: '11110', parentCode: '11', provinceCode: '11', name: '종로구', localName: '종로구', fullName: '서울특별시 종로구', level: 'CITY_COUNTY', selectable: true },
  { code: '11140', parentCode: '11', provinceCode: '11', name: '중구', localName: '중구', fullName: '서울특별시 중구', level: 'CITY_COUNTY', selectable: true },
  { code: '11170', parentCode: '11', provinceCode: '11', name: '용산구', localName: '용산구', fullName: '서울특별시 용산구', level: 'CITY_COUNTY', selectable: true },
  { code: '11200', parentCode: '11', provinceCode: '11', name: '성동구', localName: '성동구', fullName: '서울특별시 성동구', level: 'CITY_COUNTY', selectable: true },
  { code: '11215', parentCode: '11', provinceCode: '11', name: '광진구', localName: '광진구', fullName: '서울특별시 광진구', level: 'CITY_COUNTY', selectable: true },
  { code: '11230', parentCode: '11', provinceCode: '11', name: '동대문구', localName: '동대문구', fullName: '서울특별시 동대문구', level: 'CITY_COUNTY', selectable: true },
  { code: '11260', parentCode: '11', provinceCode: '11', name: '중랑구', localName: '중랑구', fullName: '서울특별시 중랑구', level: 'CITY_COUNTY', selectable: true },
  { code: '11290', parentCode: '11', provinceCode: '11', name: '성북구', localName: '성북구', fullName: '서울특별시 성북구', level: 'CITY_COUNTY', selectable: true },
  { code: '11305', parentCode: '11', provinceCode: '11', name: '강북구', localName: '강북구', fullName: '서울특별시 강북구', level: 'CITY_COUNTY', selectable: true },
  { code: '11320', parentCode: '11', provinceCode: '11', name: '도봉구', localName: '도봉구', fullName: '서울특별시 도봉구', level: 'CITY_COUNTY', selectable: true },
  { code: '11350', parentCode: '11', provinceCode: '11', name: '노원구', localName: '노원구', fullName: '서울특별시 노원구', level: 'CITY_COUNTY', selectable: true },
  { code: '11380', parentCode: '11', provinceCode: '11', name: '은평구', localName: '은평구', fullName: '서울특별시 은평구', level: 'CITY_COUNTY', selectable: true },
  { code: '11410', parentCode: '11', provinceCode: '11', name: '서대문구', localName: '서대문구', fullName: '서울특별시 서대문구', level: 'CITY_COUNTY', selectable: true },
  { code: '11440', parentCode: '11', provinceCode: '11', name: '마포구', localName: '마포구', fullName: '서울특별시 마포구', level: 'CITY_COUNTY', selectable: true },
  { code: '11470', parentCode: '11', provinceCode: '11', name: '양천구', localName: '양천구', fullName: '서울특별시 양천구', level: 'CITY_COUNTY', selectable: true },
  { code: '11500', parentCode: '11', provinceCode: '11', name: '강서구', localName: '강서구', fullName: '서울특별시 강서구', level: 'CITY_COUNTY', selectable: true },
  { code: '11530', parentCode: '11', provinceCode: '11', name: '구로구', localName: '구로구', fullName: '서울특별시 구로구', level: 'CITY_COUNTY', selectable: true },
  { code: '11545', parentCode: '11', provinceCode: '11', name: '금천구', localName: '금천구', fullName: '서울특별시 금천구', level: 'CITY_COUNTY', selectable: true },
  { code: '11560', parentCode: '11', provinceCode: '11', name: '영등포구', localName: '영등포구', fullName: '서울특별시 영등포구', level: 'CITY_COUNTY', selectable: true },
  { code: '11590', parentCode: '11', provinceCode: '11', name: '동작구', localName: '동작구', fullName: '서울특별시 동작구', level: 'CITY_COUNTY', selectable: true },
  { code: '11620', parentCode: '11', provinceCode: '11', name: '관악구', localName: '관악구', fullName: '서울특별시 관악구', level: 'CITY_COUNTY', selectable: true },
  { code: '11650', parentCode: '11', provinceCode: '11', name: '서초구', localName: '서초구', fullName: '서울특별시 서초구', level: 'CITY_COUNTY', selectable: true },
  { code: '11680', parentCode: '11', provinceCode: '11', name: '강남구', localName: '강남구', fullName: '서울특별시 강남구', level: 'CITY_COUNTY', selectable: true },
  { code: '11710', parentCode: '11', provinceCode: '11', name: '송파구', localName: '송파구', fullName: '서울특별시 송파구', level: 'CITY_COUNTY', selectable: true },
  { code: '11740', parentCode: '11', provinceCode: '11', name: '강동구', localName: '강동구', fullName: '서울특별시 강동구', level: 'CITY_COUNTY', selectable: true },
  { code: '12110', parentCode: '12', provinceCode: '12', name: '목포시', localName: '목포시', fullName: '전남광주통합특별시 목포시', level: 'CITY_COUNTY', selectable: true },
  { code: '12130', parentCode: '12', provinceCode: '12', name: '여수시', localName: '여수시', fullName: '전남광주통합특별시 여수시', level: 'CITY_COUNTY', selectable: true },
  { code: '12150', parentCode: '12', provinceCode: '12', name: '순천시', localName: '순천시', fullName: '전남광주통합특별시 순천시', level: 'CITY_COUNTY', selectable: true },
  { code: '12170', parentCode: '12', provinceCode: '12', name: '나주시', localName: '나주시', fullName: '전남광주통합특별시 나주시', level: 'CITY_COUNTY', selectable: true },
  { code: '12190', parentCode: '12', provinceCode: '12', name: '광양시', localName: '광양시', fullName: '전남광주통합특별시 광양시', level: 'CITY_COUNTY', selectable: true },
  { code: '12210', parentCode: '12', provinceCode: '12', name: '동구', localName: '동구', fullName: '전남광주통합특별시 동구', level: 'CITY_COUNTY', selectable: true },
  { code: '12240', parentCode: '12', provinceCode: '12', name: '서구', localName: '서구', fullName: '전남광주통합특별시 서구', level: 'CITY_COUNTY', selectable: true },
  { code: '12270', parentCode: '12', provinceCode: '12', name: '남구', localName: '남구', fullName: '전남광주통합특별시 남구', level: 'CITY_COUNTY', selectable: true },
  { code: '12300', parentCode: '12', provinceCode: '12', name: '북구', localName: '북구', fullName: '전남광주통합특별시 북구', level: 'CITY_COUNTY', selectable: true },
  { code: '12330', parentCode: '12', provinceCode: '12', name: '광산구', localName: '광산구', fullName: '전남광주통합특별시 광산구', level: 'CITY_COUNTY', selectable: true },
  { code: '12710', parentCode: '12', provinceCode: '12', name: '담양군', localName: '담양군', fullName: '전남광주통합특별시 담양군', level: 'CITY_COUNTY', selectable: true },
  { code: '12720', parentCode: '12', provinceCode: '12', name: '곡성군', localName: '곡성군', fullName: '전남광주통합특별시 곡성군', level: 'CITY_COUNTY', selectable: true },
  { code: '12730', parentCode: '12', provinceCode: '12', name: '구례군', localName: '구례군', fullName: '전남광주통합특별시 구례군', level: 'CITY_COUNTY', selectable: true },
  { code: '12740', parentCode: '12', provinceCode: '12', name: '고흥군', localName: '고흥군', fullName: '전남광주통합특별시 고흥군', level: 'CITY_COUNTY', selectable: true },
  { code: '12750', parentCode: '12', provinceCode: '12', name: '보성군', localName: '보성군', fullName: '전남광주통합특별시 보성군', level: 'CITY_COUNTY', selectable: true },
  { code: '12760', parentCode: '12', provinceCode: '12', name: '화순군', localName: '화순군', fullName: '전남광주통합특별시 화순군', level: 'CITY_COUNTY', selectable: true },
  { code: '12770', parentCode: '12', provinceCode: '12', name: '장흥군', localName: '장흥군', fullName: '전남광주통합특별시 장흥군', level: 'CITY_COUNTY', selectable: true },
  { code: '12780', parentCode: '12', provinceCode: '12', name: '강진군', localName: '강진군', fullName: '전남광주통합특별시 강진군', level: 'CITY_COUNTY', selectable: true },
  { code: '12790', parentCode: '12', provinceCode: '12', name: '해남군', localName: '해남군', fullName: '전남광주통합특별시 해남군', level: 'CITY_COUNTY', selectable: true },
  { code: '12800', parentCode: '12', provinceCode: '12', name: '영암군', localName: '영암군', fullName: '전남광주통합특별시 영암군', level: 'CITY_COUNTY', selectable: true },
  { code: '12810', parentCode: '12', provinceCode: '12', name: '무안군', localName: '무안군', fullName: '전남광주통합특별시 무안군', level: 'CITY_COUNTY', selectable: true },
  { code: '12820', parentCode: '12', provinceCode: '12', name: '함평군', localName: '함평군', fullName: '전남광주통합특별시 함평군', level: 'CITY_COUNTY', selectable: true },
  { code: '12830', parentCode: '12', provinceCode: '12', name: '영광군', localName: '영광군', fullName: '전남광주통합특별시 영광군', level: 'CITY_COUNTY', selectable: true },
  { code: '12840', parentCode: '12', provinceCode: '12', name: '장성군', localName: '장성군', fullName: '전남광주통합특별시 장성군', level: 'CITY_COUNTY', selectable: true },
  { code: '12850', parentCode: '12', provinceCode: '12', name: '완도군', localName: '완도군', fullName: '전남광주통합특별시 완도군', level: 'CITY_COUNTY', selectable: true },
  { code: '12860', parentCode: '12', provinceCode: '12', name: '진도군', localName: '진도군', fullName: '전남광주통합특별시 진도군', level: 'CITY_COUNTY', selectable: true },
  { code: '12870', parentCode: '12', provinceCode: '12', name: '신안군', localName: '신안군', fullName: '전남광주통합특별시 신안군', level: 'CITY_COUNTY', selectable: true },
  { code: '26110', parentCode: '26', provinceCode: '26', name: '중구', localName: '중구', fullName: '부산광역시 중구', level: 'CITY_COUNTY', selectable: true },
  { code: '26140', parentCode: '26', provinceCode: '26', name: '서구', localName: '서구', fullName: '부산광역시 서구', level: 'CITY_COUNTY', selectable: true },
  { code: '26170', parentCode: '26', provinceCode: '26', name: '동구', localName: '동구', fullName: '부산광역시 동구', level: 'CITY_COUNTY', selectable: true },
  { code: '26200', parentCode: '26', provinceCode: '26', name: '영도구', localName: '영도구', fullName: '부산광역시 영도구', level: 'CITY_COUNTY', selectable: true },
  { code: '26230', parentCode: '26', provinceCode: '26', name: '부산진구', localName: '부산진구', fullName: '부산광역시 부산진구', level: 'CITY_COUNTY', selectable: true },
  { code: '26260', parentCode: '26', provinceCode: '26', name: '동래구', localName: '동래구', fullName: '부산광역시 동래구', level: 'CITY_COUNTY', selectable: true },
  { code: '26290', parentCode: '26', provinceCode: '26', name: '남구', localName: '남구', fullName: '부산광역시 남구', level: 'CITY_COUNTY', selectable: true },
  { code: '26320', parentCode: '26', provinceCode: '26', name: '북구', localName: '북구', fullName: '부산광역시 북구', level: 'CITY_COUNTY', selectable: true },
  { code: '26350', parentCode: '26', provinceCode: '26', name: '해운대구', localName: '해운대구', fullName: '부산광역시 해운대구', level: 'CITY_COUNTY', selectable: true },
  { code: '26380', parentCode: '26', provinceCode: '26', name: '사하구', localName: '사하구', fullName: '부산광역시 사하구', level: 'CITY_COUNTY', selectable: true },
  { code: '26410', parentCode: '26', provinceCode: '26', name: '금정구', localName: '금정구', fullName: '부산광역시 금정구', level: 'CITY_COUNTY', selectable: true },
  { code: '26440', parentCode: '26', provinceCode: '26', name: '강서구', localName: '강서구', fullName: '부산광역시 강서구', level: 'CITY_COUNTY', selectable: true },
  { code: '26470', parentCode: '26', provinceCode: '26', name: '연제구', localName: '연제구', fullName: '부산광역시 연제구', level: 'CITY_COUNTY', selectable: true },
  { code: '26500', parentCode: '26', provinceCode: '26', name: '수영구', localName: '수영구', fullName: '부산광역시 수영구', level: 'CITY_COUNTY', selectable: true },
  { code: '26530', parentCode: '26', provinceCode: '26', name: '사상구', localName: '사상구', fullName: '부산광역시 사상구', level: 'CITY_COUNTY', selectable: true },
  { code: '26710', parentCode: '26', provinceCode: '26', name: '기장군', localName: '기장군', fullName: '부산광역시 기장군', level: 'CITY_COUNTY', selectable: true },
  { code: '27110', parentCode: '27', provinceCode: '27', name: '중구', localName: '중구', fullName: '대구광역시 중구', level: 'CITY_COUNTY', selectable: true },
  { code: '27140', parentCode: '27', provinceCode: '27', name: '동구', localName: '동구', fullName: '대구광역시 동구', level: 'CITY_COUNTY', selectable: true },
  { code: '27170', parentCode: '27', provinceCode: '27', name: '서구', localName: '서구', fullName: '대구광역시 서구', level: 'CITY_COUNTY', selectable: true },
  { code: '27200', parentCode: '27', provinceCode: '27', name: '남구', localName: '남구', fullName: '대구광역시 남구', level: 'CITY_COUNTY', selectable: true },
  { code: '27230', parentCode: '27', provinceCode: '27', name: '북구', localName: '북구', fullName: '대구광역시 북구', level: 'CITY_COUNTY', selectable: true },
  { code: '27260', parentCode: '27', provinceCode: '27', name: '수성구', localName: '수성구', fullName: '대구광역시 수성구', level: 'CITY_COUNTY', selectable: true },
  { code: '27290', parentCode: '27', provinceCode: '27', name: '달서구', localName: '달서구', fullName: '대구광역시 달서구', level: 'CITY_COUNTY', selectable: true },
  { code: '27710', parentCode: '27', provinceCode: '27', name: '달성군', localName: '달성군', fullName: '대구광역시 달성군', level: 'CITY_COUNTY', selectable: true },
  { code: '27720', parentCode: '27', provinceCode: '27', name: '군위군', localName: '군위군', fullName: '대구광역시 군위군', level: 'CITY_COUNTY', selectable: true },
  { code: '28125', parentCode: '28', provinceCode: '28', name: '제물포구', localName: '제물포구', fullName: '인천광역시 제물포구', level: 'CITY_COUNTY', selectable: true },
  { code: '28155', parentCode: '28', provinceCode: '28', name: '영종구', localName: '영종구', fullName: '인천광역시 영종구', level: 'CITY_COUNTY', selectable: true },
  { code: '28177', parentCode: '28', provinceCode: '28', name: '미추홀구', localName: '미추홀구', fullName: '인천광역시 미추홀구', level: 'CITY_COUNTY', selectable: true },
  { code: '28185', parentCode: '28', provinceCode: '28', name: '연수구', localName: '연수구', fullName: '인천광역시 연수구', level: 'CITY_COUNTY', selectable: true },
  { code: '28200', parentCode: '28', provinceCode: '28', name: '남동구', localName: '남동구', fullName: '인천광역시 남동구', level: 'CITY_COUNTY', selectable: true },
  { code: '28237', parentCode: '28', provinceCode: '28', name: '부평구', localName: '부평구', fullName: '인천광역시 부평구', level: 'CITY_COUNTY', selectable: true },
  { code: '28245', parentCode: '28', provinceCode: '28', name: '계양구', localName: '계양구', fullName: '인천광역시 계양구', level: 'CITY_COUNTY', selectable: true },
  { code: '28275', parentCode: '28', provinceCode: '28', name: '서해구', localName: '서해구', fullName: '인천광역시 서해구', level: 'CITY_COUNTY', selectable: true },
  { code: '28290', parentCode: '28', provinceCode: '28', name: '검단구', localName: '검단구', fullName: '인천광역시 검단구', level: 'CITY_COUNTY', selectable: true },
  { code: '28710', parentCode: '28', provinceCode: '28', name: '강화군', localName: '강화군', fullName: '인천광역시 강화군', level: 'CITY_COUNTY', selectable: true },
  { code: '28720', parentCode: '28', provinceCode: '28', name: '옹진군', localName: '옹진군', fullName: '인천광역시 옹진군', level: 'CITY_COUNTY', selectable: true },
  { code: '30110', parentCode: '30', provinceCode: '30', name: '동구', localName: '동구', fullName: '대전광역시 동구', level: 'CITY_COUNTY', selectable: true },
  { code: '30140', parentCode: '30', provinceCode: '30', name: '중구', localName: '중구', fullName: '대전광역시 중구', level: 'CITY_COUNTY', selectable: true },
  { code: '30170', parentCode: '30', provinceCode: '30', name: '서구', localName: '서구', fullName: '대전광역시 서구', level: 'CITY_COUNTY', selectable: true },
  { code: '30200', parentCode: '30', provinceCode: '30', name: '유성구', localName: '유성구', fullName: '대전광역시 유성구', level: 'CITY_COUNTY', selectable: true },
  { code: '30230', parentCode: '30', provinceCode: '30', name: '대덕구', localName: '대덕구', fullName: '대전광역시 대덕구', level: 'CITY_COUNTY', selectable: true },
  { code: '31110', parentCode: '31', provinceCode: '31', name: '중구', localName: '중구', fullName: '울산광역시 중구', level: 'CITY_COUNTY', selectable: true },
  { code: '31140', parentCode: '31', provinceCode: '31', name: '남구', localName: '남구', fullName: '울산광역시 남구', level: 'CITY_COUNTY', selectable: true },
  { code: '31170', parentCode: '31', provinceCode: '31', name: '동구', localName: '동구', fullName: '울산광역시 동구', level: 'CITY_COUNTY', selectable: true },
  { code: '31200', parentCode: '31', provinceCode: '31', name: '북구', localName: '북구', fullName: '울산광역시 북구', level: 'CITY_COUNTY', selectable: true },
  { code: '31710', parentCode: '31', provinceCode: '31', name: '울주군', localName: '울주군', fullName: '울산광역시 울주군', level: 'CITY_COUNTY', selectable: true },
  { code: '36110', parentCode: '36', provinceCode: '36', name: '세종특별자치시', localName: '세종특별자치시', fullName: '세종특별자치시', level: 'CITY_COUNTY', selectable: true },
  { code: '41110', parentCode: '41', provinceCode: '41', name: '수원시', localName: '수원시', fullName: '경기도 수원시', level: 'CITY_COUNTY', selectable: false },
  { code: '41130', parentCode: '41', provinceCode: '41', name: '성남시', localName: '성남시', fullName: '경기도 성남시', level: 'CITY_COUNTY', selectable: false },
  { code: '41170', parentCode: '41', provinceCode: '41', name: '안양시', localName: '안양시', fullName: '경기도 안양시', level: 'CITY_COUNTY', selectable: false },
  { code: '41190', parentCode: '41', provinceCode: '41', name: '부천시', localName: '부천시', fullName: '경기도 부천시', level: 'CITY_COUNTY', selectable: false },
  { code: '41270', parentCode: '41', provinceCode: '41', name: '안산시', localName: '안산시', fullName: '경기도 안산시', level: 'CITY_COUNTY', selectable: false },
  { code: '41280', parentCode: '41', provinceCode: '41', name: '고양시', localName: '고양시', fullName: '경기도 고양시', level: 'CITY_COUNTY', selectable: false },
  { code: '41460', parentCode: '41', provinceCode: '41', name: '용인시', localName: '용인시', fullName: '경기도 용인시', level: 'CITY_COUNTY', selectable: false },
  { code: '41590', parentCode: '41', provinceCode: '41', name: '화성시', localName: '화성시', fullName: '경기도 화성시', level: 'CITY_COUNTY', selectable: false },
  { code: '41111', parentCode: '41110', provinceCode: '41', name: '장안구', localName: '수원시 장안구', fullName: '경기도 수원시 장안구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41113', parentCode: '41110', provinceCode: '41', name: '권선구', localName: '수원시 권선구', fullName: '경기도 수원시 권선구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41115', parentCode: '41110', provinceCode: '41', name: '팔달구', localName: '수원시 팔달구', fullName: '경기도 수원시 팔달구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41117', parentCode: '41110', provinceCode: '41', name: '영통구', localName: '수원시 영통구', fullName: '경기도 수원시 영통구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41131', parentCode: '41130', provinceCode: '41', name: '수정구', localName: '성남시 수정구', fullName: '경기도 성남시 수정구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41133', parentCode: '41130', provinceCode: '41', name: '중원구', localName: '성남시 중원구', fullName: '경기도 성남시 중원구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41135', parentCode: '41130', provinceCode: '41', name: '분당구', localName: '성남시 분당구', fullName: '경기도 성남시 분당구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41150', parentCode: '41', provinceCode: '41', name: '의정부시', localName: '의정부시', fullName: '경기도 의정부시', level: 'CITY_COUNTY', selectable: true },
  { code: '41171', parentCode: '41170', provinceCode: '41', name: '만안구', localName: '안양시 만안구', fullName: '경기도 안양시 만안구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41173', parentCode: '41170', provinceCode: '41', name: '동안구', localName: '안양시 동안구', fullName: '경기도 안양시 동안구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41192', parentCode: '41190', provinceCode: '41', name: '', localName: '부천시 원미구', fullName: '경기도 부천시 원미구 ', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41194', parentCode: '41190', provinceCode: '41', name: '', localName: '부천시 소사구', fullName: '경기도 부천시 소사구 ', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41196', parentCode: '41190', provinceCode: '41', name: '', localName: '부천시 오정구', fullName: '경기도 부천시 오정구 ', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41210', parentCode: '41', provinceCode: '41', name: '광명시', localName: '광명시', fullName: '경기도 광명시', level: 'CITY_COUNTY', selectable: true },
  { code: '41220', parentCode: '41', provinceCode: '41', name: '평택시', localName: '평택시', fullName: '경기도 평택시', level: 'CITY_COUNTY', selectable: true },
  { code: '41250', parentCode: '41', provinceCode: '41', name: '동두천시', localName: '동두천시', fullName: '경기도 동두천시', level: 'CITY_COUNTY', selectable: true },
  { code: '41271', parentCode: '41270', provinceCode: '41', name: '상록구', localName: '안산시 상록구', fullName: '경기도 안산시 상록구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41273', parentCode: '41270', provinceCode: '41', name: '단원구', localName: '안산시 단원구', fullName: '경기도 안산시 단원구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41281', parentCode: '41280', provinceCode: '41', name: '덕양구', localName: '고양시 덕양구', fullName: '경기도 고양시 덕양구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41285', parentCode: '41280', provinceCode: '41', name: '일산동구', localName: '고양시 일산동구', fullName: '경기도 고양시 일산동구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41287', parentCode: '41280', provinceCode: '41', name: '일산서구', localName: '고양시 일산서구', fullName: '경기도 고양시 일산서구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41290', parentCode: '41', provinceCode: '41', name: '과천시', localName: '과천시', fullName: '경기도 과천시', level: 'CITY_COUNTY', selectable: true },
  { code: '41310', parentCode: '41', provinceCode: '41', name: '구리시', localName: '구리시', fullName: '경기도 구리시', level: 'CITY_COUNTY', selectable: true },
  { code: '41360', parentCode: '41', provinceCode: '41', name: '남양주시', localName: '남양주시', fullName: '경기도 남양주시', level: 'CITY_COUNTY', selectable: true },
  { code: '41370', parentCode: '41', provinceCode: '41', name: '오산시', localName: '오산시', fullName: '경기도 오산시', level: 'CITY_COUNTY', selectable: true },
  { code: '41390', parentCode: '41', provinceCode: '41', name: '시흥시', localName: '시흥시', fullName: '경기도 시흥시', level: 'CITY_COUNTY', selectable: true },
  { code: '41410', parentCode: '41', provinceCode: '41', name: '군포시', localName: '군포시', fullName: '경기도 군포시', level: 'CITY_COUNTY', selectable: true },
  { code: '41430', parentCode: '41', provinceCode: '41', name: '의왕시', localName: '의왕시', fullName: '경기도 의왕시', level: 'CITY_COUNTY', selectable: true },
  { code: '41450', parentCode: '41', provinceCode: '41', name: '하남시', localName: '하남시', fullName: '경기도 하남시', level: 'CITY_COUNTY', selectable: true },
  { code: '41461', parentCode: '41460', provinceCode: '41', name: '처인구', localName: '용인시 처인구', fullName: '경기도 용인시 처인구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41463', parentCode: '41460', provinceCode: '41', name: '기흥구', localName: '용인시 기흥구', fullName: '경기도 용인시 기흥구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41465', parentCode: '41460', provinceCode: '41', name: '수지구', localName: '용인시 수지구', fullName: '경기도 용인시 수지구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41480', parentCode: '41', provinceCode: '41', name: '파주시', localName: '파주시', fullName: '경기도 파주시', level: 'CITY_COUNTY', selectable: true },
  { code: '41500', parentCode: '41', provinceCode: '41', name: '이천시', localName: '이천시', fullName: '경기도 이천시', level: 'CITY_COUNTY', selectable: true },
  { code: '41550', parentCode: '41', provinceCode: '41', name: '안성시', localName: '안성시', fullName: '경기도 안성시', level: 'CITY_COUNTY', selectable: true },
  { code: '41570', parentCode: '41', provinceCode: '41', name: '김포시', localName: '김포시', fullName: '경기도 김포시', level: 'CITY_COUNTY', selectable: true },
  { code: '41591', parentCode: '41590', provinceCode: '41', name: '만세구', localName: '화성시 만세구', fullName: '경기도 화성시 만세구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41593', parentCode: '41590', provinceCode: '41', name: '효행구', localName: '화성시 효행구', fullName: '경기도 화성시 효행구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41595', parentCode: '41590', provinceCode: '41', name: '병점구', localName: '화성시 병점구', fullName: '경기도 화성시 병점구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41597', parentCode: '41590', provinceCode: '41', name: '동탄구', localName: '화성시 동탄구', fullName: '경기도 화성시 동탄구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '41610', parentCode: '41', provinceCode: '41', name: '광주시', localName: '광주시', fullName: '경기도 광주시', level: 'CITY_COUNTY', selectable: true },
  { code: '41630', parentCode: '41', provinceCode: '41', name: '양주시', localName: '양주시', fullName: '경기도 양주시', level: 'CITY_COUNTY', selectable: true },
  { code: '41650', parentCode: '41', provinceCode: '41', name: '포천시', localName: '포천시', fullName: '경기도 포천시', level: 'CITY_COUNTY', selectable: true },
  { code: '41670', parentCode: '41', provinceCode: '41', name: '여주시', localName: '여주시', fullName: '경기도 여주시', level: 'CITY_COUNTY', selectable: true },
  { code: '41800', parentCode: '41', provinceCode: '41', name: '연천군', localName: '연천군', fullName: '경기도 연천군', level: 'CITY_COUNTY', selectable: true },
  { code: '41820', parentCode: '41', provinceCode: '41', name: '가평군', localName: '가평군', fullName: '경기도 가평군', level: 'CITY_COUNTY', selectable: true },
  { code: '41830', parentCode: '41', provinceCode: '41', name: '양평군', localName: '양평군', fullName: '경기도 양평군', level: 'CITY_COUNTY', selectable: true },
  { code: '43110', parentCode: '43', provinceCode: '43', name: '청주시', localName: '청주시', fullName: '충청북도 청주시', level: 'CITY_COUNTY', selectable: false },
  { code: '43111', parentCode: '43110', provinceCode: '43', name: '상당구', localName: '청주시 상당구', fullName: '충청북도 청주시 상당구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '43112', parentCode: '43110', provinceCode: '43', name: '서원구', localName: '청주시 서원구', fullName: '충청북도 청주시 서원구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '43113', parentCode: '43110', provinceCode: '43', name: '흥덕구', localName: '청주시 흥덕구', fullName: '충청북도 청주시 흥덕구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '43114', parentCode: '43110', provinceCode: '43', name: '청원구', localName: '청주시 청원구', fullName: '충청북도 청주시 청원구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '43130', parentCode: '43', provinceCode: '43', name: '충주시', localName: '충주시', fullName: '충청북도 충주시', level: 'CITY_COUNTY', selectable: true },
  { code: '43150', parentCode: '43', provinceCode: '43', name: '제천시', localName: '제천시', fullName: '충청북도 제천시', level: 'CITY_COUNTY', selectable: true },
  { code: '43720', parentCode: '43', provinceCode: '43', name: '보은군', localName: '보은군', fullName: '충청북도 보은군', level: 'CITY_COUNTY', selectable: true },
  { code: '43730', parentCode: '43', provinceCode: '43', name: '옥천군', localName: '옥천군', fullName: '충청북도 옥천군', level: 'CITY_COUNTY', selectable: true },
  { code: '43740', parentCode: '43', provinceCode: '43', name: '영동군', localName: '영동군', fullName: '충청북도 영동군', level: 'CITY_COUNTY', selectable: true },
  { code: '43745', parentCode: '43', provinceCode: '43', name: '증평군', localName: '증평군', fullName: '충청북도 증평군', level: 'CITY_COUNTY', selectable: true },
  { code: '43750', parentCode: '43', provinceCode: '43', name: '진천군', localName: '진천군', fullName: '충청북도 진천군', level: 'CITY_COUNTY', selectable: true },
  { code: '43760', parentCode: '43', provinceCode: '43', name: '괴산군', localName: '괴산군', fullName: '충청북도 괴산군', level: 'CITY_COUNTY', selectable: true },
  { code: '43770', parentCode: '43', provinceCode: '43', name: '음성군', localName: '음성군', fullName: '충청북도 음성군', level: 'CITY_COUNTY', selectable: true },
  { code: '43800', parentCode: '43', provinceCode: '43', name: '단양군', localName: '단양군', fullName: '충청북도 단양군', level: 'CITY_COUNTY', selectable: true },
  { code: '44130', parentCode: '44', provinceCode: '44', name: '천안시', localName: '천안시', fullName: '충청남도 천안시', level: 'CITY_COUNTY', selectable: false },
  { code: '44131', parentCode: '44130', provinceCode: '44', name: '동남구', localName: '천안시 동남구', fullName: '충청남도 천안시 동남구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '44133', parentCode: '44130', provinceCode: '44', name: '서북구', localName: '천안시 서북구', fullName: '충청남도 천안시 서북구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '44150', parentCode: '44', provinceCode: '44', name: '공주시', localName: '공주시', fullName: '충청남도 공주시', level: 'CITY_COUNTY', selectable: true },
  { code: '44180', parentCode: '44', provinceCode: '44', name: '보령시', localName: '보령시', fullName: '충청남도 보령시', level: 'CITY_COUNTY', selectable: true },
  { code: '44200', parentCode: '44', provinceCode: '44', name: '아산시', localName: '아산시', fullName: '충청남도 아산시', level: 'CITY_COUNTY', selectable: true },
  { code: '44210', parentCode: '44', provinceCode: '44', name: '서산시', localName: '서산시', fullName: '충청남도 서산시', level: 'CITY_COUNTY', selectable: true },
  { code: '44230', parentCode: '44', provinceCode: '44', name: '논산시', localName: '논산시', fullName: '충청남도 논산시', level: 'CITY_COUNTY', selectable: true },
  { code: '44250', parentCode: '44', provinceCode: '44', name: '계룡시', localName: '계룡시', fullName: '충청남도 계룡시', level: 'CITY_COUNTY', selectable: true },
  { code: '44270', parentCode: '44', provinceCode: '44', name: '당진시', localName: '당진시', fullName: '충청남도 당진시', level: 'CITY_COUNTY', selectable: true },
  { code: '44710', parentCode: '44', provinceCode: '44', name: '금산군', localName: '금산군', fullName: '충청남도 금산군', level: 'CITY_COUNTY', selectable: true },
  { code: '44760', parentCode: '44', provinceCode: '44', name: '부여군', localName: '부여군', fullName: '충청남도 부여군', level: 'CITY_COUNTY', selectable: true },
  { code: '44770', parentCode: '44', provinceCode: '44', name: '서천군', localName: '서천군', fullName: '충청남도 서천군', level: 'CITY_COUNTY', selectable: true },
  { code: '44790', parentCode: '44', provinceCode: '44', name: '청양군', localName: '청양군', fullName: '충청남도 청양군', level: 'CITY_COUNTY', selectable: true },
  { code: '44800', parentCode: '44', provinceCode: '44', name: '홍성군', localName: '홍성군', fullName: '충청남도 홍성군', level: 'CITY_COUNTY', selectable: true },
  { code: '44810', parentCode: '44', provinceCode: '44', name: '예산군', localName: '예산군', fullName: '충청남도 예산군', level: 'CITY_COUNTY', selectable: true },
  { code: '44825', parentCode: '44', provinceCode: '44', name: '태안군', localName: '태안군', fullName: '충청남도 태안군', level: 'CITY_COUNTY', selectable: true },
  { code: '47110', parentCode: '47', provinceCode: '47', name: '포항시', localName: '포항시', fullName: '경상북도 포항시', level: 'CITY_COUNTY', selectable: false },
  { code: '47111', parentCode: '47110', provinceCode: '47', name: '남구', localName: '포항시 남구', fullName: '경상북도 포항시 남구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '47113', parentCode: '47110', provinceCode: '47', name: '북구', localName: '포항시 북구', fullName: '경상북도 포항시 북구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '47130', parentCode: '47', provinceCode: '47', name: '경주시', localName: '경주시', fullName: '경상북도 경주시', level: 'CITY_COUNTY', selectable: true },
  { code: '47150', parentCode: '47', provinceCode: '47', name: '김천시', localName: '김천시', fullName: '경상북도 김천시', level: 'CITY_COUNTY', selectable: true },
  { code: '47170', parentCode: '47', provinceCode: '47', name: '안동시', localName: '안동시', fullName: '경상북도 안동시', level: 'CITY_COUNTY', selectable: true },
  { code: '47190', parentCode: '47', provinceCode: '47', name: '구미시', localName: '구미시', fullName: '경상북도 구미시', level: 'CITY_COUNTY', selectable: true },
  { code: '47210', parentCode: '47', provinceCode: '47', name: '영주시', localName: '영주시', fullName: '경상북도 영주시', level: 'CITY_COUNTY', selectable: true },
  { code: '47230', parentCode: '47', provinceCode: '47', name: '영천시', localName: '영천시', fullName: '경상북도 영천시', level: 'CITY_COUNTY', selectable: true },
  { code: '47250', parentCode: '47', provinceCode: '47', name: '상주시', localName: '상주시', fullName: '경상북도 상주시', level: 'CITY_COUNTY', selectable: true },
  { code: '47280', parentCode: '47', provinceCode: '47', name: '문경시', localName: '문경시', fullName: '경상북도 문경시', level: 'CITY_COUNTY', selectable: true },
  { code: '47290', parentCode: '47', provinceCode: '47', name: '경산시', localName: '경산시', fullName: '경상북도 경산시', level: 'CITY_COUNTY', selectable: true },
  { code: '47730', parentCode: '47', provinceCode: '47', name: '의성군', localName: '의성군', fullName: '경상북도 의성군', level: 'CITY_COUNTY', selectable: true },
  { code: '47750', parentCode: '47', provinceCode: '47', name: '청송군', localName: '청송군', fullName: '경상북도 청송군', level: 'CITY_COUNTY', selectable: true },
  { code: '47760', parentCode: '47', provinceCode: '47', name: '영양군', localName: '영양군', fullName: '경상북도 영양군', level: 'CITY_COUNTY', selectable: true },
  { code: '47770', parentCode: '47', provinceCode: '47', name: '영덕군', localName: '영덕군', fullName: '경상북도 영덕군', level: 'CITY_COUNTY', selectable: true },
  { code: '47820', parentCode: '47', provinceCode: '47', name: '청도군', localName: '청도군', fullName: '경상북도 청도군', level: 'CITY_COUNTY', selectable: true },
  { code: '47830', parentCode: '47', provinceCode: '47', name: '고령군', localName: '고령군', fullName: '경상북도 고령군', level: 'CITY_COUNTY', selectable: true },
  { code: '47840', parentCode: '47', provinceCode: '47', name: '성주군', localName: '성주군', fullName: '경상북도 성주군', level: 'CITY_COUNTY', selectable: true },
  { code: '47850', parentCode: '47', provinceCode: '47', name: '칠곡군', localName: '칠곡군', fullName: '경상북도 칠곡군', level: 'CITY_COUNTY', selectable: true },
  { code: '47900', parentCode: '47', provinceCode: '47', name: '예천군', localName: '예천군', fullName: '경상북도 예천군', level: 'CITY_COUNTY', selectable: true },
  { code: '47920', parentCode: '47', provinceCode: '47', name: '봉화군', localName: '봉화군', fullName: '경상북도 봉화군', level: 'CITY_COUNTY', selectable: true },
  { code: '47930', parentCode: '47', provinceCode: '47', name: '울진군', localName: '울진군', fullName: '경상북도 울진군', level: 'CITY_COUNTY', selectable: true },
  { code: '47940', parentCode: '47', provinceCode: '47', name: '울릉군', localName: '울릉군', fullName: '경상북도 울릉군', level: 'CITY_COUNTY', selectable: true },
  { code: '48120', parentCode: '48', provinceCode: '48', name: '창원시', localName: '창원시', fullName: '경상남도 창원시', level: 'CITY_COUNTY', selectable: false },
  { code: '48121', parentCode: '48120', provinceCode: '48', name: '의창구', localName: '창원시 의창구', fullName: '경상남도 창원시 의창구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '48123', parentCode: '48120', provinceCode: '48', name: '성산구', localName: '창원시 성산구', fullName: '경상남도 창원시 성산구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '48125', parentCode: '48120', provinceCode: '48', name: '마산합포구', localName: '창원시 마산합포구', fullName: '경상남도 창원시 마산합포구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '48127', parentCode: '48120', provinceCode: '48', name: '마산회원구', localName: '창원시 마산회원구', fullName: '경상남도 창원시 마산회원구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '48129', parentCode: '48120', provinceCode: '48', name: '진해구', localName: '창원시 진해구', fullName: '경상남도 창원시 진해구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '48170', parentCode: '48', provinceCode: '48', name: '진주시', localName: '진주시', fullName: '경상남도 진주시', level: 'CITY_COUNTY', selectable: true },
  { code: '48220', parentCode: '48', provinceCode: '48', name: '통영시', localName: '통영시', fullName: '경상남도 통영시', level: 'CITY_COUNTY', selectable: true },
  { code: '48240', parentCode: '48', provinceCode: '48', name: '사천시', localName: '사천시', fullName: '경상남도 사천시', level: 'CITY_COUNTY', selectable: true },
  { code: '48250', parentCode: '48', provinceCode: '48', name: '김해시', localName: '김해시', fullName: '경상남도 김해시', level: 'CITY_COUNTY', selectable: true },
  { code: '48270', parentCode: '48', provinceCode: '48', name: '밀양시', localName: '밀양시', fullName: '경상남도 밀양시', level: 'CITY_COUNTY', selectable: true },
  { code: '48310', parentCode: '48', provinceCode: '48', name: '거제시', localName: '거제시', fullName: '경상남도 거제시', level: 'CITY_COUNTY', selectable: true },
  { code: '48330', parentCode: '48', provinceCode: '48', name: '양산시', localName: '양산시', fullName: '경상남도 양산시', level: 'CITY_COUNTY', selectable: true },
  { code: '48720', parentCode: '48', provinceCode: '48', name: '의령군', localName: '의령군', fullName: '경상남도 의령군', level: 'CITY_COUNTY', selectable: true },
  { code: '48730', parentCode: '48', provinceCode: '48', name: '함안군', localName: '함안군', fullName: '경상남도 함안군', level: 'CITY_COUNTY', selectable: true },
  { code: '48740', parentCode: '48', provinceCode: '48', name: '창녕군', localName: '창녕군', fullName: '경상남도 창녕군', level: 'CITY_COUNTY', selectable: true },
  { code: '48820', parentCode: '48', provinceCode: '48', name: '고성군', localName: '고성군', fullName: '경상남도 고성군', level: 'CITY_COUNTY', selectable: true },
  { code: '48840', parentCode: '48', provinceCode: '48', name: '남해군', localName: '남해군', fullName: '경상남도 남해군', level: 'CITY_COUNTY', selectable: true },
  { code: '48850', parentCode: '48', provinceCode: '48', name: '하동군', localName: '하동군', fullName: '경상남도 하동군', level: 'CITY_COUNTY', selectable: true },
  { code: '48860', parentCode: '48', provinceCode: '48', name: '산청군', localName: '산청군', fullName: '경상남도 산청군', level: 'CITY_COUNTY', selectable: true },
  { code: '48870', parentCode: '48', provinceCode: '48', name: '함양군', localName: '함양군', fullName: '경상남도 함양군', level: 'CITY_COUNTY', selectable: true },
  { code: '48880', parentCode: '48', provinceCode: '48', name: '거창군', localName: '거창군', fullName: '경상남도 거창군', level: 'CITY_COUNTY', selectable: true },
  { code: '48890', parentCode: '48', provinceCode: '48', name: '합천군', localName: '합천군', fullName: '경상남도 합천군', level: 'CITY_COUNTY', selectable: true },
  { code: '50110', parentCode: '50', provinceCode: '50', name: '제주시', localName: '제주시', fullName: '제주특별자치도 제주시', level: 'CITY_COUNTY', selectable: true },
  { code: '50130', parentCode: '50', provinceCode: '50', name: '서귀포시', localName: '서귀포시', fullName: '제주특별자치도 서귀포시', level: 'CITY_COUNTY', selectable: true },
  { code: '51110', parentCode: '51', provinceCode: '51', name: '춘천시', localName: '춘천시', fullName: '강원특별자치도 춘천시', level: 'CITY_COUNTY', selectable: true },
  { code: '51130', parentCode: '51', provinceCode: '51', name: '원주시', localName: '원주시', fullName: '강원특별자치도 원주시', level: 'CITY_COUNTY', selectable: true },
  { code: '51150', parentCode: '51', provinceCode: '51', name: '강릉시', localName: '강릉시', fullName: '강원특별자치도 강릉시', level: 'CITY_COUNTY', selectable: true },
  { code: '51170', parentCode: '51', provinceCode: '51', name: '동해시', localName: '동해시', fullName: '강원특별자치도 동해시', level: 'CITY_COUNTY', selectable: true },
  { code: '51190', parentCode: '51', provinceCode: '51', name: '태백시', localName: '태백시', fullName: '강원특별자치도 태백시', level: 'CITY_COUNTY', selectable: true },
  { code: '51210', parentCode: '51', provinceCode: '51', name: '속초시', localName: '속초시', fullName: '강원특별자치도 속초시', level: 'CITY_COUNTY', selectable: true },
  { code: '51230', parentCode: '51', provinceCode: '51', name: '삼척시', localName: '삼척시', fullName: '강원특별자치도 삼척시', level: 'CITY_COUNTY', selectable: true },
  { code: '51720', parentCode: '51', provinceCode: '51', name: '홍천군', localName: '홍천군', fullName: '강원특별자치도 홍천군', level: 'CITY_COUNTY', selectable: true },
  { code: '51730', parentCode: '51', provinceCode: '51', name: '횡성군', localName: '횡성군', fullName: '강원특별자치도 횡성군', level: 'CITY_COUNTY', selectable: true },
  { code: '51750', parentCode: '51', provinceCode: '51', name: '영월군', localName: '영월군', fullName: '강원특별자치도 영월군', level: 'CITY_COUNTY', selectable: true },
  { code: '51760', parentCode: '51', provinceCode: '51', name: '평창군', localName: '평창군', fullName: '강원특별자치도 평창군', level: 'CITY_COUNTY', selectable: true },
  { code: '51770', parentCode: '51', provinceCode: '51', name: '정선군', localName: '정선군', fullName: '강원특별자치도 정선군', level: 'CITY_COUNTY', selectable: true },
  { code: '51780', parentCode: '51', provinceCode: '51', name: '철원군', localName: '철원군', fullName: '강원특별자치도 철원군', level: 'CITY_COUNTY', selectable: true },
  { code: '51790', parentCode: '51', provinceCode: '51', name: '화천군', localName: '화천군', fullName: '강원특별자치도 화천군', level: 'CITY_COUNTY', selectable: true },
  { code: '51800', parentCode: '51', provinceCode: '51', name: '양구군', localName: '양구군', fullName: '강원특별자치도 양구군', level: 'CITY_COUNTY', selectable: true },
  { code: '51810', parentCode: '51', provinceCode: '51', name: '인제군', localName: '인제군', fullName: '강원특별자치도 인제군', level: 'CITY_COUNTY', selectable: true },
  { code: '51820', parentCode: '51', provinceCode: '51', name: '고성군', localName: '고성군', fullName: '강원특별자치도 고성군', level: 'CITY_COUNTY', selectable: true },
  { code: '51830', parentCode: '51', provinceCode: '51', name: '양양군', localName: '양양군', fullName: '강원특별자치도 양양군', level: 'CITY_COUNTY', selectable: true },
  { code: '52110', parentCode: '52', provinceCode: '52', name: '전주시', localName: '전주시', fullName: '전북특별자치도 전주시', level: 'CITY_COUNTY', selectable: false },
  { code: '52111', parentCode: '52110', provinceCode: '52', name: '완산구', localName: '전주시 완산구', fullName: '전북특별자치도 전주시 완산구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '52113', parentCode: '52110', provinceCode: '52', name: '덕진구', localName: '전주시 덕진구', fullName: '전북특별자치도 전주시 덕진구', level: 'ADMIN_DISTRICT', selectable: true },
  { code: '52130', parentCode: '52', provinceCode: '52', name: '군산시', localName: '군산시', fullName: '전북특별자치도 군산시', level: 'CITY_COUNTY', selectable: true },
  { code: '52140', parentCode: '52', provinceCode: '52', name: '익산시', localName: '익산시', fullName: '전북특별자치도 익산시', level: 'CITY_COUNTY', selectable: true },
  { code: '52180', parentCode: '52', provinceCode: '52', name: '정읍시', localName: '정읍시', fullName: '전북특별자치도 정읍시', level: 'CITY_COUNTY', selectable: true },
  { code: '52190', parentCode: '52', provinceCode: '52', name: '남원시', localName: '남원시', fullName: '전북특별자치도 남원시', level: 'CITY_COUNTY', selectable: true },
  { code: '52210', parentCode: '52', provinceCode: '52', name: '김제시', localName: '김제시', fullName: '전북특별자치도 김제시', level: 'CITY_COUNTY', selectable: true },
  { code: '52710', parentCode: '52', provinceCode: '52', name: '완주군', localName: '완주군', fullName: '전북특별자치도 완주군', level: 'CITY_COUNTY', selectable: true },
  { code: '52720', parentCode: '52', provinceCode: '52', name: '진안군', localName: '진안군', fullName: '전북특별자치도 진안군', level: 'CITY_COUNTY', selectable: true },
  { code: '52730', parentCode: '52', provinceCode: '52', name: '무주군', localName: '무주군', fullName: '전북특별자치도 무주군', level: 'CITY_COUNTY', selectable: true },
  { code: '52740', parentCode: '52', provinceCode: '52', name: '장수군', localName: '장수군', fullName: '전북특별자치도 장수군', level: 'CITY_COUNTY', selectable: true },
  { code: '52750', parentCode: '52', provinceCode: '52', name: '임실군', localName: '임실군', fullName: '전북특별자치도 임실군', level: 'CITY_COUNTY', selectable: true },
  { code: '52770', parentCode: '52', provinceCode: '52', name: '순창군', localName: '순창군', fullName: '전북특별자치도 순창군', level: 'CITY_COUNTY', selectable: true },
  { code: '52790', parentCode: '52', provinceCode: '52', name: '고창군', localName: '고창군', fullName: '전북특별자치도 고창군', level: 'CITY_COUNTY', selectable: true },
  { code: '52800', parentCode: '52', provinceCode: '52', name: '부안군', localName: '부안군', fullName: '전북특별자치도 부안군', level: 'CITY_COUNTY', selectable: true },
] as const satisfies readonly BidAdministrativeAreaNode[];

export interface BidAreaOption extends Omit<BidAdministrativeAreaNode, 'code' | 'provinceCode' | 'selectable'> {
  code: BidAreaCode;
  provinceCode: BidProvinceCode;
  selectable: true;
}

const provinceCodeSet = new Set<string>(bidProvinceOptions.map((province) => province.code));
const nodeByCode = new Map<string, BidAdministrativeAreaNode>(
  bidAdministrativeAreaNodes.map((node) => [node.code, node]),
);

export const bidAreaOptions: readonly BidAreaOption[] = bidAdministrativeAreaNodes
  .filter((node) => node.selectable)
  .map((node) => ({
    ...node,
    code: node.code as BidAreaCode,
    provinceCode: node.provinceCode as BidProvinceCode,
    selectable: true,
  }));

const areaCodeSet = new Set<string>(bidAreaOptions.map((area) => area.code));
const areaByCode = new Map<string, BidAreaOption>(bidAreaOptions.map((area) => [area.code, area]));
const areasByProvince = new Map<BidProvinceCode, BidAreaOption[]>(
  bidProvinceOptions.map((province) => [
    province.code,
    bidAreaOptions.filter((area) => area.provinceCode === province.code),
  ]),
);

export const maxBidAreaSelections = bidAreaOptions.length;

export function isBidProvinceCode(value: unknown): value is BidProvinceCode {
  return typeof value === 'string' && provinceCodeSet.has(value);
}

export function isBidAreaCode(value: unknown): value is BidAreaCode {
  return typeof value === 'string' && areaCodeSet.has(value);
}

export function bidAreaNode(code: string) {
  return nodeByCode.get(code) ?? null;
}

export function bidAreaOption(code: BidAreaCode) {
  return areaByCode.get(code) ?? null;
}

export function bidAreasForProvince(provinceCode: BidProvinceCode) {
  return areasByProvince.get(provinceCode) ?? [];
}

export function bidAreaTopLevelNodes(provinceCode: BidProvinceCode) {
  return bidAdministrativeAreaNodes.filter((node) => node.parentCode === provinceCode);
}

export function bidAreaChildren(parentCode: string) {
  return bidAdministrativeAreaNodes.filter((node) => node.parentCode === parentCode);
}

export function bidAreaLabel(code: BidAreaCode) {
  return areaByCode.get(code)?.fullName ?? code;
}

export function bidAreaSummary(codes: readonly BidAreaCode[]) {
  const unique = uniqueBidAreaCodes(codes);
  if (unique.length === 0) return '';

  const selected = new Set<string>(unique);
  const labels: string[] = [];
  for (const province of bidProvinceOptions) {
    const provinceAreas = bidAreasForProvince(province.code);
    const selectedAreas = provinceAreas.filter((area) => selected.has(area.code));
    if (selectedAreas.length === 0) continue;
    if (selectedAreas.length === provinceAreas.length) {
      labels.push(`${province.shortLabel} 전체`);
    } else {
      labels.push(...selectedAreas.map((area) => area.fullName));
    }
  }
  return labels.length <= 3
    ? labels.join(' · ')
    : `${labels.slice(0, 3).join(' · ')} 외 ${labels.length - 3}개 권역`;
}

export function uniqueBidAreaCodes(values: readonly unknown[]) {
  const selected = new Set(values.filter(isBidAreaCode));
  return bidAreaOptions.map((area) => area.code).filter((code) => selected.has(code));
}

// v12 이전의 시·도 단위 데이터는 표시와 수동 재매핑에만 사용합니다.
export const legacyBidRegionOptions = [
  { code: 'SEOUL', label: '서울' },
  { code: 'BUSAN', label: '부산' },
  { code: 'DAEGU', label: '대구' },
  { code: 'INCHEON', label: '인천' },
  { code: 'GWANGJU', label: '광주' },
  { code: 'DAEJEON', label: '대전' },
  { code: 'ULSAN', label: '울산' },
  { code: 'SEJONG', label: '세종' },
  { code: 'GYEONGGI', label: '경기' },
  { code: 'GANGWON', label: '강원' },
  { code: 'CHUNGBUK', label: '충북' },
  { code: 'CHUNGNAM', label: '충남' },
  { code: 'JEONBUK', label: '전북' },
  { code: 'JEONNAM', label: '전남' },
  { code: 'GYEONGBUK', label: '경북' },
  { code: 'GYEONGNAM', label: '경남' },
  { code: 'JEJU', label: '제주' },
] as const;

export type BidRegionCode = (typeof legacyBidRegionOptions)[number]['code'];
export const bidRegionOptions = legacyBidRegionOptions;

const legacyRegionLabels = new Map<string, string>(
  legacyBidRegionOptions.map((region) => [region.code, region.label]),
);

export function isBidRegionCode(value: unknown): value is BidRegionCode {
  return typeof value === 'string' && legacyRegionLabels.has(value);
}

export function bidRegionLabel(code: BidRegionCode) {
  return legacyRegionLabels.get(code) ?? code;
}

export function bidRegionSummary(codes: readonly BidRegionCode[]) {
  return codes.map(bidRegionLabel).join('·');
}

export function uniqueBidRegionCodes(values: readonly unknown[]) {
  return Array.from(new Set(values.filter(isBidRegionCode)));
}
