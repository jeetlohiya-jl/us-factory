"use client";
import type { QrLabel } from "./qrLabels";

/**
 * Hand labels to the Factory Print Android app (android/factory-print), which
 * prints them on the MakeID D50 with MakeID's SDK -- all in one job.
 *
 * Uses an Android "intent:" link: Chrome opens Factory Print with the labels
 * in the link (factoryprint://print?d=<base64url JSON>). If Factory Print
 * isn't installed, Chrome opens /factory-print.html (how to install it).
 * Nothing goes through a server.
 */
export const FACTORY_PRINT_PACKAGE = "com.cirkla.factoryprint";
export const FACTORY_PRINT_MAX_LABELS = 300;

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "");
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function factoryPrintUrl(labels: QrLabel[], source: string): string {
  const job = { v: 1, source, labels: labels.map((l) => ({ q: l.payload, t: l.text })) };
  const fallback = `${window.location.origin}/factory-print.html`;
  return `intent://print?d=${base64Url(JSON.stringify(job))}#Intent;scheme=factoryprint;package=${FACTORY_PRINT_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/** Opened by clicking a link (inside the button's tap) -- the way Chrome on
 * Android reliably hands "intent:" links to apps. */
export function openFactoryPrint(labels: QrLabel[], source: string): void {
  const a = document.createElement("a");
  a.href = factoryPrintUrl(labels.slice(0, FACTORY_PRINT_MAX_LABELS), source);
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
