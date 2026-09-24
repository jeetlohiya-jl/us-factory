# Zoho Books → Factory Goods Receipt

Every Zoho Books Purchase Order that is **Approved** and delivered to **Gainesville
Factory** appears automatically in Factory → Goods Receipt, filled in:

| Goods Receipt | From the Zoho PO |
|---|---|
| PO Number | `purchaseorder_number` |
| Vendor | Zoho vendor → the Factory vendor with that name (e.g. "MIDA" in "TaiShan MIDA Eco-Friendly…"), remembered by its Zoho vendor ID |
| One container row per SKU line | freight and every other line that isn't a SKU is skipped |
| Shipment Number | the line's `Container:` value (HA1, V6, …) |
| SKU / Version | item code `CMP0003P-P200` → SKU Code `CMP0003P` (else `Product: 3P` → SKU Name 3P); version = the SKU's only active version, else chosen in the app |
| PO Quantity | trays: pallets = trays ÷ `Trays/Combo Box` (rounded up); other materials: quantity + unit |
| Category | material SKUs: their material. Trays: left blank → **Base Tray / FNP Tray is chosen when the container is inwarded** |

PO edited in Zoho → not-yet-inwarded containers update; inwarded containers never change.
Line removed → its pending row is removed. PO cancelled → the receipt is flagged
"Cancelled in Zoho" and can't be inwarded (never deleted). Re-sends never duplicate.

## One-time setup

### 1. Run the migration
Supabase SQL Editor → run `backend/migrations/0054_zoho_po_sync.sql`.

### 2. Zoho OAuth credentials (Zoho API Console)
1. https://api-console.zoho.com → **Add Client → Self Client**.
2. **Generate Code**, scope `ZohoBooks.purchaseorders.READ`, duration 10 minutes.
3. Exchange it for a refresh token (replace the three values; use `accounts.zoho.in`
   etc. if your Zoho account is in another data centre):
   ```
   curl -X POST "https://accounts.zoho.com/oauth/v2/token?grant_type=authorization_code&client_id=CLIENT_ID&client_secret=CLIENT_SECRET&code=CODE"
   ```
   Keep the `refresh_token` from the response.
4. Zoho Books → Settings → **Organization Profile** → copy the Organization ID.

### 3. Deploy the Edge Function
```
supabase link --project-ref <factory-prod project ref>
supabase secrets set ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_REFRESH_TOKEN=... \
  ZOHO_ORGANIZATION_ID=... ZOHO_WEBHOOK_SECRET=<long random string>
# only if your Zoho data centre isn't .com:
# supabase secrets set ZOHO_API_DOMAIN=https://www.zohoapis.in ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.in
supabase functions deploy zoho-po-sync --no-verify-jwt
```
URL: `https://<project-ref>.supabase.co/functions/v1/zoho-po-sync`

### 4. Zoho Books workflow rule
Zoho Books → Settings → **Automation → Workflow Rules → New Rule**
- Module **Purchase Orders**, "When a Purchase Order is **Created or Edited**".
- Criteria: **Status is Approved** *(optional; the function also checks status
  and Gainesville Factory itself, and must also receive later edits/cancellations
  of already-synced POs — so leaving the criteria empty is safest)*.
- Action → **Webhook**: Method **POST**, URL = the function URL above,
  - Header `x-zoho-webhook-secret` = the same ZOHO_WEBHOOK_SECRET
  - Body: **JSON**, `{"purchaseorder_id": "${purchaseorder.purchaseorder_id}"}`
    (the function fetches the full PO itself; form-encoded and Zoho's
    "Entity Parameters / JSONString" formats also work).

### 5. Daily catch-up (recommended)
Re-syncs every PO modified in the last 3 days, in case a webhook was missed.
Supabase SQL Editor (needs the `pg_cron` and `pg_net` extensions enabled):
```sql
select cron.schedule('zoho-po-sync-daily', '0 2 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/zoho-po-sync?mode=reconcile&days=3',
    headers := jsonb_build_object('x-zoho-webhook-secret', '<ZOHO_WEBHOOK_SECRET>')
  );
$$);
```
Also useful once after setup, to import recent approved POs: call the same URL
with `days=30`.

## Before the first sync
In Factory → Setup: the **vendor** (e.g. MIDA, with its country — it sets the
pallet QR prefix) and every **SKU** with its **SKU Code** (e.g. 3P = CMP0003P) and
version. A line whose SKU isn't set up is skipped and listed in the receipt's
sync notes.
