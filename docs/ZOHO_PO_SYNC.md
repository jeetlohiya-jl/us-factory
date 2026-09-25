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

The Zoho webhook's **Default Payload** sends the whole purchase order, so the
sync needs **no Zoho API credentials** -- only a shared secret.

### 1. Run the migration
Supabase SQL Editor → run `backend/migrations/0054_zoho_po_sync.sql`.

### 2. Deploy the Edge Function
```
npx supabase login
npx supabase link --project-ref <project ref>
npx supabase secrets set ZOHO_WEBHOOK_SECRET=<long random string>
npx supabase functions deploy zoho-po-sync --no-verify-jwt
```
URL: `https://<project ref>.supabase.co/functions/v1/zoho-po-sync`

### 3. Zoho Books webhook + workflow rule
Zoho Books → Settings → **Automation → Webhooks → New Webhook**
- Module **Purchase Order**, Method **POST**, URL = the function URL above
- Header `x-zoho-webhook-secret` = the same ZOHO_WEBHOOK_SECRET
- Body: **Default Payload** (this carries the full PO -- required)

**Workflow Rules → New Rule**: module Purchase Orders, "Created or Edited",
no criteria, action = that webhook. Save and make sure it is **Active**.

Test: edit and save an Approved Gainesville PO in Zoho. It appears in
Factory → Goods Receipt within seconds. Each call is logged in one line in
Supabase → Edge Functions → zoho-po-sync → **Logs** (PO number, status,
location, lines, and what happened -- created / updated / ignored + reason).

### 4. Optional: daily catch-up via the Zoho API
Only needed to re-sync POs whose webhook Zoho failed to deliver. This part
does need Zoho API credentials, created by a Zoho user who is a member of
the Books organization:
- api-console.zoho.com (signed in as that user) → **Self Client** → Client
  ID + Secret; **Generate Code** with scope `ZohoBooks.purchaseorders.READ`;
  exchange it at `https://accounts.zoho.com/oauth/v2/token?grant_type=authorization_code&client_id=…&client_secret=…&code=…`
  for a refresh token.
- `npx supabase secrets set ZOHO_CLIENT_ID=… ZOHO_CLIENT_SECRET=… ZOHO_REFRESH_TOKEN=… ZOHO_ORGANIZATION_ID=<org id from the Books URL>`
- Schedule it (SQL Editor, `pg_cron` + `pg_net`):
```sql
select cron.schedule('zoho-po-sync-daily', '0 2 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/zoho-po-sync?mode=reconcile&days=3',
    headers := jsonb_build_object('x-zoho-webhook-secret', '<ZOHO_WEBHOOK_SECRET>')
  );
$$);
```

## Before the first sync
In Factory → Setup: the **vendor** (e.g. MIDA, with its country — it sets the
pallet QR prefix) and every **SKU** with its **SKU Code** (e.g. 3P = CMP0003P) and
version. A line whose SKU isn't set up is skipped and listed in the receipt's
sync notes.
