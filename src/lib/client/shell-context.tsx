"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { roleCan, ROLE_LABEL, type Permission, type Role } from "@/lib/roles";
import type { ShellActor, ShellStaff } from "./types";

interface ShellContextValue {
  actor: ShellActor;
  staff: ShellStaff[];
}

const ShellContext = createContext<ShellContextValue | null>(null);

const FALLBACK: ShellContextValue = {
  actor: { id: "stf_maya", name: "Maya Torres", role: "accessioner" },
  staff: [],
};

export function ShellContextProvider({ actor, staff, children }: ShellContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ actor, staff }), [actor, staff]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** The current demo actor (from the "Acting as" role switch). */
export function useActor(): ShellActor {
  return (useContext(ShellContext) ?? FALLBACK).actor;
}

export function useStaff(): ShellStaff[] {
  return (useContext(ShellContext) ?? FALLBACK).staff;
}

/** Resolve a staff id to a display name ("Kim Nguyen"); falls back to the id. */
export function useStaffName(): (id: string | null | undefined) => string | null {
  const staff = useStaff();
  return useMemo(() => {
    const map = new Map(staff.map((s) => [s.id, s.name]));
    return (id) => (id ? (map.get(id) ?? id) : null);
  }, [staff]);
}

/** Director (demo) and Medical director (demo) are read-only roles in this demo. */
export function isReadOnlyRole(role: Role): boolean {
  return role === "director" || role === "medical_director";
}

/**
 * UI-side permission hint, used ONLY to explain why a control is disabled.
 * The server enforces permissions on every command regardless.
 */
export function useCan(permission: Permission): { allowed: boolean; reason: string | null } {
  const actor = useActor();
  const allowed = roleCan(actor.role, permission);
  return {
    allowed,
    reason: allowed ? null : `Not allowed for ${ROLE_LABEL[actor.role]}.`,
  };
}
