// Historical order counts (custom.historical_order_count on each variant), CommonJS.
// Same data as before (current count +/- ordered quantity for every line that has a variant and a SKU),
// but in 2 Shopify calls per order instead of 2 per line:
//   1 read   : nodes(ids: [...]) for all variants of the order (100 per call)
//   1 write  : one metafieldsSet with all new counts (25 per call, Shopify's limit)
// Lines of the same variant are added together first. A failed lookup or write is logged and skipped;
// it never throws, so the order webhook still finishes (and still returns 200).
// gql(query, variables) -> parsed GraphQL JSON ({ data, errors }), injected so it can be tested.

const READ_CHUNK = 100;
const WRITE_CHUNK = 25;

const READ = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id historicalOrderCount: metafield(namespace: "custom", key: "historical_order_count") { value } } } }`;
const WRITE = `mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message } } }`;

async function updateHistoricalCounts(lineItems, direction, { gql, log = console.log }) {
  const stats = { linesSeen: (lineItems || []).length, skuLines: 0, variants: 0, calls: 0, updated: 0, failed: 0 };
  const qty = new Map(); // variant gid -> total ordered quantity
  const skuOf = new Map();
  for (const item of lineItems || []) {
    if (!item.variant_id || !item.sku) continue;
    stats.skuLines++;
    const id = `gid://shopify/ProductVariant/${item.variant_id}`;
    qty.set(id, (qty.get(id) || 0) + (Number(item.quantity) || 0));
    skuOf.set(id, item.sku);
  }
  stats.variants = qty.size;
  const ids = [...qty.keys()];

  const current = new Map(); // variant gid -> current count
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK);
    try {
      stats.calls++;
      const r = await gql(READ, { ids: chunk });
      if (r.errors || !r.data) throw new Error(JSON.stringify(r.errors || r).slice(0, 300));
      for (const n of r.data.nodes || []) {
        if (n && n.id) current.set(n.id, n.historicalOrderCount ? parseInt(n.historicalOrderCount.value, 10) || 0 : 0);
      }
    } catch (e) {
      stats.failed += chunk.length;
      log(`Historical counts: lookup FAILED for ${chunk.length} variant(s) (${chunk.map((c) => skuOf.get(c)).join(', ')}): ${e.message}`);
    }
  }

  const writes = [];
  for (const id of ids) {
    if (!current.has(id)) continue; // lookup failed or variant gone: nothing is written for it
    const cur = current.get(id);
    const next = direction === 'increment' ? cur + qty.get(id) : Math.max(0, cur - qty.get(id));
    writes.push({ id, sku: skuOf.get(id), cur, next });
  }
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    const chunk = writes.slice(i, i + WRITE_CHUNK);
    try {
      stats.calls++;
      const r = await gql(WRITE, { metafields: chunk.map((w) => ({ ownerId: w.id, namespace: 'custom', key: 'historical_order_count', value: String(w.next), type: 'number_integer' })) });
      const errs = r.data?.metafieldsSet?.userErrors || [];
      if (r.errors || errs.length) throw new Error(JSON.stringify(r.errors || errs).slice(0, 300));
      stats.updated += chunk.length;
      chunk.forEach((w) => log(`Updated historical count for SKU ${w.sku} from ${w.cur} to ${w.next}.`));
    } catch (e) {
      stats.failed += chunk.length;
      log(`Historical counts: write FAILED for ${chunk.length} variant(s) (${chunk.map((w) => w.sku).join(', ')}): ${e.message}`);
    }
  }
  log(`Historical counts (${direction}): lines seen ${stats.linesSeen}, SKU'd lines ${stats.skuLines}, variants ${stats.variants}, Shopify calls ${stats.calls}, updated ${stats.updated}, failed ${stats.failed}.`);
  return stats;
}

module.exports = { updateHistoricalCounts };
