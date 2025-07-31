// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node');
const { Resend } = require('resend');
const crypto = require('crypto');

// --- CONFIGURATION ---
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  RESEND_API_KEY,
} = process.env;

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

// --- SPAM PREVENTION ---
const notifiedVariants = new Set();


// Helper function to read the raw body from a request
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', err => reject(err));
  });
}


// This is the main function that runs when the webhook is triggered
module.exports = async (req, res) => {
  console.log('Webhook received. Starting process...');

  try {
    // --- 1. VERIFY THE REQUEST IS FROM SHOPIFY (CRITICAL SECURITY STEP) ---
    const rawBody = await readRawBody(req);
    const hmac = req.headers['x-shopify-hmac-sha256'];

    const generatedHash = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody, 'utf-8')
      .digest('base64');

    if (generatedHash !== hmac) {
      console.error('Webhook verification failed: Invalid HMAC signature.');
      return res.status(401).send('Unauthorized');
    }
    console.log('Webhook verified successfully.');

    const payload = JSON.parse(rawBody);
    
    if (!payload || !payload.inventory_item_id) {
        console.log("Payload is likely a test webhook or not an inventory level update. Skipping logic and responding OK.");
        return res.status(200).send('OK (Test webhook received)');
    }
    
    const { inventory_item_id, available } = payload;

    // --- 2. GET PRODUCT DETAILS FROM SHOPIFY ---
    const graphqlClient = new shopify.clients.Graphql({
      session: {
        id: 'inventory-monitor-session',
        shop: SHOPIFY_STORE_DOMAIN,
        accessToken: SHOPIFY_ADMIN_API_TOKEN,
        state: 'not-used',
        isOnline: false,
      },
    });

    const response = await graphqlClient.query({
      data: {
        query: `
          query GetVariantAndProductMetafields($id: ID!) {
            inventoryItem(id: $id) {
              variant {
                id
                sku
                title
                product {
                  id
                  title
                  inventoryMonitoringEnabled: metafield(namespace: "custom", key: "inventory_monitoring_enabled") {
                    value
                  }
                  inventoryAlertThreshold: metafield(namespace: "custom", key: "inventory_alert_threshold") {
                    value
                  }
                }
              }
            }
          }
        `,
        variables: { id: `gid://shopify/InventoryItem/${inventory_item_id}` },
      },
    });

    const variant = response.body.data.inventoryItem?.variant;
    if (!variant) {
      console.log(`No matching variant found for inventory_item_id: ${inventory_item_id}. Skipping.`);
      return res.status(200).send('OK (No variant found)');
    }

    const product = variant.product;
    
    // --- DIAGNOSTIC LOGGING IS RE-ENABLED ---
    console.log('--- START SHOPIFY PRODUCT DATA DUMP ---');
    console.log(JSON.stringify(product, null, 2));
    console.log('--- END SHOPIFY PRODUCT DATA DUMP ---');


    console.log(`Processing variant: ${product.title} - ${variant.title}`);

    // --- 3. CHECK OUR RULES (IS MONITORING ON? IS STOCK LOW?) ---
    const isMonitoringEnabled = product.inventoryMonitoringEnabled?.value === 'true';
    const alertThreshold = parseInt(product.inventoryAlertThreshold?.value, 10); // This line is likely failing

    // This block is just for logging the values our code sees.
    console.log('--- Values as seen by the code ---');
    console.log(`isMonitoringEnabled: ${isMonitoringEnabled}`);
    console.log(`alertThreshold: ${alertThreshold}`);
    console.log(`available: ${available}`);
    console.log('---------------------------------');

    if (isMonitoringEnabled && available <= alertThreshold && !notifiedVariants.has(variant.id)) {
      console.log(`SUCCESS! ALERT TRIGGERED for ${variant.sku}.`);
      // Email sending is paused during this diagnostic test.
    } else {
      console.log(`No alert sent.`);
    }

    // --- 5. SEND A SUCCESS RESPONSE TO SHOPIFY ---
    res.status(200).send('OK');

  } catch (error) {
    console.error('An error occurred:', error.message, error.stack);
    res.status(500).send('An internal error occurred.');
  }
};
