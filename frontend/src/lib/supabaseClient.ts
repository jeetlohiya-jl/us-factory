import { createClient } from "@supabase/supabase-js";

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

export const supabase = createClient(url || "", anonKey || "");
