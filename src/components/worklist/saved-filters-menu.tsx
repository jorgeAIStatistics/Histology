"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bookmark, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCommand } from "@/lib/client/command";
import { isDialogOpen } from "@/lib/client/keyboard";
import { Button } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Input } from "@/components/ui/field";
import type { SavedFilter } from "@/server/queries/worklist";
import { VIEW_LABEL, filtersToSearchParams, stripUndefined, type WorklistFilters, type WorklistView } from "./views";

function hrefFor(view: WorklistView, filters: WorklistFilters): string {
  return `/worklist?${filtersToSearchParams(view, filters).toString()}`;
}

export function sameFilters(a: WorklistFilters, b: WorklistFilters): boolean {
  const norm = (f: WorklistFilters) => JSON.stringify(Object.entries(stripUndefined({ ...f })).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
}

/**
 * Saved filters as a small menu at the end of the toolbar: this view's saved filters, each with delete, and a
 * form to save the current filters. Esc or a click outside closes it. Saved filters are the user's own.
 */
export function SavedFiltersMenu({ view, filters, saved }: { view: WorklistView; filters: WorklistFilters; saved: SavedFilter[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = "saved-filters-panel";
  const active = saved.find((f) => sameFilters(f.filters, filters)) ?? null;
  const save = useCommand<{ filterId: string; replaced: boolean }, { view: WorklistView; name: string; filters: WorklistFilters }>("worklist.saveFilter", {
    successToast: (r, i) => (r.replaced ? `Saved filter "${i.name}" updated.` : `Saved filter "${i.name}".`),
    onSuccess: () => setName(""),
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (isDialogOpen() || t?.closest("dialog")) return; // a delete confirmation belongs to this menu
      if (!wrapRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isDialogOpen()) return;
      e.preventDefault(); // the side panel ignores an Escape that closed this menu
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <Button
        ref={buttonRef}
        type="button"
        size="sm"
        variant={active ? "secondary" : "quiet"}
        icon={<Bookmark />}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className={cn(active ? "border-brand bg-brand-50" : "border border-line")}
      >
        {active ? (
          <>
            <span className="@max-[62rem]/wl:sr-only">Saved:</span> <span className="max-w-32 truncate @max-[62rem]/wl:max-w-20">{active.name}</span>
          </>
        ) : (
          <>
            {/* The list narrowed by the side panel: the word goes to screen readers so the header stays one line. */}
            <span className="@max-[62rem]/wl:sr-only">Saved filters</span> <span className="num-tabular font-medium text-ink-muted">({saved.length})</span>
          </>
        )}
        <ChevronDown className="size-3.5 text-ink-muted" aria-hidden />
      </Button>
      {open ? (
        <section id={panelId} aria-label="Saved filters" className="absolute right-0 top-full z-30 mt-1 flex w-80 flex-col gap-2 rounded-md border border-line bg-surface p-3 text-sm shadow-2">
          <h3 className="text-sm font-semibold text-ink">Saved filters for the {VIEW_LABEL[view]} view</h3>
          {saved.length === 0 ? <p className="text-sm text-ink-muted">None yet. Saved filters are yours only; nobody else&apos;s list changes.</p> : null}
          {saved.length ? (
            <ul className="flex flex-col gap-1">
              {saved.map((f) => {
                const isActive = sameFilters(f.filters, filters);
                return (
                  <li key={f.id} className={cn("flex items-center gap-1 rounded-sm border pl-2 pr-0.5", isActive ? "border-brand bg-brand-50" : "border-line")}>
                    <Link
                      href={hrefFor(view, f.filters)}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => setOpen(false)}
                      className="min-w-0 flex-1 truncate py-1 text-sm font-medium text-ink hover:underline"
                    >
                      {f.name}
                    </Link>
                    <CommandButton
                      command="worklist.deleteFilter"
                      input={{ filterId: f.id }}
                      variant="quiet"
                      size="sm"
                      aria-label={`Delete saved filter ${f.name}`}
                      pendingLabel="..."
                      showError="toast"
                      confirm={{ title: `Delete saved filter "${f.name}"?`, body: "Only your saved shortcut is removed. No cases or tasks change.", confirmLabel: "Delete saved filter", cancelLabel: "Keep it", destructive: true }}
                      successToast={`Deleted saved filter "${f.name}".`}
                      className="h-6 min-h-6 px-1"
                    >
                      <X className="size-3.5" aria-hidden />
                    </CommandButton>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <form
            className="flex items-center gap-1 border-t border-line pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void save.run({ view, name: name.trim(), filters: stripUndefined({ ...filters }) });
            }}
          >
            <label className="sr-only" htmlFor="save-filter-name">
              Name for the current filters
            </label>
            <Input id="save-filter-name" size="sm" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Name the current filters" className="min-w-0 flex-1" />
            <Button type="submit" size="sm" variant="secondary" loading={save.pending} loadingLabel="Saving..." disabled={!name.trim()}>
              Save
            </Button>
          </form>
          <CommandError error={save.error} />
        </section>
      ) : null}
    </div>
  );
}
