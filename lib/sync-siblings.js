// inventory_sync_key mirroring (block A of api/handle-inventory-update.js).
//
// Rules:
//  - siblings are found by EXACT key (never by title words alone, never cut off at 50);
//  - the trigger's live available is re-read (the webhook payload is not trusted);
//  - siblings are set to that ABSOLUTE value with inventorySetQuantities + changeFromQuantity
//    (the write is refused if the sibling changed in the meantime: its own webhook then mirrors it back);
//  - writes made by this code are remembered for 15 s so the echo webhooks they cause are ignored.
// Dependencies (gql, redis, log) are injected so the logic can be tested with a mocked Shopify.

export const SYNC_API_VERSION = '2025-01'; // inventorySetQuantities with changeFromQuantity verified on this version
const MAX_SEARCH_PAGES = 40;
const ECHO_TTL_SECONDS = 15;
const KEY_MF = 'metafield(namespace: "custom", key: "inventory_sync_key") { value }';

export function makeSyncGql(fetchImpl = fetch) {
  return async (query, variables) => {
    const domain = process.env.SHOPIFY_STORE_DOMAIN || 'loamlabs.myshopify.com';
    const response = await fetchImpl(`https://${domain}/admin/api/${SYNC_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const json = await response.json();
    if (json.errors) {
      console.error('Shopify GraphQL Error:', JSON.stringify(json.errors, null, 2));
      throw new Error('GraphQL Error');
    }
    return json;
  };
}

const availableOf = (item) => {
  const q = item?.inventoryLevel?.quantities?.find((x) => x.name === 'available');
  return q ? q.quantity : null; // null = item not stocked at this location
};

async function safeRedis(fn) { try { return await fn(); } catch { return null; } }

export async function syncSiblingInventory({ triggerVariant, inventoryItemId, locationId, gql, redis, log = console.log }) {
  const syncKey = triggerVariant?.syncKey?.value;
  const tag = `Sync Logic [trigger ${triggerVariant?.id}]`;
  if (!syncKey) { log(`${tag}: no inventory_sync_key, nothing to do.`); return { action: 'no-key' }; }
  if (!locationId) { log(`${tag}: key [${syncKey}] but webhook has no location_id, skipped.`); return { action: 'no-location' }; }
  const locGid = `gid://shopify/Location/${locationId}`;
  const itemGid = `gid://shopify/InventoryItem/${inventoryItemId}`;

  // 1. live value of the trigger at this location (not the webhook payload)
  const live = await gql(
    `query SyncReadTrigger($id: ID!, $loc: ID!) { inventoryItem(id: $id) { id inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } }`,
    { id: itemGid, loc: locGid }
  );
  const target = availableOf(live.data?.inventoryItem);
  if (target === null) { log(`${tag}: key [${syncKey}] trigger has no level at location ${locationId}, skipped.`); return { action: 'no-level' }; }

  // 2. echo of our own write? (same value we just set on this item)
  const echo = await safeRedis(() => redis.get(`inv_sync_echo:${inventoryItemId}`));
  if (echo !== null && echo !== undefined && Number(echo) === target) {
    log(`${tag}: key [${syncKey}] echo of our own mirror write (available ${target}), ignored.`);
    return { action: 'echo-ignored' };
  }

  // 3. find siblings: same product first, then the paged broader search; identical key only
  const found = new Map();
  const fields = `id title product { id title } inventoryItem { id inventoryLevel(locationId: $loc) { quantities(names: ["available"]) { name quantity } } } ${KEY_MF}`;
  const consider = (v) => { if (v?.metafield?.value === syncKey && !found.has(v.id)) found.set(v.id, v); };

  const productId = triggerVariant.product?.id;
  if (productId) {
    let after = null;
    for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
      const r = await gql(
        `query SyncProductVariants($pid: ID!, $loc: ID!, $after: String) { product(id: $pid) { variants(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } } }`,
        { pid: productId, loc: locGid, after }
      );
      const conn = r.data?.product?.variants;
      (conn?.nodes || []).forEach(consider);
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  }
  const sameProduct = found.size;

  const terms = (triggerVariant.product?.title || '').split(' ').slice(0, 3).join(' ');
  let pages = 0, scanned = 0, exhausted = true;
  if (terms) {
    let after = null;
    for (; pages < MAX_SEARCH_PAGES; pages++) {
      const r = await gql(
        `query SyncSearch($q: String!, $loc: ID!, $after: String) { productVariants(first: 250, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`,
        { q: terms, loc: locGid, after }
      );
      const conn = r.data?.productVariants;
      (conn?.nodes || []).forEach((v) => { scanned++; consider(v); });
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
      if (pages === MAX_SEARCH_PAGES - 1) exhausted = false;
    }
  }
  if (!exhausted) log(`${tag}: WARNING search stopped at ${MAX_SEARCH_PAGES} pages, not exhausted.`);

  const siblings = [...found.values()].filter((v) => v.id !== triggerVariant.id);
  log(`${tag}: key [${syncKey}] target ${target}; siblings found ${siblings.length} (${sameProduct - (found.has(triggerVariant.id) ? 1 : 0)} in own product, search scanned ${scanned} variants in ${pages + 1} page(s)).`);

  // 4. absolute writes, guarded by changeFromQuantity
  const results = [];
  for (const sib of siblings) {
    const label = `${sib.product?.title} (${sib.title}) ${sib.id}`;
    const cur = availableOf(sib.inventoryItem);
    if (cur === null) { log(`${tag}: skipped ${label}: no level at location ${locationId}.`); results.push({ id: sib.id, action: 'no-level' }); continue; }
    if (cur === target) { log(`${tag}: skipped ${label}: already ${target}.`); results.push({ id: sib.id, action: 'already' }); continue; }
    const r = await gql(
      `mutation SyncSet($input: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $input) { userErrors { field message code } } }`,
      { input: { reason: 'correction', name: 'available', quantities: [{ inventoryItemId: sib.inventoryItem.id, locationId: locGid, quantity: target, changeFromQuantity: cur }] } }
    );
    const errs = r.data?.inventorySetQuantities?.userErrors || [];
    if (errs.length) {
      log(`${tag}: skipped ${label}: write refused (${errs.map((e) => e.message).join('; ')}); it changed meanwhile, its own webhook will mirror it.`);
      results.push({ id: sib.id, action: 'refused' });
      continue;
    }
    const sibItemNum = sib.inventoryItem.id.split('/').pop();
    await safeRedis(() => redis.set(`inv_sync_echo:${sibItemNum}`, String(target), { ex: ECHO_TTL_SECONDS }));
    log(`${tag}: wrote ${label}: ${cur} -> ${target}.`);
    results.push({ id: sib.id, action: 'written', from: cur, to: target });
  }
  return { action: 'done', target, results };
}
