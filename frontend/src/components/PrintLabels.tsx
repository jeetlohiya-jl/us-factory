"use client";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Print-only QR labels, rendered directly under <body> (not inside the app's
 * layout). When printing, globals.css hides every other child of <body>
 * with display:none -- so nothing else takes up space and only the labels
 * print: exactly one 2in x 2in page per label, no trailing blank pages.
 * (The old approach hid the rest of the page with visibility:hidden, which
 * still reserved its full height and printed it as blank pages.)
 */
export default function PrintLabels({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(<div className="print-only">{children}</div>, document.body);
}
