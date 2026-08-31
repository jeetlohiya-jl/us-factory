"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DEV_USERS, getCurrentDevEmail, setCurrentDevEmail } from "@/lib/session";

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

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [email, setEmail] = useState(DEV_USERS[0].email);
  const pathname = usePathname();

  useEffect(() => {
    setEmail(getCurrentDevEmail());
    const onChange = () => setEmail(getCurrentDevEmail());
    window.addEventListener("factory_os_user_changed", onChange);
    return () => window.removeEventListener("factory_os_user_changed", onChange);
  }, []);

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
        </div>
        <div className="sb-foot">
          <div>Signed in as {DEV_USERS.find((u) => u.email === email)?.label || email}</div>
          <div className="sb-role">
            <select value={email} onChange={(e) => setCurrentDevEmail(e.target.value)}>
              {DEV_USERS.map((u) => (
                <option key={u.email} value={u.email}>{u.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="main">
        <div className="content">{children}</div>
      </div>
    </div>
  );
}
