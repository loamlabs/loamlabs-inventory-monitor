import { Redis } from '@upstash/redis';
import { Resend } from 'resend';
import { createHmac } from 'crypto';

export const config = {
  api: {
    bodyParser: false,
  },
};

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
  // --- START: CORRECTED GRAPHQL QUERY ---
  // The invalid 'url' field has been removed.
  const query = `
    query getVariantByInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        variant {
          id
          title
          image {
            url(transform: {maxWidth: 200, maxHeight: 200, crop: CENTER})
          }
          product {
            title
            handle
            onlineStoreUrl # This is the correct way to get the base product URL
            featuredImage {
               url(transform: {maxWidth: 200, maxHeight: 200, crop: CENTER})
            }
          }
        }
      }
    }
  `;
  // --- END: CORRECTED GRAPHQL QUERY ---

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

  if (jsonResponse.errors) {
    console.error('Shopify GraphQL API returned errors:', JSON.stringify(jsonResponse.errors, null, 2));
  }
  
  return jsonResponse.data?.inventoryItem?.variant;
};

export default async function handler(req, res) {
  // Webhook verification logic remains unchanged...
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
    if (!rawBody) { return res.status(200).json({ message: 'Empty body, no action taken.' }); }
    const body = JSON.parse(rawBody);
    if (!body || !body.inventory_item_id) { return res.status(200).json({ message: 'Payload missing required fields.' }); }

    const { inventory_item_id, available } = body;

    if (!available || available <= 0) {
      return res.status(200).json({ message: 'No action needed for out-of-stock item.' });
    }

    const variant = await getVariantDataByInventoryItemId(inventory_item_id);

    if (!variant) {
      console.log(`No variant found for inventory item ID ${inventory_item_id}.`);
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
    
    const productTitle = variant.product.title;
    const variantTitle = variant.title;
    // --- START: CORRECTED URL CONSTRUCTION ---
    const productUrl = `${variant.product.onlineStoreUrl}?variant=${variantId}`;
    // --- END: CORRECTED URL CONSTRUCTION ---
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
    return res.status(200).json({ success: true, message: `Sent ${uniqueEmails.length} notifications.` });

  } catch (error) {
    console.error('Error in /api/handle-inventory-update:', error);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
}
