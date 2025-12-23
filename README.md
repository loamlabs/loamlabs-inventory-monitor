## Workflows

### Inventory Sync Workflow
1. **Trigger**: Admin or Customer changes stock level of a variant (e.g., "Hub A").
2. **Search**: System extracts the product title (e.g., "e*thirteen Sidekick") and performs a broad GraphQL search.
3. **Filter**: System filters results to find other variants with the exact same `custom.inventory_sync_key`.
4. **Action**: System calculates the difference and updates the sibling variants ("Hub B") to match the new quantity.

### Back-in-Stock Workflow
1. **Request**: User clicks "Notify Me" on a sold-out product. Data sent to `/api/request-notification`.
2. **Storage**: Email stored in Redis list: `stock_notification_requests:{variantId}`.
3. **Restock**: Inventory update triggers `/api/handle-inventory-update`.
4. **Notification**: System detects positive stock, fetches waiting emails, sends HTML notification via Resend, and clears the Redis key.

### Low-Stock Monitoring Workflow
1. **Order Event**: New order or cancellation triggers webhook.
2. **Inventory Scan**: Checks all spoke products for low-stock conditions.
3. **State Comparison**: Compares current low-stock list against previous state in Redis.
4. **Conditional Report**: Only sends email if low-stock item list has changed.
5. **Metafield Update**: Increments/decrements historical order count for demand forecasting.

## Configuration

### Environment Variables
Required environment variables (configured in Vercel):
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ADMIN_API_TOKEN`
- `SHOPIFY_WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RESEND_API_KEY`
- `OWNER_NOTIFICATION_EMAIL` (For admin alerts)

### Permissions
The Shopify App/Token requires the following access scopes:
- `read_products`: To find siblings and fetch variant details.
- `read_inventory`: To check current levels.
- `write_inventory`: **Critical** - To programmatically adjust stock levels for syncing.
- `write_products`: To update `historical_order_count` metafields.

## License

MIT License - See LICENSE file for details.

---

**Built for LoamLabs inventory operations.**
