import { Redis } from '@upstash/redis';
import { Resend } from 'resend';
import { createHmac } from 'crypto';

// This config tells Vercel to NOT parse the request body, giving us the raw stream.
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper function to read the raw body from the request stream
async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const getVariantDataByInventoryItemId = async (inventoryItemId) => {
  const query = `
    query getVariantByInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        variant {
          id
          title
          product {
            title
            handle
            onlineStoreUrl
          }
        }
      }
    }
  `;
  const variables = { id: `gid://shopify/InventoryItem/${inventoryItemId}` };

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
  return jsonResponse.data?.inventoryItem?.variant;
};

export default async function handler(req, res) {
  let rawBody;
  try {
    const buf = await buffer(req);
    rawBody = buf.toString('utf8');
    
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const hash = createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(rawBody, 'utf8')
      .digest('base64');
    
    if (hmac !== hash) {
      console.warn('Webhook verification failed.');
      return res.status(401).send('Unauthorized');
    }
  } catch (error) {
    console.error('Error verifying webhook:', error);
    return res.status(400).send('Invalid webhook payload');
  }

  try {
    // --- FIX STARTS HERE ---
    // Log the raw body for debugging purposes.
    console.log('Received raw webhook body:', rawBody);

    // Defensive check: If rawBody is empty, exit gracefully.
    if (!rawBody) {
        console.log('Webhook received with empty body. Exiting.');
        return res.status(200).json({ message: 'Empty body, no action taken.' });
    }
    
    const body = JSON.parse(rawBody);

    // Defensive check: Ensure body and required properties exist.
    if (!body || !body.inventory_item_id) {
        console.log('Webhook body is missing inventory_item_id. Exiting.', body);
        return res.status(200).json({ message: 'Payload missing required fields, no action taken.' });
    }
    // --- FIX ENDS HERE ---

    const { inventory_item_id, available } = body;

    if (!available || available <= 0) {
      return res.status(200).json({ message: 'No action needed for out-of-stock item.' });
    }

    const variant = await getVariantDataByInventoryItemId(inventory_item_id);
    if (!variant) {
      console.log(`No variant found for inventory item ID ${inventory_item_id}`);
      return res.status(200).json({ message: 'Variant not found.' });
    }

    const variantGid = variant.id;
    const variantId = variantGid.split('/').pop();
    const redisKey = `stock_notification_requests:${variantId}`;

    const emails = await redis.lrange(redisKey, 0, -1);
    if (emails.length === 0) {
      return res.status(200).json({ message: `No notification requests for variant ${variantId}.` });
    }

    const uniqueEmails = [...new Set(emails)]; 
    
    const emailPromises = uniqueEmails.map(email => 
      resend.emails.send({
        from: 'LoamLabs Support <notify@loamlabsusa.com>',
        to: email,
        subject: `✅ Back in Stock: ${variant.product.title}`,
        html: `...`, // Your email HTML here
      })
    );

    await Promise.all(emailPromises);
    await redis.del(redisKey);

    return res.status(200).json({ success: true, message: `Sent ${uniqueEmails.length} notifications.` });

  } catch (error) {
    console.error('Error in /api/handle-inventory-update:', error);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
}
