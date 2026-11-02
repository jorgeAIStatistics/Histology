"use client";

import { useState } from "react";
import { ChevronDown, RotateCcw, UserRound } from "lucide-react";
import { useSession } from "@/lib/session";
import { ROLE_LABEL } from "@/lib/format";
import { api, errorText } from "@/lib/api";
import { useToast } from "@/components/ui/Toaster";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { Popover } from "./Popover";
import type { Role } from "@/lib/types";

const ROLE_ORDER: Role[] = ["histology_assistant", "pathologist", "research_lead", "medical_director", "admin"];

function initials(name: string) {
  return name
    .replace(/^Dr\.\s*/, "")
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function RoleSwitcher() {
  const { me, demoUsers, switchUser, logout, loading } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const users = [...demoUsers].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.display_name.localeCompare(b.display_name));

  const trigger = me ? (
    <span className="flex items-center gap-2">
      <span aria-hidden className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-micro font-bold text-white">
        {initials(me.user.display_name)}
      </span>
      <span className="hidden text-left leading-tight xl:block">
        <span className="block max-w-[150px] truncate text-small font-semibold text-ink">{me.user.display_name}</span>
        <span className="block text-micro text-graphite">{ROLE_LABEL[me.user.role]}</span>
      </span>
      <span className="text-left leading-tight xl:hidden">
        <span className="block text-micro font-semibold text-ink">{ROLE_LABEL[me.user.role]}</span>
      </span>
      <ChevronDown size={14} aria-hidden className="text-graphite" />
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-small font-semibold text-teal-deep">
      <UserRound size={16} aria-hidden />
      {loading ? (
        "Loading…"
      ) : (
        <>
          <span className="sm:hidden">Demo role</span>
          <span className="hidden sm:inline">Choose a demo role</span>
        </>
      )}
      <ChevronDown size={14} aria-hidden />
    </span>
  );

  return (
    <>
      <Popover
        label={me ? `Demo role switch, current role ${ROLE_LABEL[me.user.role]}` : "Choose a demo role"}
        testId="role-switcher"
        trigger={trigger}
        triggerClassName="flex h-10 items-center rounded-[var(--radius-control)] border border-line-strong bg-sheet px-2 hover:border-teal"
        panelClassName="w-[360px]"
      >
        {(close) => (
          <div>
            <p className="text-small font-bold text-ink">Demo role switch — not authentication</p>
            <p className="mt-1 text-micro text-graphite">
              {me?.notice ?? "Anyone with access to this demo can act as any seeded fictional user. Do not use with real patient data."}
            </p>
            <ul className="mt-3 space-y-0.5" aria-label="Fictional demo users">
              {users.map((u) => {
                const current = me?.user.id === u.id;
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      data-testid={`demo-user-${u.id}`}
                      aria-pressed={current}
                      disabled={busy !== null}
                      onClick={async () => {
                        setBusy(u.id);
                        try {
                          await switchUser(u.id);
                          toast.show({ tone: "success", title: `Now acting as ${u.display_name}`, body: `${ROLE_LABEL[u.role]} (fictional demo user)` });
                          close();
                        } catch (err) {
                          toast.show({ tone: "error", title: "Role switch failed", body: errorText(err) });
                        } finally {
                          setBusy(null);
                        }
                      }}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left hover:bg-paraffin",
                        current && "bg-teal-tint hover:bg-teal-tint",
                      )}
                    >
                      <span aria-hidden className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-micro font-bold", current ? "bg-teal text-white" : "bg-paraffin text-ink")}>
                        {initials(u.display_name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-small font-semibold text-ink">{u.display_name}</span>
                        <span className="block text-micro text-graphite">{ROLE_LABEL[u.role]}</span>
                      </span>
                      {busy === u.id ? <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-teal border-r-transparent" /> : current ? <span className="text-micro font-semibold text-teal-deep">current</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {me ? (
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={async () => {
                    await logout();
                    close();
                  }}
                >
                  Leave the demo session
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                icon={<RotateCcw size={14} aria-hidden />}
                unavailable={me?.user.role === "admin" ? null : "Resetting the demo data needs the admin demo role (POST /demo/reset is admin-only, demo mode only)."}
                onClick={() => {
                  close();
                  setResetOpen(true);
                }}
              >
                Reset demo data
              </Button>
            </div>
          </div>
        )}
      </Popover>
      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset the demo data?"
        description="Drops every record and re-seeds the fictional demo project. Annotations, labels, datasets and uploads made in this session are lost."
        footer={
          <>
            <Button onClick={() => setResetOpen(false)}>Keep the data</Button>
            <Button
              variant="danger"
              busy={resetting}
              onClick={async () => {
                setResetting(true);
                try {
                  await api("/demo/reset", { method: "POST" });
                  toast.show({ tone: "success", title: "Demo data reset", body: "The fictional seed was recreated. Choose a role to continue." });
                  setResetOpen(false);
                  window.location.reload();
                } catch (err) {
                  toast.show({ tone: "error", title: "Reset failed", body: errorText(err) });
                } finally {
                  setResetting(false);
                }
              }}
            >
              Reset demo data
            </Button>
          </>
        }
      />
    </>
  );
}
