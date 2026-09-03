"use client";
import { useEffect, useRef } from "react";

/**
 * Runs `fn` immediately on mount, then re-runs it `delayMs` after any
 * subsequent change to `deps` (debounced) -- e.g. search-as-you-type
 * filters.
 *
 * Every list page previously did `useEffect(() => setTimeout(fn, 250), deps)`,
 * which adds the same 250ms of pure artificial delay before the FIRST load
 * too -- i.e. on every navigation to the page, including revisiting a module
 * that was already open a moment ago. That's dead time with no purpose (the
 * debounce only exists to avoid firing one request per keystroke while
 * typing a search term); this hook keeps the debounce for actual deps
 * changes but skips it for the initial mount.
 */
export function useImmediateThenDebounced(fn: () => void, deps: unknown[], delayMs = 250) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      fn();
      return;
    }
    const t = setTimeout(fn, delayMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
