// This is a simplified conceptual example for api/index.js

// This function receives the webhook from Shopify
export default async function handler(request, response) {
    // 1. Verify the request is legitimate and came from Shopify
    // (This part uses the webhook signing secret)
    
    // 2. Get the inventory data from the webhook payload
    const { inventory_item_id, available } = request.body;

    // 3. Use the inventory_item_id to query Shopify for more details
    // This is a GraphQL query to the Shopify Admin API
    const shopifyResponse = await queryShopifyAPI(`
        query GetVariantAndProductMetafields($id: ID!) {
            inventoryItem(id: $id) {
                variant {
                    id
                    sku
                    title
                    product {
                        id
                        title
                        # Get the metafields we created
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
    `, { id: inventory_item_id });

    const product = shopifyResponse.data.inventoryItem.variant.product;
    const variant = shopifyResponse.data.inventoryItem.variant;
    
    // 4. Extract the metafield values
    const isMonitoringEnabled = product.inventoryMonitoringEnabled?.value === 'true';
    const alertThreshold = parseInt(product.inventoryAlertThreshold?.value, 10);

    // 5. The Core Logic: Check if we need to send an alert
    if (isMonitoringEnabled && available <= alertThreshold) {
        
        // --- IMPORTANT: SPAM PREVENTION LOGIC WOULD GO HERE ---
        // You need to check if you've ALREADY sent an alert for this
        // variant at this stock level to avoid sending 100 emails
        // if 100 spokes are sold. A simple cache or database can track this.
        
        console.log(`ALERT: ${product.title} - ${variant.title} (${variant.sku}) is low on stock! Quantity: ${available}`);

        // 6. Send the email alert using Resend
        await sendEmail({
            to: 'builds@loamlabsusa.com',
            subject: `LOW STOCK ALERT: ${product.title}`,
            html: `
                <h1>Low Stock Alert</h1>
                <p>The following spoke variant has fallen below its threshold of <strong>${alertThreshold}</strong>.</p>
                <ul>
                    <li><strong>Product:</strong> ${product.title}</li>
                    <li><strong>Variant/Length:</strong> ${variant.title}</li>
                    <li><strong>SKU:</strong> ${variant.sku}</li>
                    <li><strong>Current Quantity:</strong> ${available}</li>
                </ul>
                <p>Please reorder soon.</p>
            `
        });
        
        // After sending, you would update your spam-prevention cache
        
    } else {
        console.log(`No alert needed for ${product.title}. Monitoring: ${isMonitoringEnabled}, Available: ${available}`);
    }

    // 7. Send a success response back to Shopify
    response.status(200).send('OK');
}
