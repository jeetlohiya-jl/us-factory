// Supabase Edge Function: zoho-po-sync
//
// Zoho Books -> Factory Goods Receipt. Zoho Books calls this (a Workflow
// Rule webhook on Purchase Orders) whenever a PO is created or edited. The
// function fetches the full PO from the Zoho Books API and hands it to the
// database function zoho_upsert_purchase_order (migration 0054), which
// decides everything: only Approved POs delivered to Gainesville Factory,
// only SKU lines (freight skipped), Shipment Number from "Container:",
// trays converted to pallets, idempotent create/update, inwarded
// containers never changed, cancellations flagged.
//
//   POST /zoho-po-sync            <- Zoho webhook; body carries purchaseorder_id
//   POST /zoho-po-sync?mode=reconcile&days=3
//                                 <- catch-up: re-syncs every PO modified in
//                                    the last N days (schedule it daily)
//
// Every call must carry the shared secret: header "x-zoho-webhook-secret"
// or query "?secret=". Deploy with JWT verification off (Zoho doesn't send a
// Supabase JWT):  supabase functions deploy zoho-po-sync --no-verify-jwt
//
// Secrets (supabase secrets set ...):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN  (Zoho OAuth, scope ZohoBooks.purchaseorders.READ)
//   ZOHO_ORGANIZATION_ID
//   ZOHO_API_DOMAIN       default https://www.zohoapis.com   (.in / .eu / .com.au for other data centres)
//   ZOHO_ACCOUNTS_DOMAIN  default https://accounts.zoho.com
//   ZOHO_WEBHOOK_SECRET   any long random string, also put in the Zoho webhook
//   GAINESVILLE_MATCH     default "gainesville factory" (text identifying the delivery location)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

export type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

let cachedToken: { token: string; expires: number } | null = null;

async function zohoToken(env: Env, f: Fetch): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const accounts = env.ZOHO_ACCOUNTS_DOMAIN || "https://accounts.zoho.com";
  const params = new URLSearchParams({
    refresh_token: env.ZOHO_REFRESH_TOKEN || "",
    client_id: env.ZOHO_CLIENT_ID || "",
    client_secret: env.ZOHO_CLIENT_SECRET || "",
    grant_type: "refresh_token",
  });
  const r = await f(`${accounts}/oauth/v2/token?${params}`, { method: "POST" });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(j)}`);
  cachedToken = { token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return j.access_token;
}

async function zohoGet(env: Env, f: Fetch, path: string, query: Record<string, string> = {}): Promise<any> {
  const api = env.ZOHO_API_DOMAIN || "https://www.zohoapis.com";
  const qs = new URLSearchParams({ organization_id: env.ZOHO_ORGANIZATION_ID || "", ...query });
  const r = await f(`${api}/books/v3/${path}?${qs}`, {
    headers: { Authorization: `Zoho-oauthtoken ${await zohoToken(env, f)}` },
  });
  const j = await r.json();
  if (!r.ok || (j.code !== undefined && j.code !== 0)) throw new Error(`Zoho GET ${path} failed: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function upsert(env: Env, f: Fetch, po: unknown): Promise<any> {
  const r = await f(`${env.SUPABASE_URL}/rest/v1/rpc/zoho_upsert_purchase_order`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY || "",
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      "x-product": "factory",
    },
    body: JSON.stringify({ _po: po, _delivery_match: env.GAINESVILLE_MATCH || "gainesville factory" }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Goods Receipt sync failed: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

async function syncOne(env: Env, f: Fetch, purchaseorderId: string) {
  const { purchaseorder } = await zohoGet(env, f, `purchaseorders/${encodeURIComponent(purchaseorderId)}`);
  return { purchaseorder_id: purchaseorderId, purchaseorder_number: purchaseorder?.purchaseorder_number, ...(await upsert(env, f, purchaseorder)) };
}

/** purchaseorder_id from whatever shape the Zoho webhook sends (JSON or form). */
async function readPurchaseOrderId(req: Request): Promise<string | null> {
  const text = await req.text();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    const id = j.purchaseorder_id ?? j.purchaseorder?.purchaseorder_id ?? j.data?.purchaseorder_id;
    if (id) return String(id);
    if (typeof j.JSONString === "string") {
      const inner = JSON.parse(j.JSONString);
      return String(inner.purchaseorder_id ?? inner.purchaseorder?.purchaseorder_id ?? "") || null;
    }
  } catch { /* not JSON -> form below */ }
  const form = new URLSearchParams(text);
  const id = form.get("purchaseorder_id");
  if (id) return id;
  const js = form.get("JSONString");
  if (js) {
    try { const inner = JSON.parse(js); return String(inner.purchaseorder_id ?? inner.purchaseorder?.purchaseorder_id ?? "") || null; } catch { /* ignore */ }
  }
  return null;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function handle(req: Request, env: Env, f: Fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const secret = req.headers.get("x-zoho-webhook-secret") || url.searchParams.get("secret");
  if (!env.ZOHO_WEBHOOK_SECRET || secret !== env.ZOHO_WEBHOOK_SECRET) return json(401, { error: "unauthorized" });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  try {
    if (url.searchParams.get("mode") === "reconcile") {
      // Catch-up for any webhook Zoho failed to deliver: every PO modified in
      // the last N days, newest first. The database decides what to keep.
      const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 3, 1), 60);
      const cutoff = Date.now() - days * 86_400_000;
      const results: unknown[] = [];
      for (let page = 1; page <= 20; page++) {
        const list = await zohoGet(env, f, "purchaseorders", {
          sort_column: "last_modified_time", sort_order: "D", page: String(page), per_page: "200",
        });
        const pos: any[] = list.purchaseorders || [];
        let reachedOld = false;
        for (const p of pos) {
          const modified = Date.parse(p.last_modified_time || p.date || "");
          if (!Number.isNaN(modified) && modified < cutoff) { reachedOld = true; break; }
          results.push(await syncOne(env, f, String(p.purchaseorder_id)));
        }
        if (reachedOld || !list.page_context?.has_more_page) break;
      }
      return json(200, { mode: "reconcile", days, count: results.length, results });
    }

    const id = await readPurchaseOrderId(req);
    if (!id) return json(400, { error: "purchaseorder_id missing from webhook body" });
    return json(200, await syncOne(env, f, id));
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) {
  D.serve((req: Request) => handle(req, D.env.toObject()));
}
