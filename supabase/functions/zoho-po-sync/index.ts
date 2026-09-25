// Supabase Edge Function: zoho-po-sync
//
// Zoho Books -> Factory Goods Receipt. Zoho Books calls this (a Workflow
// Rule webhook on Purchase Orders) whenever a PO is created or edited.
//
// The webhook's "Default Payload" already carries the WHOLE purchase order
// (header, status, delivery location, every line), so the function uses it
// as sent -- no Zoho API credentials needed. Only when a webhook sends just
// an id does it fetch the PO from the Zoho Books API, and only if API
// credentials are configured. Either way the PO goes to the database
// function zoho_upsert_purchase_order (migration 0054), which
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
//   ZOHO_WEBHOOK_SECRET   required -- the shared secret (header on the Zoho webhook)
//   Only for ?mode=reconcile or id-only webhooks (optional):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN  (Zoho OAuth, scope ZohoBooks.purchaseorders.READ)
//   ZOHO_ORGANIZATION_ID
//   ZOHO_API_DOMAIN       default https://www.zohoapis.com   (.in / .eu / .com.au for other data centres)
//   ZOHO_ACCOUNTS_DOMAIN  default https://accounts.zoho.com
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

async function syncPo(env: Env, f: Fetch, po: any, source: string) {
  const match = env.GAINESVILLE_MATCH || "gainesville factory";
  const result = await upsert(env, f, normaliseDelivery(po, match));
  // One line per sync in Supabase -> Edge Functions -> zoho-po-sync -> Logs.
  console.log(JSON.stringify({
    source, purchaseorder_number: po?.purchaseorder_number, status: po?.status,
    location: po?.location_name ?? po?.warehouse_name ?? null, lines: po?.line_items?.length ?? 0,
    action: result?.action, reason: result?.reason ?? null,
  }));
  return { purchaseorder_id: po?.purchaseorder_id, purchaseorder_number: po?.purchaseorder_number, ...result };
}

async function syncOne(env: Env, f: Fetch, purchaseorderId: string) {
  const { purchaseorder } = await zohoGet(env, f, `purchaseorders/${encodeURIComponent(purchaseorderId)}`);
  return syncPo(env, f, purchaseorder, "zoho-api");
}

/** What a Zoho webhook sent: the full purchase order (Default Payload,
 * `payload=${JSONString}`, `JSONString=...`) and/or just its id. */
type Webhook = { po: any | null; id: string | null; shape: string };

function pickPo(j: any): any | null {
  if (!j || typeof j !== "object") return null;
  const cands = [j.purchaseorder, j.data?.purchaseorder, j];
  for (const c of cands) if (c && typeof c === "object" && c.purchaseorder_id && Array.isArray(c.line_items)) return c;
  return null;
}
function pickId(j: any): string | null {
  const id = j?.purchaseorder?.purchaseorder_id ?? j?.purchaseorder_id ?? j?.data?.purchaseorder_id;
  return id ? String(id) : null;
}
/** Escape raw control characters (line breaks, tabs) INSIDE JSON strings.
 * Zoho can send multi-line fields (a PO line's description: "Product: 3P
 * <newline> Container: HA1 ...") unescaped, which strict JSON.parse
 * rejects. Outside strings they are just whitespace and are left alone. */
function escapeRawControlChars(t: string): string {
  let out = "", inStr = false, esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      const c = ch.charCodeAt(0);
      if (c < 0x20) { out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : "\\u" + c.toString(16).padStart(4, "0"); continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function parseMaybe(t: string | null | undefined): any | null {
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* try the lenient form below */ }
  try { return JSON.parse(escapeRawControlChars(t)); } catch { return null; }
}

export async function readWebhook(req: Request): Promise<Webhook> {
  const text = await req.text();
  // What Zoho actually sent -- visible in Supabase -> Edge Functions -> Logs.
  console.log(JSON.stringify({
    received: { content_type: req.headers.get("content-type"), length: text.length,
      form_fields: (() => { try { return [...new URLSearchParams(text).keys()].slice(0, 10); } catch { return []; } })(),
      start: text.slice(0, 300) },
  }));
  if (!text) return { po: null, id: null, shape: "empty" };
  const j = parseMaybe(text);
  if (j) {
    const inner = typeof j.JSONString === "string" ? parseMaybe(j.JSONString) : typeof j.payload === "string" ? parseMaybe(j.payload) : null;
    const src = inner ?? j;
    return { po: pickPo(src), id: pickId(src), shape: inner ? "json+JSONString" : "json" };
  }
  // Form-encoded: Zoho may name the field payload / JSONString /
  // purchaseorder / anything -- try every field's value as JSON.
  const form = new URLSearchParams(text);
  for (const [key, value] of form.entries()) {
    const inner = parseMaybe(value);
    if (inner) {
      const po = pickPo(inner) ?? pickPo({ purchaseorder: inner });
      if (po || pickId(inner)) return { po, id: pickId(inner) ?? po?.purchaseorder_id ?? null, shape: `form:${key}` };
    }
  }
  return { po: null, id: form.get("purchaseorder_id"), shape: "form" };
}

/** The database looks for the delivery location in the usual Zoho fields.
 * If Zoho put "Gainesville Factory" somewhere else in the PO (not the vendor,
 * billing address or lines), surface it where the database looks. */
function normaliseDelivery(po: any, match: string): any {
  const m = match.toLowerCase();
  const known = [po.location_name, po.warehouse_name, po.branch_name, po.delivery_address_name, JSON.stringify(po.delivery_address ?? "")]
    .join(" ").toLowerCase();
  if (known.includes(m)) return po;
  const { line_items: _l, vendor_name: _v, billing_address: _b, vendor_address: _va, ...rest } = po;
  if (JSON.stringify(rest).toLowerCase().includes(m)) return { ...po, delivery_address_name: match };
  return po;
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
      if (!env.ZOHO_REFRESH_TOKEN) return json(400, { error: "Catch-up needs the optional Zoho API secrets (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN / ZOHO_ORGANIZATION_ID)." });
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

    const hook = await readWebhook(req);
    // Normal case: Zoho sent the whole PO -- use it, no API call.
    if (hook.po) return json(200, await syncPo(env, f, hook.po, `webhook:${hook.shape}`));
    if (!hook.id) {
      console.log(JSON.stringify({ source: "webhook", error: "no purchase order in body", shape: hook.shape }));
      return json(400, { error: "The webhook body has no purchase order. In the Zoho webhook, choose Body = Default Payload." });
    }
    if (!env.ZOHO_REFRESH_TOKEN) {
      return json(400, {
        error: "The webhook sent only a purchaseorder_id. Choose Body = Default Payload in the Zoho webhook " +
          "(it sends the whole PO), or configure the optional Zoho API secrets.",
      });
    }
    return json(200, await syncOne(env, f, hook.id));
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : String(e) });
  }
}

// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) {
  D.serve((req: Request) => handle(req, D.env.toObject()));
}
