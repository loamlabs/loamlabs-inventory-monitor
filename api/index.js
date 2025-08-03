// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Redis } = require('@upstash/redis');
const { Resend } = require('resend');
const crypto =require('crypto');

// --- CONFIGURATION ---
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  RESEND_API_KEY,
  // These are automatically added by the Vercel Upstash Integration
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} = process.env;

// The cooldown period in hours. No new reports will be sent during this time.
const COOLDOWN_HOURS = 4;

// Initialize the Shopify API client
const shopify = shopifyApi.shopifyApi({
  apiSecretKey: 'not-used-for-admin-token',
  adminApiAccessToken: SHOPIFY_ADMIN_API_TOKEN,
  isCustomStoreApp: true,
  hostName: SHOPIFY_STORE_DOMAIN.replace('https://', ''),
  apiVersion: shopifyApi.LATEST_API_VERSION,
});

// Initialize the Resend client for sending emails
const resend = new Resend(RESEND_API_KEY);

// Initialize the Upstash Redis client for our database "memory"
const redis = new Redis({
  url: UPSTASH_REDIS_REST_URL,
  token: UPSTASH_REDIS_REST_TOKEN,
});


// Helper function to read the raw body from a request
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', err => reject(err));
  });
}

// This is the main function that runs when an order is created
module.exports = async (req, res) => {
  console.log('Order creation webhook received. Starting process...');

  try {
    // --- 1. VERIFY THE REQUEST IS FROM SHOPIFY ---
    const rawBody = await readRawBody(req);
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const generatedHash = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody, 'utf-8')
      .digest('base64');

    if (generatedHash !== hmac) {
      console.error('Webhook verification failed.');
      return res.status(401).send('Unauthorized');
    }
    console.log('Webhook verified successfully.');

    // --- 2. CHECK THE COOLDOWN PERIOD ---
    const lastReportTimestamp = await redis.get('last_report_sent_timestamp');
    if (lastReportTimestamp) {
      const hoursSinceLastReport = (Date.now() - lastReportTimestamp) / (1000 * 60 * 60);
      if (hoursSinceLastReport < COOLDOWN_HOURS) {
        console.log(`Cooldown active. Last report sent ${hoursSinceLastReport.toFixed(2)} hours ago. Exiting.`);
        return res.status(200).send('OK (Cooldown active)');
      }
    }
    console.log('Cooldown period clear. Proceeding with check.');

    // --- 3. CHECK IF THIS ORDER TRIGGERED A NEW LOW-STOCK EVENT ---
    const orderPayload = JSON.parse(rawBody);
    const orderLineItems = orderPayload.line_items;

    let needsToSendReport = false;
    for (const item of orderLineItems) {
      // Find the spoke products in the order
      if (item.vendor === 'Sapim' || item.vendor === 'Berd') { // Adjust vendor names if needed
        const variantResponse = await shopify.clients.Graphql({ session: getSession() }).query({
          data: {
            query: `query { productVariant(id: "gid://shopify/ProductVariant/${item.variant_id}") {
                inventoryQuantity
                product {
                  inventoryAlertThreshold: metafield(namespace: "custom", key: "inventory_alert_threshold") { value }
                  inventoryMonitoringEnabled: metafield(namespace: "custom", key: "inventory_monitoring_enabled") { value }
                }
              }
            }`
          }
        });

        const variantData = variantResponse.body.data.productVariant;
        const productData = variantData.product;
        const isMonitoringEnabled = productData.inventoryMonitoringEnabled?.value === 'true';
        const thresholdString = productData.inventoryAlertThreshold?.value || '0';
        const alertThreshold = parseInt(thresholdString.replace(/\D/g, ''), 10);
        
        // Check if this specific item just crossed its threshold
        if (isMonitoringEnabled && variantData.inventoryQuantity < alertThreshold) {
            console.log(`Trigger event: ${item.title} dropped to ${variantData.inventoryQuantity} (Threshold: ${alertThreshold}).`);
            needsToSendReport = true;
            break; // We found a trigger, no need to check other items in the order
        }
      }
    }

    if (!needsToSendReport) {
      console.log('No new low-stock items in this order. No report needed.');
      return res.status(200).send('OK (No trigger)');
    }

    // --- 4. PERFORM FULL INVENTORY SCAN ---
    console.log('New low-stock item detected. Performing full scan of all spoke products...');
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

    const allSpokeProducts = allSpokesResponse.body.data.products.edges;
    const lowStockItems = [];

    for (const { node: product } of allSpokeProducts) {
      const isMonitoringEnabled = product.inventoryMonitoringEnabled?.value === 'true';
      if (!isMonitoringEnabled) continue;

      const thresholdString = product.inventoryAlertThreshold?.value || '0';
      const alertThreshold = parseInt(thresholdString.replace(/\D/g, ''), 10);

      for (const { node: variant } of product.variants.edges) {
        if (variant.inventoryQuantity < alertThreshold) {
          lowStockItems.push({
            productTitle: product.title,
            variantTitle: variant.title,
            sku: variant.sku,
            quantity: variant.inventoryQuantity,
            threshold: alertThreshold,
          });
        }
      }
    }

    if (lowStockItems.length === 0) {
        console.log('Full scan complete, but no items are currently below threshold. No report needed.');
        return res.status(200).send('OK (Scan found no low stock)');
    }

    // --- 5. BUILD AND SEND CUMULATIVE REPORT ---
    let reportHtml = `<h1>Cumulative Low Stock Report</h1><p>The following spoke variants are currently below their defined stock thresholds.</p><ul>`;
    for (const item of lowStockItems) {
      reportHtml += `<li><strong>${item.productTitle} - ${item.variantTitle}</strong><ul><li>Current Quantity: ${item.quantity}</li><li>Alert Threshold: ${item.threshold}</li></ul></li>`;
    }
    reportHtml += `</ul><p>Please consider reordering soon.</p>`;
    
    await resend.emails.send({
        from: 'LoamLabs Alerts <info@loamlabsusa.com>',
        to: 'info@loamlabsusa.com',
        subject: `CUMULATIVE Low Stock Report (${lowStockItems.length} items)`,
        html: reportHtml,
    });
    console.log(`Cumulative report sent successfully with ${lowStockItems.length} items.`);

    // --- 6. UPDATE THE COOLDOWN TIMESTAMP ---
    await redis.set('last_report_sent_timestamp', Date.now());
    console.log('Cooldown timestamp updated in database.');


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
