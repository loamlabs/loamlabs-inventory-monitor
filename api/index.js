// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');
const crypto = require('crypto');

// --- CONFIGURATION ---
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  RESEND_API_KEY,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

// Initialize clients
const shopify = shopifyApi.shopifyApi({
  apiSecretKey: 'not-used-for-admin-token',
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
  isCustomStoreApp: true,
  hostName: SHOPIFY_STORE_DOMAIN.replace('https://', ''),
  apiVersion: shopifyApi.LATEST_API_VERSION,
});
const resend = new Resend(RESEND_API_KEY);
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});

// --- HELPER FUNCTIONS ---
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', err => reject(err));
  });
}

function getSession() {
    return {
        id: 'inventory-management-session',
        shop: SHOPIFY_STORE_DOMAIN,
        accessToken: SHOPIFY_ADMIN_API_TOKEN,
        state: 'not-used',
        isOnline: false,
    };
}

async function updateHistoricalCounts(lineItems, direction) {
    const client = new shopify.clients.Graphql({ session: getSession() });
    for (const item of lineItems) {
        if (!item.variant_id || !item.sku) continue;

        const variantId = `gid://shopify/ProductVariant/${item.variant_id}`;
        
        const response = await client.query({
            data: {
                query: `query($id: ID!) { productVariant(id: $id) {
                    historicalOrderCount: metafield(namespace: "custom", key: "historical_order_count") { id value }
                }}`,
                variables: { id: variantId }
            }
        });

        const metafield = response.body.data.productVariant.historicalOrderCount;
        const currentCount = metafield ? parseInt(metafield.value, 10) : 0;
        const newCount = direction === 'increment' 
            ? currentCount + item.quantity 
            : Math.max(0, currentCount - item.quantity);

        await client.query({
            data: {
                query: `mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message } } }`,
                variables: {
                    metafields: [{
                        ownerId: variantId,
                        namespace: "custom",
                        key: "historical_order_count",
                        value: newCount.toString(),
                        type: "number_integer"
                    }]
                }
            }
        });
        console.log(`Updated historical count for SKU ${item.sku} from ${currentCount} to ${newCount}.`);
    }
}

// --- CORE LOGIC FUNCTIONS ---
async function handleOrderCreate(orderPayload) {
    console.log("Handling Order Create event...");
    await updateHistoricalCounts(orderPayload.line_items, 'increment');
    
    const allSpokesResponse = await new shopify.clients.Graphql({ session: getSession() }).query({
        data: {
            query: `query { products(first: 250, query: "tag:'component:spoke'") {
                edges { node {
                    title
                    inventoryAlertThreshold: metafield(namespace: "custom", key: "inventory_alert_threshold") { value }
                    inventoryMonitoringEnabled: metafield(namespace: "custom", key: "inventory_monitoring_enabled") { value }
                    variants(first: 100) { edges { node {
                        id title inventoryQuantity sku
                        historicalOrderCount: metafield(namespace: "custom", key: "historical_order_count") { value }
                    }}}
                }}
            }}`
        }
    });

    const currentLowStockItems = [];
    const allSpokeProducts = allSpokesResponse.body.data.products.edges;

    for (const { node: product } of allSpokeProducts) {
      const isMonitoringEnabled = product.inventoryMonitoringEnabled?.value === 'true';
      if (!isMonitoringEnabled) continue;
      const thresholdString = product.inventoryAlertThreshold?.value || '0';
      const alertThreshold = parseInt(thresholdString.replace(/\D/g, ''), 10);
      for (const { node: variant } of product.variants.edges) {
        if (variant.inventoryQuantity < alertThreshold) {
          currentLowStockItems.push({
            productTitle: product.title,
            alertThreshold: alertThreshold,
            variantTitle: variant.title,
            sku: variant.sku,
            quantity: variant.inventoryQuantity,
            historicalCount: parseInt(variant.historicalOrderCount?.value, 10) || 0,
          });
        }
      }
    }
    
    const previousReportJSON = await redis.get('last_report_list_json');
    const previousLowStockSKUs = previousReportJSON ? JSON.parse(previousReportJSON) : [];
    const currentLowStockSKUs = currentLowStockItems.map(item => item.sku).sort();

    if (JSON.stringify(previousLowStockSKUs.sort()) === JSON.stringify(currentLowStockSKUs)) {
      console.log('Low-stock list unchanged. No new report needed.');
      return;
    }
    
    if (currentLowStockItems.length > 0) {
        let reportHtml = `<h1>Cumulative Low Stock Report</h1><p>The following spoke products have variants below their defined stock thresholds.</p>`;
        const groupedItems = currentLowStockItems.reduce((acc, item) => {
            const key = `${item.productTitle} (Threshold: ${item.alertThreshold})`;
            if (!acc[key]) acc[key] = [];
            acc[key].push(item);
            return acc;
        }, {});
        for (const groupName in groupedItems) {
            reportHtml += `<hr><h3>${groupName}</h3><ul>`;
            for (const item of groupedItems[groupName]) {
                reportHtml += `<li><strong>${item.variantTitle}</strong><br>SKU: ${item.sku || 'N/A'}<br>Current Quantity: ${item.quantity}<br>Historical Sales Count: ${item.historicalCount}</li>`;
            }
            reportHtml += `</ul>`;
        }
        reportHtml += `<hr><p>Please consider reordering soon.</p>`;
        
        await resend.emails.send({
            from: 'LoamLabs Alerts <info@loamlabsusa.com>',
            to: 'info@loamlabsusa.com',
            subject: `CUMULATIVE Low Stock Report (${currentLowStockItems.length} variants)`,
            html: reportHtml,
        });
        console.log(`Cumulative report sent successfully.`);
    }

    await redis.set('last_report_list_json', JSON.stringify(currentLowStockSKUs));
    console.log('Updated low-stock list in database memory.');
}

async function handleOrderCancelled(orderPayload) {
    console.log("Handling Order Cancelled event...");
    await updateHistoricalCounts(orderPayload.line_items, 'decrement');
}

// The main function, which now acts as a router
module.exports = async (req, res) => {
  console.log('Webhook received. Starting process...');
  try {
    const rawBody = await readRawBody(req);
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    
    // ----- THIS IS THE CORRECTED LINE -----
    // The typo 'sha2sha256' has been corrected to 'sha256'
    const generatedHash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody, 'utf-8').digest('base64');
    
    if (generatedHash !== hmac) {
      console.error('Webhook verification failed.');
      return res.status(401).send('Unauthorized');
    }
    console.log(`Webhook verified successfully for topic: ${topic}`);

    const payload = JSON.parse(rawBody);

    if (topic === 'orders/create') {
      await handleOrderCreate(payload);
    } else if (topic === 'orders/cancelled') {
      await handleOrderCancelled(payload);
    } else {
      console.log(`Received unhandled topic: ${topic}. Exiting.`);
    }

    res.status(200).send('OK');

  } catch (error) {
    console.error('An error occurred:', error.message, error.stack);
    res.status(500).send('An internal error occurred.');
  }
};
