"use client";
/**
 * Capitals by default, everywhere: text typed into any text box or text
 * area becomes upper case as it is typed -- one listener for the whole app
 * (AppShell installs it), no per-field code, no requests.
 *
 * Left as typed: email / password / number / date / time / URL fields,
 * anything with an "@" placeholder, scan boxes (placeholder mentions Scan
 * or QR -- scanners type the QR's JSON), and any field marked
 * data-case="as-typed". Pasted text is capitalised the same way.
 *
 * React note: writing .value directly would update React's own value
 * tracker too, and React would then think nothing changed and skip
 * onChange. The prototype's native setter bypasses the tracker, so React
 * sees the change and state receives the capitalised text.
 */
const SKIP_TYPES = new Set(["email", "password", "number", "date", "datetime-local", "time", "month", "week", "url", "file", "checkbox", "radio", "range", "hidden", "color", "tel"]);

function shouldCapitalise(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && el.dataset.case !== "as-typed";
  if (!(el instanceof HTMLInputElement)) return false;
  if (SKIP_TYPES.has((el.type || "text").toLowerCase())) return false;
  if (el.readOnly || el.dataset.case === "as-typed") return false;
  if ((el.autocomplete || "").includes("email") || (el.placeholder || "").includes("@")) return false;
  // Scan boxes: a hardware scanner "types" the QR's JSON ({"t":"rm_pallet",
  // "id":...}) -- capitalising it would break it. Every scan box's
  // placeholder mentions Scan or QR.
  if (/\bscan\b|\bqr\b/i.test(el.placeholder || "") || el.dataset.scan !== undefined) return false;
  return true;
}

export function installDefaultCaps(): () => void {
  const onInput = (e: Event) => {
    if ((e as InputEvent).isComposing) return;
    const el = e.target;
    if (!shouldCapitalise(el)) return;
    const upper = el.value.toUpperCase();
    if (upper === el.value) return;
    const { selectionStart, selectionEnd } = el;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, upper);
    if (selectionStart != null && selectionEnd != null) {
      try { el.setSelectionRange(selectionStart, selectionEnd); } catch { /* some types don't support it */ }
    }
  };
  // Capture phase on document: runs before React's own (root) listener.
  document.addEventListener("input", onInput, true);
  return () => document.removeEventListener("input", onInput, true);
}
