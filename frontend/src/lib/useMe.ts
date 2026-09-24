"use client";
import { useEffect, useMemo, useState } from "react";
import { useProduct } from "./productContext";
import { permissionsForProduct } from "./currentProduct";
import { currentBootstrap, subscribeBootstrap } from "./bootstrap";
import type { MeResponse } from "@/lib/types";

/**
 * The signed-in person's user + permissions. Comes from the single startup
 * call AppShell makes (lib/bootstrap.ts, app_bootstrap) -- never a request
 * of its own, so no screen or navigation re-fetches it.
 */
export function refreshMe() {
  window.dispatchEvent(new Event("factory_os_user_changed"));
}

export function useMe(): MeResponse | null {
  const [me, setMe] = useState<MeResponse | null>(() => currentBootstrap()?.me ?? null);
  // Inside Factory, shared screens reading e.g. permissions.rm_storage get
  // the person's Factory permission instead (lib/currentProduct.ts).
  const product = useProduct();

  useEffect(() => {
    setMe(currentBootstrap()?.me ?? null);
    return subscribeBootstrap((b) => setMe(b?.me ?? null));
  }, []);

  return useMemo(
    () => (me && product === "factory" ? { ...me, permissions: permissionsForProduct(me.permissions, product) } : me),
    [me, product]
  );
}
