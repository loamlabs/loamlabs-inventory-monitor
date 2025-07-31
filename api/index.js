// Import the necessary tools (libraries)
const shopifyApi = require('@shopify/shopify-api');
require('@shopify/shopify-api/adapters/node'); // This line tells Shopify's library it's running in a Node.js environment
const { Resend } = require('resend');
const crypto = require('crypto');

// --- CONFIGURATION ---
// Get our secret keys from the Vercel Environment Variables
const {
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_API_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  RESEND_API_KEY,
} = process.env;

// Initialize the Shopify API client
const shopify = shopifyApi.shopifyApi({
  apiSecretKey: 'not-used-for-admin-token', // Not needed for Admin API token auth
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
    const rawBody = await readRawBody(req); // Use our new helper function
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

    // Now we can safely use the data
    const payload = JSON.parse(rawBody);
    const { inventory_item_id, available } = payload;
    
    if (!inventory_item_id) {
        console.log("Webhook payload is not an inventory level update. Skipping.");
        return res.status(200).send('OK (Not an inventory update)');
    }

    // --- 2. GET PRODUCT DETAILS FROM SHOPIFY USING THE INVENTORY ITEM ID ---
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
    console.log(`Processing variant: ${product.title} - ${variant.title}`);

    // --- 3. CHECK OUR RULES (IS MONITORING ON? IS STOCK LOW?) ---
    const isMonitoringEnabled = product.inventoryMonitoringEnabled?.value === true;
    const alertThreshold = parseInt(product.inventoryAlertThreshold?.value, 10);

    // If stock is now *above* the threshold, remove it from our spam-prevention list
    if (available > alertThreshold) {
      notifiedVariants.delete(variant.id);
      console.log(`Stock for ${variant.sku} is healthy (${available}). Reset notification flag.`);
    }

    // THE CORE LOGIC: Send an alert if monitoring is on, stock is below threshold, AND we haven't already sent an alert.
    if (isMonitoringEnabled && available <= alertThreshold && !notifiedVariants.has(variant.id)) {
      console.log(`ALERT TRIGGERED for ${variant.sku}. Quantity: ${available}, Threshold: ${alertThreshold}.`);

      // --- 4. SEND THE EMAIL ALERT ---
      await resend.emails.send({
        from: 'LoamLabs Alerts <alerts@loamlabsusa.com>',
        to: 'builds@loamlabsusa.com',
        subject: `LOW STOCK ALERT: ${product.title} (${variant.title})`,
        html: `
          <h1>Low Stock Alert</h1>
          <p>This is an automated alert. The following spoke variant has fallen below its defined threshold.</p>
          <ul>
            <li><strong>Product:</strong> ${product.title}</li>
            <li><strong>Variant / Length:</strong> ${variant.title}</li>
            <li><strong>SKU:</strong> ${variant.sku}</li>
            <li><strong>Current Quantity:</strong> <strong>${available}</strong></li>
            <li><strong>Alert Threshold:</strong> ${alertThreshold}</li>
          </ul>
          <p>Please consider reordering soon.</p>
        `,
      });

      console.log('Email alert sent successfully.');
      notifiedVariants.add(variant.id);

    } else {
      console.log(`No alert sent for ${variant.sku}. Monitoring: ${isMonitoringEnabled}, Available: ${available}, Notified Already: ${notifiedVariants.has(variant.id)}`);
    }

    // --- 5. SEND A SUCCESS RESPONSE TO SHOPIFY ---
    res.status(200).send('OK');

  } catch (error) {
    console.error('An error occurred:', error.message, error.stack);
    res.status(500).send('An internal error occurred.');
  }
};
