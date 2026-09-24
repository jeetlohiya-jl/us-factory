"use client";
import { supabase } from "./supabaseClient";
import type { MeResponse, PortfolioAccessMe } from "./types";

/**
 * Everything the app needs before it can draw anything -- which products the
 * person may open, and their user + permissions -- in ONE Supabase call
 * (app_bootstrap, migration 0050). It replaced three sequential calls to the
 * FastAPI server (/portfolio-access/me, then /me twice) that every open and
 * every reload waited on.
 *
 * The last result is also kept per person in localStorage, so reopening the
 * app draws the right screen immediately from it while a fresh copy loads
 * in the background (stale-while-revalidate). A permission change therefore
 * applies within one round trip of opening the app, exactly as before.
 */
export interface Bootstrap {
  portfolio: PortfolioAccessMe;
  me: MeResponse | null;
}

const cacheKey = (userId: string) => `fos:bootstrap:${userId}`;
let current: { userId: string; data: Bootstrap } | null = null;
let inFlight: { userId: string; promise: Promise<Bootstrap> } | null = null;
const subscribers = new Set<(b: Bootstrap | null) => void>();

export function readCachedBootstrap(userId: string): Bootstrap | null {
  if (current?.userId === userId) return current.data;
  try {
    const raw = window.localStorage.getItem(cacheKey(userId));
    return raw ? (JSON.parse(raw) as Bootstrap) : null;
  } catch {
    return null;
  }
}

export function currentBootstrap(): Bootstrap | null {
  return current?.data ?? null;
}

export function subscribeBootstrap(fn: (b: Bootstrap | null) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

/** One request per person at a time; `force` skips the in-memory copy. */
export function loadBootstrap(userId: string, force = false): Promise<Bootstrap> {
  if (!force && current?.userId === userId) return Promise.resolve(current.data);
  if (inFlight?.userId === userId) return inFlight.promise;
  const promise = (async () => {
    const { data, error } = await supabase.rpc("app_bootstrap");
    if (error) throw new Error(error.message);
    const b = data as Bootstrap;
    current = { userId, data: b };
    try { window.localStorage.setItem(cacheKey(userId), JSON.stringify(b)); } catch { /* storage full/blocked: memory copy still works */ }
    subscribers.forEach((fn) => fn(b));
    return b;
  })();
  inFlight = { userId, promise };
  promise.finally(() => { if (inFlight?.promise === promise) inFlight = null; }).catch(() => {});
  return promise;
}

/** Seed the in-memory copy from the stored one (instant first paint). */
export function primeBootstrap(userId: string, b: Bootstrap) {
  if (current?.userId !== userId) {
    current = { userId, data: b };
    subscribers.forEach((fn) => fn(b));
  }
}

export function clearBootstrap(userId?: string | null) {
  current = null;
  if (userId) { try { window.localStorage.removeItem(cacheKey(userId)); } catch { /* ignore */ } }
  subscribers.forEach((fn) => fn(null));
}

// ---------------------------------------------------------------------------
// Remembered product choice (Factory / US Factory), per person, so a reload
// or reopening the app returns to where they were instead of the picker.
// Cleared on sign-out and by the sidebar's "Switch".
// ---------------------------------------------------------------------------
const productKey = (userId: string) => `fos:product:${userId}`;

export function readRememberedProduct(userId: string): "factory" | "us_factory" | null {
  try {
    const v = window.localStorage.getItem(productKey(userId));
    return v === "factory" || v === "us_factory" ? v : null;
  } catch {
    return null;
  }
}

export function rememberProduct(userId: string, product: "factory" | "us_factory" | null) {
  try {
    if (product) window.localStorage.setItem(productKey(userId), product);
    else window.localStorage.removeItem(productKey(userId));
  } catch { /* ignore */ }
}
