import { Redis } from '@upstash/redis';
import { Resend } from 'resend';
import { createHmac } from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

// --- HELPERS ---

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Helper to run GraphQL queries/mutations
async function shopifyGraphqlClient(query, variables) {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN || 'loamlabs.myshopify.com';
  
  const response = await fetch(`https://${shopifyDomain}/admin/api/2024-04/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const jsonResponse = await response.json();
  if (jsonResponse.errors) {
    console.error('Shopify GraphQL Error:', JSON.stringify(jsonResponse.errors, null, 2));
    throw new Error('GraphQL Error');
  }
  return jsonResponse;
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const resend = new Resend(process.env.RESEND_API_KEY);

// --- DATA FETCHING ---

const getVariantDataByInventoryItemId = async (inventoryItemId) => {
  const query = `
    query getVariantByInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        variant {
          id
          title
          inventoryQuantity
          syncKey: metafield(namespace: "custom", key: "inventory_sync_key") {
            value
          }
          image {
            url(transform: {maxWidth: 200, maxHeight: 200, crop: CENTER})
          }
          product {
            title
            handle
            onlineStoreUrl
            featuredImage {
               url(transform: {maxWidth: 200, maxHeight: 200, crop: CENTER})
            }
          }
        }
      }
    }
  `;

  const variables = { id: `gid://shopify/InventoryItem/${inventoryItemId}` };
  const result = await shopifyGraphqlClient(query, variables);
  
  return result.data?.inventoryItem?.variant;
};

// --- SYNC LOGIC (BROAD SEARCH STRATEGY) ---

async function syncSiblingInventory(triggerVariant, newQuantity, locationId) {
  const syncKey = triggerVariant.syncKey?.value;

  // If no sync key, we don't do anything
  if (!syncKey) return;

  console.log(`Sync Logic: Key found [${syncKey}]. Trigger Variant: ${triggerVariant.id}. Target Qty: ${newQuantity}`);

  // STRATEGY: Instead of searching by Metafield (which is slow/flaky), 
  // we search by the Product Title to find "cousins", then filter in JS.
  
  // 1. Construct a broad search term from the title (First 3 words)
  // e.g. "e*thirteen Sidekick Front Hub..." -> "e*thirteen Sidekick Front"
  const safeTitleTerms = triggerVariant.product.title.split(' ').slice(0, 3).join(' ');
  
  const querySiblings = `
    query getSiblings($filter: String!) {
      productVariants(first: 50, query: $filter) {
        edges {
          node {
            id
            title
            inventoryQuantity
            product { title } 
            inventoryItem { id }
            metafield(namespace: "custom", key: "inventory_sync_key") { value }
          }
        }
      }
    }
  `;

  // We simply search for the title text. This is always indexed.
  const filter = `${safeTitleTerms}`; 
  const result = await shopifyGraphqlClient(querySiblings, { filter });
  const candidates = result.data.productVariants.edges.map(e => e.node);

  console.log(`Sync Logic: Broad title search for "${safeTitleTerms}" found ${candidates.length} candidates.`);

  // 2. Strict Filter in JavaScript
  // We only keep items that have the EXACT SAME sync key
  const siblingsToUpdate = candidates.filter(v => 
    v.metafield?.value === syncKey &&      // Must match key
    v.id !== triggerVariant.id &&          // Don't update self
    v.inventoryQuantity !== newQuantity    // Don't update if already correct
  );

  if (siblingsToUpdate.length === 0) {
    console.log('Sync Logic: No siblings found needing update.');
    return;
  }

  console.log(`Sync Logic: Found ${siblingsToUpdate.length} siblings to update: ${siblingsToUpdate.map(s => s.product.title).join(', ')}`);

  // 3. Apply Updates
  const mutation = `
    mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
      inventoryAdjustQuantities(input: $input) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  for (const sibling of siblingsToUpdate) {
    const delta = newQuantity - sibling.inventoryQuantity;
    
    if (!locationId) {
        console.error("Sync Logic Error: No location_id provided, cannot adjust.");
        break;
    }

    const variables = {
      input: {
        reason: "correction",
        name: "available",
        changes: [
          {
            delta: delta,
            inventoryItemId: sibling.inventoryItem.id,
            locationId: `gid://shopify/Location/${locationId}`
          }
        ]
      }
    };

    await shopifyGraphqlClient(mutation, variables);
    console.log(`Sync Logic: Updated sibling ${sibling.product.title} (${sibling.title}) by ${delta} to match ${newQuantity}`);
  }
}

// --- MAIN HANDLER ---

export default async function handler(req, res) {
  // 1. Verification
  let rawBody;
  try {
    const buf = await buffer(req);
    rawBody = buf.toString('utf8');
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const hash = createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET).update(rawBody, 'utf8').digest('base64');
    if (hmac !== hash) {
      return res.status(401).send('Unauthorized');
    }
  } catch (error) {
    return res.status(400).send('Invalid webhook payload');
  }

  try {
    if (!rawBody) { return res.status(200).json({ message: 'Empty body' }); }
    const body = JSON.parse(rawBody);
    
    const { inventory_item_id, location_id, available } = body;

    // 2. Fetch Data
    const variant = await getVariantDataByInventoryItemId(inventory_item_id);

    if (!variant) {
      console.log(`No variant found for inventory item ID ${inventory_item_id}.`);
      return res.status(200).json({ message: 'Variant not found.' });
    }

    // --- LOGIC BLOCK A: INVENTORY SYNC ---
    if (location_id) {
        await syncSiblingInventory(variant, available, location_id);
    } else {
        console.warn("Webhook missing location_id, skipping sync logic.");
    }

    // --- LOGIC BLOCK B: NOTIFICATIONS (Existing) ---
    if (!available || available <= 0) {
      return res.status(200).json({ message: 'Synced inventory (if applicable). No notifications sent (stock <= 0).' });
    }

    const variantGid = variant.id;
    const variantId = variantGid.split('/').pop();
    const redisKey = `stock_notification_requests:${variantId}`;

    const emails = await redis.lrange(redisKey, 0, -1);
    if (emails.length === 0) {
      return res.status(200).json({ message: `Synced inventory. No notifications waiting for variant ${variantId}.` });
    }

    const uniqueEmails = [...new Set(emails)];
    const productTitle = variant.product.title;
    const variantTitle = variant.title;
    const productUrl = `${variant.product.onlineStoreUrl}?variant=${variantId}`;
    const imageUrl = variant.image?.url || variant.product.featuredImage?.url;

    const emailHtmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #333; }
          .container { max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 8px; }
          .product-box { border: 1px solid #ddd; padding: 20px; text-align: center; border-radius: 5px; margin-top: 20px; }
          .product-image { max-width: 150px; height: auto; margin-bottom: 20px; }
          .cta-button { display: inline-block; background-color: #1a1a1a; color: #ffffff; padding: 14px 28px; text-decoration: none; font-weight: bold; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Great News!</h2>
          <p>The item you requested a notification for is now back in stock.</p>
          <div class="product-box">
            ${imageUrl ? `<img src="${imageUrl}" alt="${productTitle}" class="product-image">` : ''}
            <h3>${productTitle}</h3>
            <p><strong>Variant:</strong> ${variantTitle}</p>
            <a href="${productUrl}" class="cta-button">View Product</a>
          </div>
          <p style="text-align:center; margin-top:30px; font-size: 14px; color: #777;">Stock is limited. Don't miss out!</p>
        </div>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: 'LoamLabs Support <notify@loamlabsusa.com>',
      to: uniqueEmails,
      subject: `✅ It's Back! ${productTitle} is in stock`,
      html: emailHtmlBody,
      text: `Great news! The item you wanted, ${productTitle} (${variantTitle}), is back in stock. Shop now: ${productUrl}`
    });

    await redis.del(redisKey);
    return res.status(200).json({ success: true, message: `Synced inventory and sent ${uniqueEmails.length} notifications.` });

  } catch (error) {
    console.error('Error in /api/handle-inventory-update:', error);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
}
