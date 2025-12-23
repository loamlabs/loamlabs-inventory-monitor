# LoamLabs Inventory Monitor

**Multi-function inventory management system providing real-time stock synchronization, low-stock alerts, and customer back-in-stock notifications.**

## Overview

This serverless application automates three critical inventory operations: 
1. **Inventory Mirroring:** Links the stock of identical physical items sold as separate Shopify products.
2. **Back-in-Stock Notifications:** Automatically emails customers when waitlisted items return to stock.
3. **Low-Stock Intelligence:** Monitors spoke inventory and tracks historical demand.

## Key Features

### 1. Automated Inventory Mirroring (New)
- **Problem Solved**: Manages inventory for identical components sold under different product handles (e.g., a Hub sold as "15x110" and "20x110" that shares the same physical shell and end caps).
- **Mechanism**: Uses a `custom.inventory_sync_key` variant metafield. When one variant changes, the system instantly updates all "sibling" variants with the same key.
- **Logic**: Uses a **"Broad Search, Strict Filter"** strategy (searching by Product Title, filtering by Metafield) to bypass Shopify's search indexing latency, ensuring immediate sync.

### 2. Back-in-Stock Notification System
- **Customer Request Collection**: API endpoint captures customer email and variant ID from product page forms.
- **Automated Notifications**: Webhook-driven system (`inventory_levels/update`) automatically emails customers when items return to stock.
- **Professional Email Design**: HTML-formatted notifications with product images, variant details, and direct purchase links.
- **One-Time Notification**: Automatically purges customer from the notification list after the email is sent to prevent spam.

### 3. Low-Stock Alert System
- **Event-Driven**: Triggered by Shopify `orders/create` and `orders/cancelled` webhooks.
- **Intelligent Reporting**: Uses Redis (Upstash) for short-term memory to send cumulative reports only when low-stock item list changes.
- **Spoke-Focused**: Monitors spoke product inventory levels across 100+ length variants.
- **Historical Tracking**: Increments/decrements `custom.historical_order_count` variant metafield for demand analytics.

## Technical Architecture

### Core Technologies
- **Runtime**: Node.js (Vercel Serverless Functions)
- **APIs**: 
  - **Shopify Admin API (GraphQL)**: For searching siblings, adjusting inventory quantities, and updating metafields.
  - **Shopify Storefront API**: For fetching public-facing variant data for emails.
- **Database**: Upstash Redis (Customer email lists, low-stock state snapshots).
- **Email Service**: Resend.
- **Security**: HMAC signature verification for all incoming webhooks.

### API Endpoints
- POST /api/request-notification.js # Receives customer email + variant ID. Stores in Redis.
- POST /api/handle-inventory-update.js # Triggered by inventory_levels/update. Handles SYNC and NOTIFY.
- POST /api/index.js # Triggered by orders/create & cancelled. Handles LOW STOCK alerts.

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
