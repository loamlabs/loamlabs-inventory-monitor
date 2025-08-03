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

// Helper to read the request body
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', err => reject(err));
  });
}

// The main function, triggered by 'orders/create'
module.exports = async (req, res) => {
  console.log('Order creation webhook received. Starting process...');

  try {
    // 1. Verify the webhook is from Shopify
    const rawBody = await readRawBody(req);
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const generatedHash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody, 'utf-8').digest('base64');

    if (generatedHash !== hmac) {
      console.error('Webhook verification failed.');
      return res.status(401).send('Unauthorized');
    }
    console.log('Webhook verified successfully.');

    // 2. Initial Check: Does this order even contain spokes?
    const orderPayload = JSON.parse(rawBody);
    
    // ----- THIS IS THE IMPROVED LOGIC -----
    // We now check the Product Type for 'Spoke' which is more precise than checking the vendor.
    const containsSpokes = orderPayload.line_items.some(item => item.product_type === 'Spoke');

    if (!containsSpokes) {
        console.log("This order does not contain any spoke products. Exiting.");
        return res.status(200).send('OK (No spokes in order)');
    }
    console.log("Order contains spokes. Proceeding with full inventory scan.");

    // 3. Perform a FULL scan to get the CURRENT state of all low-stock spokes
    const allSpokesResponse = await shopify.clients.Graphql({ session: getSession() }).query({
        data: {
            query: `query { products(first: 250, query: "tag:Spoke") {
                edges { node {
                    title
                    inventoryAlertThreshold: metafield(namespace: "custom", key: "inventory_alert_threshold") { value }
                    inventoryMonitoringEnabled: metafield(namespace: "custom", key: "inventory_monitoring_enabled") { value }
                    variants(first: 100) { edges { node {
                        title inventoryQuantity sku
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
            variantTitle: variant.title,
            sku: variant.sku,
            quantity: variant.inventoryQuantity,
            threshold: alertThreshold,
          });
        }
      }
    }
    console.log(`Scan complete. Found ${currentLowStockItems.length} items currently below threshold.`);

    // 4. Compare CURRENT list with PREVIOUS list from memory
    const previousReportJSON = await redis.get('last_report_list_json');
    const previousLowStockSKUs = previousReportJSON ? JSON.parse(previousReportJSON) : [];
    const currentLowStockSKUs = currentLowStockItems.map(item => item.sku).sort();

    if (JSON.stringify(previousLowStockSKUs.sort()) === JSON.stringify(currentLowStockSKUs)) {
      console.log('The list of low-stock items has not changed since the last report. No new alert needed.');
      return res.status(200).send('OK (No change in low stock list)');
    }
    console.log('List of low-stock items has changed. A new report is required.');
    
    if (currentLowStockItems.length === 0) {
        console.log('All previously low-stock items have been restocked. Clearing memory.');
        await redis.del('last_report_list_json');
        return res.status(200).send('OK (All items restocked)');
    }

    // 5. Build and Send the new, updated report
    let reportHtml = `<h1>Cumulative Low Stock Report</h1><p>The following spoke variants are currently below their defined stock thresholds.</p><ul>`;
    for (const item of currentLowStockItems) {
      reportHtml += `<li><strong>${item.productTitle} - ${item.variantTitle}</strong><ul><li>SKU: ${item.sku || 'N/A'}</li><li>Current Quantity: ${item.quantity}</li><li>Alert Threshold: ${item.threshold}</li></ul></li>`;
    }
    reportHtml += `</ul><p>Please consider reordering soon.</p>`;
    
    await resend.emails.send({
        from: 'LoamLabs Alerts <info@loamlabsusa.com>',
        to: 'info@loamlabsusa.com',
        subject: `CUMULATIVE Low Stock Report (${currentLowStockItems.length} items)`,
        html: reportHtml,
    });
    console.log(`Cumulative report sent successfully with ${currentLowStockItems.length} items.`);

    // 6. Update the "memory" with the new list for the next comparison
    await redis.set('last_report_list_json', JSON.stringify(currentLowStockSKUs));
    console.log('Updated low-stock list in database memory.');


    res.status(200).send('OK');

  } catch (error) {
    console.error('An error occurred:', error.message, error.stack);
    res.status(500).send('An internal error occurred.');
  }
};

// Helper function to create a Shopify session on the fly
function getSession() {
    return {
        id: 'cumulative-inventory-session',
        shop: SHOPIFY_STORE_DOMAIN,
        accessToken: SHOPIFY_ADMIN_API_TOKEN,
        state: 'not-used',
        isOnline: false,
    };
}
