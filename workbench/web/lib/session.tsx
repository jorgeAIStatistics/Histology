"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { DemoUser, Me, Meta } from "./types";

const PROJECT_KEY = "wb.project";
// The session cookie is HttpOnly, so the page cannot see it. This flag only avoids asking /auth/me
// (and logging a 401) when this browser never chose a demo role; the API still decides.
const SESSION_HINT_KEY = "wb.session-hint";

function readHint(): boolean {
  try {
    return window.localStorage.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return true;
  }
}

function writeHint(on: boolean) {
  try {
    if (on) window.localStorage.setItem(SESSION_HINT_KEY, "1");
    else window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    /* storage unavailable */
  }
}

type SessionState = {
  me: Me | null;
  meta: Meta | null;
  demoUsers: DemoUser[];
  projectId: string | null;
  loading: boolean;
  apiError: string | null;
  // Bumped on every role or project switch so data views refetch.
  version: number;
  can: (permission: string) => boolean;
  switchUser: (userId: string) => Promise<void>;
  logout: () => Promise<void>;
  setProjectId: (id: string) => void;
  refreshMe: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

function readStoredProject(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function storeProject(id: string) {
  try {
    window.localStorage.setItem(PROJECT_KEY, id);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

function pickProject(me: Me | null, preferred: string | null): string | null {
  if (!me || me.memberships.length === 0) return null;
  if (preferred && me.memberships.some((m) => m.project_id === preferred)) return preferred;
  const demo = me.memberships.find((m) => m.project_id === "proj-bcc-demo");
  return (demo ?? me.memberships[0]).project_id;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [demoUsers, setDemoUsers] = useState<DemoUser[]>([]);
  const [projectId, setProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setApiError(null);
    try {
      const [metaRes, usersRes] = await Promise.all([api<Meta>("/meta"), api<DemoUser[]>("/auth/demo-users")]);
      setMeta(metaRes);
      setDemoUsers(usersRes);
    } catch (err) {
      setApiError(err instanceof ApiError ? err.message : String(err));
    }
    try {
      if (!readHint()) {
        setMe(null);
        return;
      }
      const m = await api<Me>("/auth/me");
      setMe(m);
      setProject(pickProject(m, readStoredProject()));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        writeHint(false);
      } else {
        setApiError((prev) => prev ?? (err instanceof Error ? err.message : String(err)));
      }
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchUser = useCallback(async (userId: string) => {
    const m = await api<Me>("/auth/demo-login", { method: "POST", body: { userId } });
    writeHint(true);
    setMe(m);
    const next = pickProject(m, readStoredProject());
    setProject(next);
    if (next) storeProject(next);
    setVersion((v) => v + 1);
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" });
    writeHint(false);
    setMe(null);
    setVersion((v) => v + 1);
  }, []);

  const setProjectId = useCallback((id: string) => {
    setProject(id);
    storeProject(id);
    setVersion((v) => v + 1);
  }, []);

  const refreshMe = useCallback(async () => {
    const m = await api<Me>("/auth/me");
    setMe(m);
  }, []);

  const can = useCallback((permission: string) => Boolean(me && me.permissions[permission]), [me]);

  const value = useMemo<SessionState>(
    () => ({ me, meta, demoUsers, projectId, loading, apiError, version, can, switchUser, logout, setProjectId, refreshMe }),
    [me, meta, demoUsers, projectId, loading, apiError, version, can, switchUser, logout, setProjectId, refreshMe],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** Roles allowed for a permission, for "needs the X role" explanations. */
export const PERMISSION_ROLES: Record<string, string[]> = {
  "hierarchy.write": ["histology_assistant"],
  "upload.write": ["histology_assistant"],
  "qc.write": ["histology_assistant", "pathologist"],
  "qc.screen": ["histology_assistant", "pathologist"],
  "annotation.write": ["pathologist"],
  "label.expert_write": ["pathologist"],
  "review.assess": ["pathologist"],
  "review.suggestion": ["pathologist"],
  "review.state.route": ["histology_assistant", "pathologist"],
  "disagreement.adjudicate": ["pathologist"],
  "near_duplicate.review": ["pathologist", "research_lead"],
  "dataset.write": ["research_lead"],
  "dataset.test_access": ["research_lead"],
  "comment.write": ["histology_assistant", "pathologist", "research_lead", "medical_director"],
  "jobs.manage": ["histology_assistant", "pathologist", "research_lead"],
  "experiment.read": ["research_lead", "medical_director", "pathologist"],
  "experiment.write": ["research_lead"],
  "model.register": ["research_lead"],
  "project.settings": ["research_lead"],
};
