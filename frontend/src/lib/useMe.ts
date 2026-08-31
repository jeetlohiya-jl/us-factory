"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { MeResponse } from "@/lib/types";

/**
 * Every page independently called `api.me()` on mount, so every single
 * navigation re-fetched the full user + permissions payload from scratch —
 * six routes, six redundant round trips for data that essentially never
 * changes mid-session. This hook fetches it once per app session (module
 * state survives client-side navigation, since Next.js App Router doesn't
 * reload the page) and every component just reads the cached value;
 * `refreshMe()` (wired to the existing "factory_os_user_changed" event,
 * fired by the dev user-switcher) is the only thing that forces a re-fetch.
 */
let cached: MeResponse | null = null;
let inFlight: Promise<MeResponse> | null = null;
const subscribers = new Set<(me: MeResponse | null) => void>();

function notify(me: MeResponse | null) {
  cached = me;
  subscribers.forEach((fn) => fn(me));
}

async function load(force: boolean): Promise<MeResponse | null> {
  if (cached && !force) return cached;
  if (inFlight && !force) return inFlight;
  inFlight = api.me();
  try {
    const me = await inFlight;
    notify(me);
    return me;
  } catch {
    notify(null);
    return null;
  } finally {
    inFlight = null;
  }
}

export function refreshMe() {
  load(true);
}

export function useMe(): MeResponse | null {
  const [me, setMe] = useState<MeResponse | null>(cached);

  useEffect(() => {
    subscribers.add(setMe);
    load(false).then(setMe);
    function onUserChanged() { load(true); }
    window.addEventListener("factory_os_user_changed", onUserChanged);
    return () => {
      subscribers.delete(setMe);
      window.removeEventListener("factory_os_user_changed", onUserChanged);
    };
  }, []);

  return me;
}
