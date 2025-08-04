// Import the necessary tools (libraries)
const crypto = require('crypto');

// Helper to read the request body
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => resolve(body));
    req.on('error', err => reject(err));
  });
}

// The main combined diagnostic function
module.exports = async (req, res) => {
  console.log('COMBINED DIAGNOSTIC MODE: Order creation webhook received.');

  // --- NEW DATABASE CREDENTIALS DEBUGGING ---
  console.log('--- Checking for Database Credentials (Password Issue) ---');
  console.log('Is UPSTASH_REDIS_REST_URL set?', !!process.env.UPSTASH_REDIS_REST_URL);
  console.log('Is UPSTASH_REDIS_REST_TOKEN set?', !!process.env.UPSTASH_REDIS_REST_TOKEN);
  console.log('---------------------------------------------------------');
  // --- END DATABASE DEBUGGING ---

  try {
    // 1. Verify the webhook is from Shopify
    const rawBody = await readRawBody(req);
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

    const generatedHash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(rawBody, 'utf-8').digest('base64');

    if (generatedHash !== hmac) {
      console.error('Webhook verification failed.');
      return res.status(401).send('Unauthorized');
    }
    console.log('Webhook verified successfully.');

    // 2. Log the entire order payload
    const orderPayload = JSON.parse(rawBody);

    console.log('--- STARTING RAW ORDER DATA DUMP (Product Type Issue) ---');
    console.log(JSON.stringify(orderPayload, null, 2)); 
    console.log('--- FINISHED RAW ORDER DATA DUMP ---');

    // 3. Specifically log the product_type of each line item
    console.log('--- CHECKING LINE ITEM PRODUCT TYPES ---');
    if (orderPayload.line_items && orderPayload.line_items.length > 0) {
        orderPayload.line_items.forEach((item, index) => {
            console.log(`Item ${index + 1}: Title = "${item.title}", Product Type = "${item.product_type}"`);
        });
    } else {
        console.log('No line items found in this order payload.');
    }
    console.log('--- FINISHED CHECKING LINE ITEM PRODUCT TYPES ---');

    res.status(200).send('OK (Diagnostic complete)');

  } catch (error) {
    console.error('An error occurred during diagnostic run:', error.message, error.stack);
    res.status(500).send('An internal error occurred.');
  }
};
