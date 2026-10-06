"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PermissionKey } from "@/lib/permissions";

// Client-side permission awareness for the ERP chrome (Module 82). This only
// decides what to RENDER. The API routes and pages still enforce access via
// requirePermission()/hasPermission() – hiding a button is never the guard.
const Ctx = createContext<ReadonlySet<string>>(new Set());

export function PermissionProvider({ granted, children }: { granted: string[]; children: ReactNode }) {
  return <Ctx.Provider value={new Set(granted)}>{children}</Ctx.Provider>;
}

export function useCan(...perms: PermissionKey[]): boolean {
  const granted = useContext(Ctx);
  return perms.length === 0 || perms.some((p) => granted.has(p));
}

/** <PermissionGate perm="sales.create">…</PermissionGate>; pass several keys for "any of". */
export function PermissionGate({
  perm,
  fallback = null,
  children,
}: {
  perm: PermissionKey | PermissionKey[];
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const ok = useCan(...(Array.isArray(perm) ? perm : [perm]));
  return <>{ok ? children : fallback}</>;
}
