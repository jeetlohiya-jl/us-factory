import { createClient } from "@supabase/supabase-js";
import { getCurrentProduct } from "./currentProduct";

/**
 * Real Supabase Auth client (Google OAuth). Requires NEXT_PUBLIC_SUPABASE_URL
 * and NEXT_PUBLIC_SUPABASE_ANON_KEY to be set (Supabase dashboard -> Settings
 * -> API -> Project URL / anon public key). This is a pure client-side setup
 * -- no server-side auth route is needed because signInWithOAuth's redirect
 * flow is handled entirely by this SDK in the browser (detectSessionInUrl,
 * on by default), which is enough for this app since the Next.js frontend
 * only ever talks to Supabase for auth and to the FastAPI backend for data.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loudly at build/runtime rather than silently sending unauthenticated
  // requests -- a missing env var here means every API call would 401.
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
      "Sign-in will not work until these are configured."
  );
}

// Every Supabase request carries which product (Factory / US Factory) it
// comes from, so RLS / RPC permission checks (app_can, migration 0047) use
// that product's own permissions.
function productAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const product = getCurrentProduct();
  if (!product) return fetch(input, init);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
  headers.set("x-product", product);
  return fetch(input, { ...init, headers });
}

export const supabase = createClient(url || "", anonKey || "", { global: { fetch: productAwareFetch } });
