"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { signInWithGoogle, signOut } from "@/lib/session";
import { useMe } from "@/lib/useMe";
import { api, ApiError } from "@/lib/api";
import type { PortfolioAccessMe } from "@/lib/types";

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
    href: "/ipqc",
    label: "IPQC",
    icon: (
      <path d="M9 12l2 2 4-4M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/rqc",
    label: "RQC",
    icon: (
      <path d="M9 12l2 2 4-4M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
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
  {
    href: "/customer-shipment",
    label: "Customer Shipment",
    icon: (
      <path d="M3 3h13l3 5v10a1 1 0 01-1 1H4a1 1 0 01-1-1zM16 8H3M8 12v6M13 12v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/shipment-picking",
    label: "Shipment Picking",
    icon: (
      <path d="M20 12V8a2 2 0 00-1-1.73l-6-3.46a2 2 0 00-2 0l-6 3.46A2 2 0 004 8v8a2 2 0 001 1.73l6 3.46a2 2 0 002 0l1.5-.87M16 17l2 2 4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/outward-vehicle-inspection",
    label: "Outward Vehicle Inspection",
    icon: (
      <path d="M3 16V8a1 1 0 011-1h9v9M3 16h1m0 0a2 2 0 104 0m-4 0h9m0 0a2 2 0 104 0m0 0h2a1 1 0 001-1v-3l-2-3h-5v7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/machine-downtime",
    label: "Machine Downtime",
    icon: (
      <path d="M12 8v4l3 2M12 21a9 9 0 100-18 9 9 0 000 18z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: "/traceability",
    label: "Traceability",
    icon: (
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
];

// Factory product's sidebar (see PORTFOLIO_ACCESS_NAV_ITEM above for how a
// signed-in email ends up here). Factory OS is planned as six modules;
// only Module 2 (Raw Material Consumption / RM -> WIP) is built so far, so
// only it gets a real nav item. It intentionally points at the exact same
// route/page/table as US Factory's own "Material Consumption" screen below
// (same Supabase project, same material_consumptions rows, same
// module_permissions scope) rather than a second copy -- Module 2 IS that
// feature, just also reachable from here, per the no-duplication mandate.
const FACTORY_NAV_ITEMS = [
  {
    href: "/material-consumption",
    label: "Raw Material Consumption",
    icon: (
      <path d="M3 7h18M3 12h18M3 17h18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    ),
  },
  // Module 3 -- Production (WIP -> Finished Goods). Points at the exact
  // same /production route/page/table US Factory's own sidebar uses (same
  // ProductionRun rows, same module_permissions scope) -- no second copy.
  // Production already auto-populates from Material Consumption (Module 2)
  // via material_consumption_service.find_or_create_production_run, already
  // exposes per-machine "Pallets Produced" columns, and already uses the
  // Machine/Shift master-data dropdowns -- Module 3's stated requirements
  // are satisfied by this one nav entry, same reuse pattern as Module 2.
  {
    href: "/production",
    label: "Production",
    icon: (
      <path d="M4 4h16v4H4zM4 10h10v10H4zM16 10h4v10h-4z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  // Module 4 -- RQC + FG QR Generation, combined into one module/page (per
  // the explicit "not two separate pages" requirement). This is a genuinely
  // new Factory-only page (frontend/src/app/rqc-fg-qr/page.tsx) -- unlike
  // Modules 2/3 it does not point at the existing /rqc or /fg-qr-generation
  // US Factory routes, since those are two separate pages with the old
  // 15-item defect list; it reuses the same rqc_records/qr_generation_records
  // tables and backend routes underneath (module_permissions scope "rqc"),
  // just with the QMP05-exact 4-item defect list and Factory-specific COA
  // labels layered on top -- see FactoryRqcWizard/FactoryCoaEntryPanel.
  {
    href: "/rqc-fg-qr",
    label: "RQC & FG QR",
    icon: (
      <path d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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

// Admin-only -- appended to SETUP_NAV_ITEMS below rather than listed
// directly, since (unlike the always-visible Setup items above) this one
// only renders once useMe() resolves and confirms is_admin, same gate the
// /users page itself re-checks server-side via require_admin.
const USERS_NAV_ITEM = {
  href: "/users",
  label: "Users",
  icon: (
    <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  ),
};

// Admin-only, same gating convention as USERS_NAV_ITEM above -- manages
// the portfolio_access table (which emails can see the Factory / US
// Factory picker below) rather than a module_permissions scope.
const PORTFOLIO_ACCESS_NAV_ITEM = {
  href: "/portfolio-access",
  label: "Portfolio Access",
  icon: (
    <path d="M3 9l9-5 9 5-9 5-9-5zM3 9v6l9 5 9-5V9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  ),
};

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);
  // Portfolio-level gate (Setup -> Portfolio Access, admin-managed): which
  // top-level product(s) this signed-in email may open. Fetched
  // independently of useMe()/is_admin below -- a person with only Factory
  // access may have no app_users row in this app at all, so this can't
  // wait on or reuse that check.
  const [portfolioAccess, setPortfolioAccess] = useState<PortfolioAccessMe | null>(null);
  const [checkedPortfolio, setCheckedPortfolio] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  // Deliberately plain component state, never persisted -- "if the user
  // has both accesses they can always be asked" means every sign-in (in
  // practice, every fresh load of this shell) shows the picker again
  // rather than remembering a past choice.
  const [chosenProduct, setChosenProduct] = useState<"factory" | "us_factory" | null>(null);
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const setupNavItems = me?.is_admin ? [...SETUP_NAV_ITEMS, USERS_NAV_ITEM, PORTFOLIO_ACCESS_NAV_ITEM] : SETUP_NAV_ITEMS;

  // The root "/" route always server-redirects to "/inward-vehicle-inspection"
  // (see app/page.tsx) since that predates the Factory/US Factory split --
  // once someone has landed in the Factory product, bounce them off that
  // (and any other non-Factory) route to Factory's own landing page instead,
  // rather than showing a US-Factory screen inside the Factory sidebar.
  useEffect(() => {
    if (chosenProduct !== "factory") return;
    const allowedHrefs = [...FACTORY_NAV_ITEMS, ...SETUP_NAV_ITEMS, USERS_NAV_ITEM, PORTFOLIO_ACCESS_NAV_ITEM].map((i) => i.href);
    if (pathname && !allowedHrefs.some((href) => pathname.startsWith(href))) {
      router.replace("/material-consumption");
    }
  }, [chosenProduct, pathname, router]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckedSession(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      // A sign-out/sign-in swap should show the picker fresh for whoever
      // just signed in, not silently keep the previous person's choice.
      setChosenProduct(null);
      setCheckedPortfolio(false);
      setPortfolioAccess(null);
      // Same signal useMe() already listens for, so switching users (or
      // signing in/out) still forces a fresh /me + permissions fetch.
      window.dispatchEvent(new Event("factory_os_user_changed"));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setCheckedPortfolio(false);
    setPortfolioError(null);
    api
      .myPortfolioAccess()
      .then((res) => {
        if (cancelled) return;
        setPortfolioAccess(res);
        // Only one access -- go straight there, no picker shown.
        if (res.access_us_factory && !res.access_factory) setChosenProduct("us_factory");
        else if (res.access_factory && !res.access_us_factory) setChosenProduct("factory");
      })
      .catch((e) => {
        if (cancelled) return;
        setPortfolioError(e instanceof ApiError ? e.message : "Could not check your access.");
      })
      .finally(() => {
        if (!cancelled) setCheckedPortfolio(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

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

  if (!checkedPortfolio) {
    return <div className="auth-loading">Loading…</div>;
  }

  if (portfolioError) {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <div className="sb-mark" style={{ margin: "0 auto 16px" }}>C</div>
          <h1>Couldn’t check your access</h1>
          <div className="desc">{portfolioError}</div>
          <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const hasFactory = !!portfolioAccess?.access_factory;
  const hasUsFactory = !!portfolioAccess?.access_us_factory;

  if (!hasFactory && !hasUsFactory) {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card">
          <div className="sb-mark" style={{ margin: "0 auto 16px" }}>C</div>
          <h1>No access yet</h1>
          <div className="desc">
            {session.user.email} isn’t set up with access to Factory or US Factory yet. Ask an admin to add you in
            Portfolio Access.
          </div>
          <button className="btn btn-tertiary" style={{ marginTop: 20 }} onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Both accesses and nothing chosen yet this session -- show the picker.
  if (hasFactory && hasUsFactory && !chosenProduct) {
    return (
      <div className="auth-gate">
        <div className="auth-gate-card" style={{ maxWidth: 480 }}>
          <div className="sb-mark" style={{ margin: "0 auto 16px" }}>C</div>
          <h1>Choose where to go</h1>
          <div className="desc">Signed in as {session.user.email}</div>
          <div style={{ display: "flex", gap: 12, marginTop: 24, flexWrap: "wrap", justifyContent: "center" }}>
            <button
              className="btn btn-tertiary"
              style={{ flex: "1 1 180px", padding: "18px 14px", fontSize: 15 }}
              onClick={() => setChosenProduct("factory")}
            >
              Factory
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: "1 1 180px", padding: "18px 14px", fontSize: 15 }}
              onClick={() => setChosenProduct("us_factory")}
            >
              US Factory
            </button>
          </div>
          <div className="desc" style={{ marginTop: 20 }}>
            <button className="btn-tertiary" onClick={() => signOut()}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  const isFactory = chosenProduct === "factory";
  const activeNavItems = isFactory ? FACTORY_NAV_ITEMS : NAV_ITEMS;

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sb-brand">
          <div className="sb-mark">C</div>
          <div className="sb-brand-text">
            <div className="name">{isFactory ? "Factory" : "US Factory"}</div>
            <div className="sub">Cirkla Manufacturing</div>
          </div>
        </div>
        <div className="sb-nav">
          <div className="sb-group">Records</div>
          {activeNavItems.map((item) => (
            <Link key={item.href} href={item.href} className={`sb-item ${pathname?.startsWith(item.href) ? "active" : ""}`}>
              <svg viewBox="0 0 24 24" fill="none">{item.icon}</svg>
              <span className="label-text">{item.label}</span>
            </Link>
          ))}
          {isFactory && (
            <div className="desc" style={{ padding: "6px 14px 2px", fontSize: 12.5 }}>
              More modules coming soon
            </div>
          )}
          <div className="sb-group">Setup</div>
          {setupNavItems.map((item) => (
            <Link key={item.href} href={item.href} className={`sb-item ${pathname?.startsWith(item.href) ? "active" : ""}`}>
              <svg viewBox="0 0 24 24" fill="none">{item.icon}</svg>
              <span className="label-text">{item.label}</span>
            </Link>
          ))}
        </div>
        <div className="sb-foot">
          <div>Signed in as {session.user.email}</div>
          <div className="sb-role" style={{ display: "flex", gap: 10 }}>
            {hasFactory && hasUsFactory && (
              <button className="btn-tertiary" onClick={() => setChosenProduct(null)}>Switch</button>
            )}
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
