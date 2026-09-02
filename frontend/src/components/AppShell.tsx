"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { signInWithGoogle, signOut } from "@/lib/session";

/**
 * Shell matching the approved prototype's sidebar visual language (brand
 * mark, nav group, dark-green sidebar). Two modules are built so far —
 * Inward Vehicle Inspection and Inward QC — matching the prototype's own
 * sidebar order and icon choice for each.
 */
const NAV_ITEMS = [
  {
    href: "/inward-vehicle-inspection",
    label: "Inward Vehicle Inspection",
    icon: (
      <path d="M3 16h1M20 16h1M5 16V9a2 2 0 012-2h6l4 4h2a1 1 0 011 1v4M5 16a2 2 0 104 0M15 16a2 2 0 104 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    ),
  },
  {
    href: "/inward-qc",
    label: "Inward QC",
    icon: (
      <path d="M9 12l2 2 4-4M5 5h14v14H5z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/rm-qr-generation",
    label: "RM QR Generation",
    icon: (
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM15 15h2v2h-2zM15 18h2v2h-2zM18 15h2v2h-2zM18 18h2v2h-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    ),
  },
  {
    href: "/rm-storage",
    label: "RM Storage",
    icon: (
      <path d="M3 9l9-5 9 5v9a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 9l9 5 9-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/material-consumption",
    label: "Material Consumption",
    icon: (
      <path d="M3 7h18M3 12h18M3 17h18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    ),
  },
  {
    href: "/production",
    label: "Production",
    icon: (
      <path d="M3 4h7v7H3zM14 4h7v7h-7zM3 15h7v7H3zM14 15h7v7h-7z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    ),
  },
  {
    href: "/fg-qr-generation",
    label: "FG QR Generation",
    icon: (
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM15 15h2v2h-2zM15 18h2v2h-2zM18 15h2v2h-2zM18 18h2v2h-2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    ),
  },
  {
    href: "/fg-storage",
    label: "FG Storage",
    icon: (
      <path d="M3 9l9-5 9 5v9a2 2 0 01-2 2H5a2 2 0 01-2-2zM3 9l9 5 9-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
];

const SETUP_NAV_ITEMS = [
  {
    href: "/vendors",
    label: "Vendors",
    icon: (
      <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 9h.01M15 9h.01M9 13h.01M15 13h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/skus",
    label: "SKU Names",
    icon: (
      <path d="M20.59 13.41L11 3.83A2 2 0 009.59 3.24L4 3a1 1 0 00-1 1l.24 5.59a2 2 0 00.58 1.41l9.59 9.59a2 2 0 002.83 0l4.35-4.35a2 2 0 000-2.83zM7 8a1 1 0 111-1 1 1 0 01-1 1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    ),
  },
  {
    href: "/machines",
    label: "Machines",
    icon: (
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    ),
  },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckedSession(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // Same signal useMe() already listens for, so switching users (or
      // signing in/out) still forces a fresh /me + permissions fetch.
      window.dispatchEvent(new Event("factory_os_user_changed"));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!checkedSession) {
    return <div className="auth-loading">Loading…</div>;
  }

  if (!session) {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <div className="sb-mark" style={{ margin: "0 auto 16px" }}>C</div>
          <h1>US Factory</h1>
          <div className="desc">Cirkla Manufacturing — sign in to continue</div>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => signInWithGoogle()}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sb-brand">
          <div className="sb-mark">C</div>
          <div className="sb-brand-text">
            <div className="name">US Factory</div>
            <div className="sub">Cirkla Manufacturing</div>
          </div>
        </div>
        <div className="sb-nav">
          <div className="sb-group">Records</div>
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className={`sb-item ${pathname?.startsWith(item.href) ? "active" : ""}`}>
              <svg viewBox="0 0 24 24" fill="none">{item.icon}</svg>
              <span className="label-text">{item.label}</span>
            </Link>
          ))}
          <div className="sb-group">Setup</div>
          {SETUP_NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} className={`sb-item ${pathname?.startsWith(item.href) ? "active" : ""}`}>
              <svg viewBox="0 0 24 24" fill="none">{item.icon}</svg>
              <span className="label-text">{item.label}</span>
            </Link>
          ))}
        </div>
        <div className="sb-foot">
          <div>Signed in as {session.user.email}</div>
          <div className="sb-role">
            <button className="btn-tertiary" onClick={() => signOut()}>Sign out</button>
          </div>
        </div>
      </div>
      <div className="main">
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
