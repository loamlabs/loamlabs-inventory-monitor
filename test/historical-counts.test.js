const test = require('node:test');
const assert = require('node:assert/strict');
const { updateHistoricalCounts } = require('../lib/historical-counts');

// Mocked Shopify: variants with a current count; records every call. No network.
function makeShop(counts, { failRead = false, failWrite = false, userError = false } = {}) {
  const shop = { counts: { ...counts }, calls: [], written: [] };
  shop.gql = async (query, vars) => {
    shop.calls.push(query.includes('nodes(') ? 'read' : 'write');
    if (query.includes('nodes(')) {
      if (failRead) throw new Error('network down');
      return { data: { nodes: vars.ids.map((id) => (id in shop.counts ? { id, historicalOrderCount: shop.counts[id] === null ? null : { value: String(shop.counts[id]) } } : null)) } };
    }
    if (failWrite) throw new Error('write down');
    if (userError) return { data: { metafieldsSet: { userErrors: [{ field: ['x'], message: 'bad' }] } } };
    for (const m of vars.metafields) { shop.counts[m.ownerId] = Number(m.value); shop.written.push(m); }
    return { data: { metafieldsSet: { userErrors: [] } } };
  };
  return shop;
}
const gid = (n) => `gid://shopify/ProductVariant/${n}`;
const line = (n, quantity = 1, sku = 'SKU-' + n) => ({ variant_id: n, sku, quantity });
const run = (shop, lines, dir = 'increment') => { const logs = []; return updateHistoricalCounts(lines, dir, { gql: shop.gql, log: (m) => logs.push(m) }).then((s) => ({ s, logs })); };

test('1 line: 2 calls (was 2), count incremented by the quantity', async () => {
  const shop = makeShop({ [gid(1)]: 4 });
  const { s } = await run(shop, [line(1, 3)]);
  assert.equal(shop.counts[gid(1)], 7);
  assert.equal(s.calls, 2);
});

test('10 lines: 2 calls in total (was 20)', async () => {
  const counts = {}; const lines = [];
  for (let i = 1; i <= 10; i++) { counts[gid(i)] = i; lines.push(line(i, 2)); }
  const shop = makeShop(counts);
  const { s, logs } = await run(shop, lines);
  assert.equal(s.calls, 2);
  assert.deepEqual(shop.calls, ['read', 'write']);
  for (let i = 1; i <= 10; i++) assert.equal(shop.counts[gid(i)], i + 2);
  assert.ok(logs.some((l) => l.includes('lines seen 10') && l.includes('Shopify calls 2')));
});

test('lines without SKU or variant are skipped (no calls at all when nothing qualifies)', async () => {
  const shop = makeShop({ [gid(1)]: 0, [gid(2)]: 0 });
  const none = await run(shop, [{ variant_id: 1, sku: '', quantity: 1 }, { variant_id: null, sku: 'X', quantity: 1 }, { variant_id: 2, quantity: 1 }]);
  assert.equal(none.s.calls, 0);
  assert.equal(shop.calls.length, 0);
  const mixed = await run(shop, [line(1, 1), { variant_id: 2, sku: null, quantity: 5 }]);
  assert.equal(mixed.s.linesSeen, 2); assert.equal(mixed.s.skuLines, 1);
  assert.equal(shop.counts[gid(1)], 1); assert.equal(shop.counts[gid(2)], 0);
});

test('same variant on two lines is added together and written once; empty metafield counts as 0', async () => {
  const shop = makeShop({ [gid(1)]: null });
  await run(shop, [line(1, 2), line(1, 3)]);
  assert.equal(shop.counts[gid(1)], 5);
  assert.equal(shop.written.length, 1);
});

test('cancel decrements and never goes below 0', async () => {
  const shop = makeShop({ [gid(1)]: 2, [gid(2)]: 10 });
  await run(shop, [line(1, 5), line(2, 4)], 'decrement');
  assert.equal(shop.counts[gid(1)], 0); assert.equal(shop.counts[gid(2)], 6);
});

test('more than 100 variants and more than 25 writes are chunked', async () => {
  const counts = {}; const lines = [];
  for (let i = 1; i <= 120; i++) { counts[gid(i)] = 0; lines.push(line(i)); }
  const shop = makeShop(counts);
  const { s } = await run(shop, lines);
  assert.equal(shop.calls.filter((c) => c === 'read').length, 2);
  assert.equal(shop.calls.filter((c) => c === 'write').length, 5);
  assert.equal(s.updated, 120);
});

test('a failing lookup is logged, does not throw, and writes nothing for those variants', async () => {
  const shop = makeShop({ [gid(1)]: 1 }, { failRead: true });
  const { s, logs } = await run(shop, [line(1)]);
  assert.equal(s.failed, 1);
  assert.equal(shop.counts[gid(1)], 1);
  assert.ok(logs.some((l) => l.includes('lookup FAILED') && l.includes('SKU-1')));
});

test('a failing write or a userError is logged and does not throw', async () => {
  for (const opt of [{ failWrite: true }, { userError: true }]) {
    const shop = makeShop({ [gid(1)]: 1 }, opt);
    const { s, logs } = await run(shop, [line(1)]);
    assert.equal(s.failed, 1);
    assert.ok(logs.some((l) => l.includes('write FAILED')));
  }
});

test('a variant that no longer exists is skipped, the others are still updated', async () => {
  const shop = makeShop({ [gid(2)]: 1 });
  await run(shop, [line(1), line(2)]);
  assert.equal(shop.counts[gid(2)], 2);
  assert.ok(!(gid(1) in shop.counts));
});
