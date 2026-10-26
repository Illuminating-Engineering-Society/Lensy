-- Migration: 0024_purchases
--
-- Webstore purchases that grant Lighting Library access (Teams, 2026-10-26:
-- "the purchase in SureCart just triggers the update in Vitrium"). One row per
-- SureCart PURCHASE — SureCart's unit of entitlement: one line of one order,
-- carrying the product, the price, the customer and (for a recurring product)
-- the subscription. `surecart_purchase_id` is the idempotency key: the same
-- webhook delivered twice, or a staff resync, lands on the same row.
--
-- The access itself lives in AuthIES (comp_grants, source = 'surecart',
-- source_ref = 'surecart-<surecart_purchase_id>'); this table is Lens's
-- record of what each purchase mapped to and whether AuthIES took it, the
-- same contract comp_access_grants keeps for staff comps (migration 0023).
--
--   kind    'lease'        — one standard (standard_id) for 3 years
--           'subscription' — subscriber-level Library + full IES Lens for the
--                            SureCart billing period, extended on renewal
--           'unmapped'     — the product matched no standard and is not a
--                            listed subscription product: recorded, no grant
--   status  'active' | 'revoked' | 'ignored'
--           revoked_reason: 'surecart' (SureCart revoked it: refund, period
--           end), 'staff' (revoked in /admin), 'test_mode' (live_mode = 0 and
--           test purchases not accepted), 'unmapped'

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  surecart_purchase_id TEXT NOT NULL UNIQUE,
  surecart_order_id TEXT,
  surecart_order_number TEXT,
  surecart_customer_id TEXT,
  surecart_product_id TEXT,
  surecart_price_id TEXT,
  surecart_subscription_id TEXT,
  live_mode INTEGER NOT NULL DEFAULT 1,
  email TEXT NOT NULL,
  name TEXT,
  product_name TEXT,
  product_sku TEXT,
  product_slug TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('lease', 'subscription', 'unmapped')),
  standard_id TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'ignored')),
  revoked_reason TEXT,
  authies_applied_at TEXT,
  authies_error TEXT,
  notify_sent_at TEXT,
  notify_error TEXT,
  last_event_type TEXT,
  last_event_at TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The per-request tier check: "does this email hold a live purchased subscription?"
CREATE INDEX IF NOT EXISTS idx_purchases_email_kind_status ON purchases(email, kind, status);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);
-- subscription.* events name the subscription, not the purchase.
CREATE INDEX IF NOT EXISTS idx_purchases_subscription ON purchases(surecart_subscription_id);
