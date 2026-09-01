"use client";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

/**
 * Real Supabase Auth session (Google OAuth) -- replaces the old dev
 * stand-in that sent a fake "dev:<email>" bearer token trusted with no
 * password check. The backend's SupabaseAuthAdapter (already written,
 * app/adapters/auth/supabase_adapter.py) validates the real JWT this
 * produces and looks the signed-in email up in app_users, same as before.
 *
 * Signing in with an email that has no row in app_users (or an inactive
 * one) still gets a real Supabase session, but every API call will come
 * back 401 -- that's the backend correctly refusing an unrecognized user,
 * not a bug here.
 */

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function getAuthHeader(): Promise<string> {
  const session = await getSession();
  return session ? `Bearer ${session.access_token}` : "";
}

export async function signInWithGoogle() {
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: typeof window !== "undefined" ? window.location.origin : undefined },
  });
}

export async function signOut() {
  await supabase.auth.signOut();
}
