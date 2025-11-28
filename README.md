# LoamLabs Inventory Monitor

Multi-function inventory management system providing low-stock alerts, back-in-stock customer notifications, and demand tracking.

## Overview

This serverless application handles three critical inventory operations: automated low-stock monitoring with intelligent reporting, customer notification system for out-of-stock items, and historical order volume tracking for demand forecasting.

## Key Features

### 1. Low-Stock Alert System
- **Event-Driven**: Triggered by Shopify `orders/create` and `orders/cancelled` webhooks
- **Intelligent Reporting**: Uses Redis (Upstash) for short-term memory to send cumulative reports only when low-stock item list changes
- **Spoke-Focused**: Monitors spoke product inventory levels across 100+ length variants
- **Historical Tracking**: Increments/decrements `custom.historical_order_count` variant metafield for demand analytics

### 2. Back-in-Stock Notification System
- **Customer Request Collection**: API endpoint captures customer email and variant ID from product page forms
- **Automated Notifications**: Webhook-driven system (`inventory_level/update` event) automatically emails customers when items return to stock
- **Professional Email Design**: HTML-formatted notifications with product images, variant details, and direct purchase links
- **One-Time Notification**: Automatically purges customer from notification list after email sent

### 3. Stock Request Intelligence
- **Real-Time Business Alerts**: Sends immediate notification to store owner when customer requests stock notification
- **Demand Visibility**: Provides insight into which out-of-stock items customers are actively seeking

## Technical Architecture

### Core Technologies
- **Runtime**: Node.js (Vercel Serverless Functions)
- **APIs**: 
  - Shopify Admin API (GraphQL for product/variant queries, REST for inventory)
  - Shopify Storefront API (for public-facing variant data in notifications)
- **Database**: Upstash Redis (customer email storage and low-stock state tracking)
- **Email Service**: Resend
- **Security**: HMAC signature verification for webhooks

### API Endpoints

```
POST /api/log-stock-request       # Collects customer notification requests
POST /api/notify-customers         # Triggered by inventory_level/update webhook
POST /api/low-stock-monitor        # Triggered by orders/create and orders/cancelled webhooks
```

### Back-in-Stock Workflow

1. **Customer Request**: User clicks "Notify Me When Available" button on product page
2. **Data Collection**: Frontend sends email + variant ID to `/api/log-stock-request`
3. **Storage**: Email stored in Redis list with key pattern `stock_notification_requests:{variantId}`
4. **Owner Alert**: Immediate email sent to store owner with customer details
5. **Inventory Update**: When item restocked, Shopify triggers `inventory_level/update` webhook
6. **Notification**: System queries Shopify Storefront API for variant details, sends professional HTML email to all subscribed customers
7. **Cleanup**: Redis key deleted to prevent duplicate notifications

### Low-Stock Monitoring Workflow

1. **Order Event**: New order or cancellation triggers webhook
2. **Inventory Scan**: Checks all spoke products for low-stock conditions
3. **State Comparison**: Compares current low-stock list against previous state in Redis
4. **Conditional Report**: Only sends email if low-stock item list has changed
5. **Metafield Update**: Increments/decrements historical order count for demand forecasting

## Data Storage (Redis)

### Key Patterns
- `stock_notification_requests:{variantId}` - List of customer emails awaiting restock
- `last_low_stock_report` - JSON snapshot of previous low-stock state

## Security

- Webhook HMAC signature verification
- CORS configuration for frontend API endpoints
- Environment-based secret management

## Environment Variables

Required environment variables (configured in Vercel):
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `SHOPIFY_STOREFRONT_ACCESS_TOKEN`
- `SHOPIFY_WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `RESEND_API_KEY`

## Permissions

Shopify app requires the following scopes:
- `read_products` - For fetching variant details
- `read_inventory` - For inventory level queries
- `write_inventory` - For historical count metafield updates

## Future Enhancements

- Predictive restocking recommendations based on historical order count data
- Customer preference for notification frequency (immediate vs. digest)
- Integration with supplier APIs for automated reorder triggers

## License

MIT License - See LICENSE file for details

---

**Built for LoamLabs inventory operations and customer engagement.**
