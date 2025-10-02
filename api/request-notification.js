import { Redis } from '@upstash/redis';
import { Resend } from 'resend';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  // Allow CORS from your Shopify store
  res.setHeader('Access-Control-Allow-Origin', 'https://loamlabsusa.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const { email, variantId, productTitle, variantTitle, productUrl } = req.body;

  if (!email || !variantId || !productTitle || !variantTitle || !productUrl) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  try {
    // 1. Send immediate notification to the owner
    await resend.emails.send({
      from: 'LoamLabs Notifier <notify@loamlabsusa.com>',
      to: process.env.OWNER_NOTIFICATION_EMAIL,
      subject: `📈 Stock Request: ${productTitle}`,
      html: `
        <p>A customer has requested to be notified about an out-of-stock item.</p>
        <ul>
          <li><strong>Customer Email:</strong> ${email}</li>
          <li><strong>Product:</strong> ${productTitle}</li>
          <li><strong>Variant:</strong> ${variantTitle}</li>
          <li><strong>Variant ID:</strong> ${variantId}</li>
          <li><strong>URL:</strong> <a href="${productUrl}">${productUrl}</a></li>
        </ul>
      `,
    });

    // 2. Store the customer's request in Redis
    const redisKey = `stock_notification_requests:${variantId}`;
    await redis.lpush(redisKey, email);

    return res.status(200).json({ success: true, message: 'Notification request saved.' });
  } catch (error) {
    console.error('Error in /api/request-notification:', error);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
}
