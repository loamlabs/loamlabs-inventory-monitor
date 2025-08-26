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
        const newCount = direction === 'increment' ? currentCount + item.quantity : Math.max(0, currentCount - item.quantity);
        
        await client.query({
            data: {
                query: `mutation($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message } } }`,
                variables: {
                    metafields: [{
                        ownerId: variantId, namespace: "custom", key: "historical_order_count",
                        value: newCount.toString(), type: "number_integer"
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
    
    // 1. UPDATED GRAPHQL QUERY:
    // The query now fetches 'inventory_alert_threshold' from each VARIANT, not the product.
    const allSpokesResponse = await new shopify.clients.Graphql({ session: getSession() }).query({
        data: {
            query: `query { products(first: 250, query: "tag:'component:spoke'") {
                edges { node {
                    title
                    inventoryMonitoringEnabled: metafield(namespace: "custom", key: "inventory_monitoring_enabled") { value }
                    variants(first: 100) { edges { node {
                        id title inventoryQuantity sku
                        inventoryAlertThreshold: metafield(namespace: "custom", key: "inventory_alert_threshold") { value }
                        historicalOrderCount: metafield(namespace: "custom", key: "historical_order_count") { value }
                    }}}
                }}
            }}`
        }
    });

    const currentLowStockItems = [];
    const allSpokeProducts = allSpokesResponse.body.data.products.edges;

    for (const { node: product } of allSpokeProducts) {
      // Product-level monitoring check remains the same
      const isMonitoringEnabled = product.inventoryMonitoringEnabled?.value === 'true';
      if (!isMonitoringEnabled) continue;

      for (const { node: variant } of product.variants.edges) {
        if (variant.title.endsWith(' / -')) continue;

        // 2. UPDATED THRESHOLD LOGIC:
        // It now reads the threshold from the VARIANT's metafield.
        // If a variant doesn't have the metafield, it defaults to 0 and will likely not be reported.
        const thresholdString = variant.inventoryAlertThreshold?.value || '0';
        const alertThreshold = parseInt(thresholdString, 10);
        
        // We add a check to only include variants that have a specific threshold set.
        if (alertThreshold <= 0) continue;

        if (variant.inventoryQuantity < alertThreshold) {
          currentLowStockItems.push({
            productTitle: product.title, 
            alertThreshold: alertThreshold, // This is now the variant-specific threshold
            variantTitle: variant.title,
            sku: variant.sku, 
            quantity: variant.inventoryQuantity,
            historicalCount: parseInt(variant.historicalOrderCount?.value, 10) || 0,
          });
        }
      }
    }
    
    const previousReportJSON = await redis.get('last_report_list_json');
    let previousLowStockSKUs = [];
    try {
        if (previousReportJSON) {
            previousLowStockSKUs = JSON.parse(previousReportJSON);
        }
    } catch (e) {
        console.warn("Could not parse previous report from Redis, it might be malformed. Starting fresh.");
        previousLowStockSKUs = [];
    }
    
    const currentLowStockSKUs = currentLowStockItems.map(item => item.sku).sort();

    if (JSON.stringify(previousLowStockSKUs.sort()) === JSON.stringify(currentLowStockSKUs)) {
      console.log('Low-stock list unchanged. No new report needed.');
      return;
    }
    
    if (currentLowStockItems.length > 0) {
        // 3. UPDATED REPORTING LOGIC:
        // The report grouping is simplified, and the specific threshold is shown for each variant.
        let reportHtml = `<h1>Cumulative Low Stock Report</h1><p>The following spoke products have variants below their defined stock thresholds.</p>`;
        const groupedItems = currentLowStockItems.reduce((acc, item) => {
            const key = item.productTitle; // Group by product title only
            if (!acc[key]) acc[key] = [];
            acc[key].push(item);
            return acc;
        }, {});

        for (const groupName in groupedItems) {
            reportHtml += `<hr><h3>${groupName}</h3><ul>`;
            for (const item of groupedItems[groupName]) {
                reportHtml += `<li><strong>${item.variantTitle}</strong><br>SKU: ${item.sku || 'N/A'}<br>Current Quantity: ${item.quantity} (Alert Threshold: ${item.alertThreshold})<br>Historical Sales Count: ${item.historicalCount}</li>`;
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
    } else {
        console.log('All previously low-stock items have been restocked. Clearing memory and not sending an email.');
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
  // --- MANUAL TEST TRIGGER ---
  // This allows you to test by visiting the URL with a secret key.
  // Example: https://your-vercel-url.vercel.app/api/index?test_mode=true&secret=YOUR_SECRET_KEY
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get('test_mode') === 'true') {
      if (url.searchParams.get('secret') === process.env.MANUAL_TEST_SECRET) {
        console.log('MANUAL TEST TRIGGERED. Running inventory check...');
        // We pass an empty payload because the function fetches fresh data from Shopify anyway.
        await handleOrderCreate({ line_items: [] }); 
        console.log('Manual test completed successfully.');
        return res.status(200).send('Manual test triggered and completed successfully. Check logs and email for report.');
      } else {
        console.warn('Manual test trigger attempted with invalid secret.');
        return res.status(401).send('Invalid secret for test mode.');
      }
    }
  } catch (e) {
      // This will ignore errors if the URL is not what we expect, and proceed to webhook logic
  }
  // --- END MANUAL TEST TRIGGER ---


  console.log('Webhook received. Starting process...');
  try {
    const rawBody = await readRawBody(req);
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
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
