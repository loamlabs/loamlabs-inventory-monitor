import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSiblingInventory } from '../lib/sync-siblings.js';

const LOC = '1';
// ---- mocked Shopify (in memory, no network) ----
function makeShop(variants, { pageCap = 50 } = {}) {
  const shop = { variants, writes: [], calls: [] };
  const item = (v) => ({ id: `gid://shopify/InventoryItem/${v.item}`, inventoryLevel: v.qty === null ? null : { quantities: [{ name: 'available', quantity: v.qty }] } });
  const node = (v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, title: v.title, product: { id: `gid://shopify/Product/${v.pid}`, title: v.ptitle }, inventoryItem: item(v), metafield: v.key ? { value: v.key } : null });
  const page = (list, vars) => {
    const start = vars.after ? Number(vars.after) : 0;
    const end = start + pageCap; // the mock caps the page size, so the code must follow cursors
    return { pageInfo: { hasNextPage: end < list.length, endCursor: String(end) }, nodes: list.slice(start, end).map(node) };
  };
  shop.gql = async (query, vars) => {
    shop.calls.push(query.match(/(?:query|mutation) (\w+)/)[1]);
    if (query.includes('SyncReadTrigger')) {
      const v = variants.find((x) => `gid://shopify/InventoryItem/${x.item}` === vars.id);
      return { data: { inventoryItem: item(v) } };
    }
    if (query.includes('SyncProductVariants')) {
      const list = variants.filter((x) => `gid://shopify/Product/${x.pid}` === vars.pid);
      return { data: { product: { variants: page(list, vars) } } };
    }
    if (query.includes('SyncSearch')) {
      const words = vars.q.split(' ');
      const list = variants.filter((x) => words.every((w) => x.ptitle.includes(w))).sort((a, b) => a.id - b.id);
      return { data: { productVariants: page(list, vars) } };
    }
    if (query.includes('SyncSet')) {
      const q = vars.input.quantities[0];
      const v = variants.find((x) => `gid://shopify/InventoryItem/${x.item}` === q.inventoryItemId);
      if (v.qty !== q.changeFromQuantity) return { data: { inventorySetQuantities: { userErrors: [{ message: 'changeFromQuantity mismatch' }] } } };
      v.qty = q.quantity;
      shop.writes.push({ id: v.id, to: q.quantity });
      return { data: { inventorySetQuantities: { userErrors: [] } } };
    }
    throw new Error('unexpected query ' + query.slice(0, 60));
  };
  return shop;
}
const makeRedis = () => {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); } };
};
const V = (id, pid, ptitle, title, key, qty, item = id + 1000) => ({ id, pid, ptitle, title, key, qty, item });
const trig = (v) => ({ id: `gid://shopify/ProductVariant/${v.id}`, title: v.title, syncKey: v.key ? { value: v.key } : null, product: { id: `gid://shopify/Product/${v.pid}`, title: v.ptitle } });
const fire = (shop, redis, v, log = () => {}) => syncSiblingInventory({ triggerVariant: trig(v), inventoryItemId: v.item, locationId: LOC, gql: shop.gql, redis, log });
const qty = (shop, id) => shop.variants.find((v) => v.id === id).qty;

// 70 look-alike variants sharing the first 3 title words (like the Sidekick Pro family: 72 matches)
const lookalikes = () => Array.from({ length: 70 }, (_, i) => V(100 + i, 5, 'e*thirteen Sidekick Pro SL Front Hub', `v${i}`, null, 0));
const T1 = 'e*thirteen Sidekick Pro Front Hub';

test('(a) two keyed variants in one product with 72+ title matches: an edit on each reaches the other', async () => {
  const A = V(10, 1, T1, '32h 15x110', 'K', 0);
  const B = V(900, 1, T1, '32h 20x110', 'K', 0); // highest id: was cut off at 50 before
  const shop = makeShop([A, B, ...lookalikes()]);
  const redis = makeRedis();
  B.qty = 3; await fire(shop, redis, B);
  assert.equal(qty(shop, 10), 3);
  A.qty = 7; await fire(shop, redis, A);
  assert.equal(qty(shop, 900), 7);
  assert.ok(shop.variants.filter((v) => v.ptitle.includes('Sidekick Pro')).length >= 72);
});

test('(a2) the search follows cursors until exhausted (keyed variant on a late page, in another product)', async () => {
  const A = V(10, 1, T1, '32h 15x110', 'K', 0);
  const far = V(5000, 9, T1 + ' - 20x110mm Boost', '32h', 'K', 0);
  const shop = makeShop([A, far, ...lookalikes()], { pageCap: 20 });
  A.qty = 4; await fire(shop, makeRedis(), A);
  assert.equal(qty(shop, 5000), 4);
  assert.ok(shop.calls.filter((c) => c === 'SyncSearch').length >= 3);
});

test('(b) three variants incl. an old draft in another product: an edit on any one reaches both others', async () => {
  const mk = () => [V(10, 1, T1, '15x110', 'K', 0), V(900, 1, T1, '20x110', 'K', 0), V(20, 2, T1 + ' - 20x110mm Boost', 'old draft', 'K', 0), ...lookalikes()];
  for (const id of [10, 900, 20]) {
    const vs = mk();
    const shop = makeShop(vs);
    const t = vs.find((v) => v.id === id);
    t.qty = 3;
    await fire(shop, makeRedis(), t);
    assert.deepEqual([10, 900, 20].map((i) => qty(shop, i)), [3, 3, 3], `trigger ${id}`);
  }
});

test('(c) two edits in quick succession end at the last value (stale webhook payload is not trusted)', async () => {
  const A = V(10, 1, T1, '15x110', 'K', 0);
  const B = V(900, 1, T1, '20x110', 'K', 0);
  const shop = makeShop([A, B]);
  const redis = makeRedis();
  A.qty = 3; // edit 1 (its webhook is still queued)
  A.qty = 5; // edit 2 lands before webhook 1 is processed
  await fire(shop, redis, A); // webhook 1 (its payload would say 3)
  await fire(shop, redis, A); // webhook 2
  assert.equal(qty(shop, 900), 5);
  assert.ok(shop.writes.every((w) => w.to === 5), 'never wrote the stale 3');
});

test('(c2) a sibling edited meanwhile is not overwritten blindly (write refused, no relative delta)', async () => {
  const A = V(10, 1, T1, '15x110', 'K', 3);
  const B = V(900, 1, T1, '20x110', 'K', 0);
  const shop = makeShop([A, B]);
  const real = shop.gql; // B changes between our read and our write
  shop.gql = async (q, v) => { if (q.includes('SyncSet')) B.qty = 9; return real(q, v); };
  const logs = [];
  await fire(shop, makeRedis(), A, (m) => logs.push(m));
  assert.equal(qty(shop, 900), 9);
  assert.ok(logs.some((l) => l.includes('write refused')));
});

test('(d) echo webhooks caused by our own mirror writes are ignored and cause no further writes', async () => {
  const A = V(10, 1, T1, '15x110', 'K', 0);
  const B = V(900, 1, T1, '20x110', 'K', 0);
  const C = V(20, 2, T1 + ' - old', 'draft', 'K', 0);
  const shop = makeShop([A, B, C]);
  const redis = makeRedis();
  A.qty = 3; await fire(shop, redis, A);
  assert.equal(shop.writes.length, 2);
  for (const echo of [B, C]) { const r = await fire(shop, redis, echo); assert.equal(r.action, 'echo-ignored'); }
  assert.equal(shop.writes.length, 2);
  // even without redis an echo is harmless: everything is already equal, nothing is written
  const r2 = await fire(shop, null, B);
  assert.equal(shop.writes.length, 2);
  assert.ok(r2.results.every((x) => x.action === 'already'));
});

test('(e) unkeyed variants and other keys are untouched; a trigger without a key does nothing', async () => {
  const A = V(10, 1, T1, '15x110', 'K', 0);
  const B = V(900, 1, T1, '20x110', 'K', 0);
  const noKey = V(11, 1, T1, '28h', null, 2);
  const other = V(12, 1, T1, '28h other', 'OTHER', 2);
  const shop = makeShop([A, B, noKey, other]);
  A.qty = 3; await fire(shop, makeRedis(), A);
  assert.equal(qty(shop, 900), 3); assert.equal(qty(shop, 11), 2); assert.equal(qty(shop, 12), 2);
  noKey.qty = 8;
  const r = await fire(shop, makeRedis(), noKey);
  assert.equal(r.action, 'no-key'); assert.equal(shop.writes.length, 1);
});

test('one log line per decision: trigger id, key, siblings found, write or skip with reason', async () => {
  const A = V(10, 1, T1, '15x110', 'K', 3);
  const B = V(900, 1, T1, '20x110', 'K', 0);
  const C = V(901, 1, T1, '20x110 b', 'K', 3);
  const shop = makeShop([A, B, C]);
  const logs = [];
  await fire(shop, makeRedis(), A, (m) => logs.push(m));
  assert.ok(logs[0].includes('trigger gid://shopify/ProductVariant/10') && logs[0].includes('key [K]') && logs[0].includes('siblings found 2'));
  assert.ok(logs.some((l) => l.includes('wrote') && l.includes('0 -> 3')));
  assert.ok(logs.some((l) => l.includes('skipped') && l.includes('already 3')));
});
