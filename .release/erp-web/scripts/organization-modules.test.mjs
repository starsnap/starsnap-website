import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleIdsForOrganization } from '../app/lib/organization-modules.ts';

test('organization module policy removes HACCP everywhere and hides production for school bidders', () => {
  assert.deepEqual(moduleIdsForOrganization('BRAND'), [
    'dashboard', 'partners', 'channel-orders', 'products', 'inventory', 'delivery', 'settlement',
  ]);
  assert.deepEqual(moduleIdsForOrganization('DEALER'), [
    'dashboard', 'partners', 'bids', 'channel-orders', 'products', 'inventory', 'delivery', 'settlement',
  ]);
  assert.deepEqual(moduleIdsForOrganization('BIDDER'), [
    'dashboard', 'bids', 'partners', 'channel-orders', 'products', 'meals', 'purchasing', 'inventory',
    'delivery', 'settlement',
  ]);
  for (const organizationType of ['BRAND', 'DEALER', 'BIDDER']) {
    assert.equal(moduleIdsForOrganization(organizationType).includes('haccp'), false);
  }
});
