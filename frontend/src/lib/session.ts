"use client";
/**
 * Dev session stand-in. Supabase Auth with Google OAuth isn't wired up yet
 * (no live Supabase project for this task), so the signed-in user is kept in
 * memory here and sent as a "dev:<email>" bearer token, which the backend's
 * DevAuthAdapter resolves to a real row in app_users. Swapping in real
 * Supabase sessions later means replacing this module's getToken()/getUser()
 * with a Supabase client call — nothing else (API client, components) changes.
 */
export const DEV_USERS = [
  { email: "r.fernandez@cirkla.com", label: "R. Fernandez (Admin)" },
  { email: "staff@cirkla.com", label: "S. Staff (Staff)" },
];

const STORAGE_KEY = "factory_os_dev_user";

export function getCurrentDevEmail(): string {
  if (typeof window === "undefined") return DEV_USERS[0].email;
  return window.localStorage.getItem(STORAGE_KEY) || DEV_USERS[0].email;
}

export function setCurrentDevEmail(email: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, email);
  window.dispatchEvent(new Event("factory_os_user_changed"));
}

export function getAuthHeader(): string {
  return `Bearer dev:${getCurrentDevEmail()}`;
}
