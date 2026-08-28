import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterModuleSearchEntries,
  normalizeModuleSearchQuery,
  shouldIgnoreModuleSearchKey,
} from '../app/lib/module-search.ts';

const modules = [
  { id: 'dashboard', label: '통합 대시보드', shortLabel: '대시보드' },
  { id: 'bids', label: '학교 입찰 관리', shortLabel: '학교 입찰' },
  { id: 'inventory', label: '입고·재고 관리', shortLabel: '입고·재고' },
];

test('메뉴명 일부와 여러 단어로 허용 메뉴를 검색한다', () => {
  assert.deepEqual(filterModuleSearchEntries(modules, '입찰').map((item) => item.id), ['bids']);
  assert.deepEqual(filterModuleSearchEntries(modules, '학교   관리').map((item) => item.id), ['bids']);
  assert.deepEqual(filterModuleSearchEntries(modules, '재고').map((item) => item.id), ['inventory']);
});

test('빈 검색어는 현재 조직에 허용된 메뉴 순서를 유지한다', () => {
  assert.deepEqual(filterModuleSearchEntries(modules, '  ').map((item) => item.id), modules.map((item) => item.id));
});

test('검색어를 NFKC와 한국어 소문자 기준으로 정규화한다', () => {
  assert.equal(normalizeModuleSearchQuery('  ＡＢＣ   메뉴  '), 'abc 메뉴');
});

test('현재 조직에 없는 메뉴는 검색 결과에 새로 생기지 않는다', () => {
  assert.deepEqual(filterModuleSearchEntries(modules, '생산'), []);
});

test('한글 IME 조합 중이거나 keyCode 229인 키 입력은 메뉴 이동에서 제외한다', () => {
  assert.equal(shouldIgnoreModuleSearchKey({ isComposing: true, keyCode: 13 }), true);
  assert.equal(shouldIgnoreModuleSearchKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(shouldIgnoreModuleSearchKey({ isComposing: false, keyCode: 13 }), false);
});
