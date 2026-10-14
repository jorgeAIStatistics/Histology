"use client";

import { useEffect, useId } from "react";

/**
 * Tracks unsaved edits so the role switch and context changes can ask first
 * ("Unsaved changes for D26-04817 Part B"). Values never carry over.
 */
const dirty = new Map<string, string>();

export function hasUnsavedChanges(): boolean {
  return dirty.size > 0;
}

/** Labels of the forms that currently hold unsaved edits. */
export function unsavedLabels(): string[] {
  return [...dirty.values()];
}

/**
 * `useUnsavedChanges(isDirty, "D26-04817 Part B gross record")` — registers
 * while dirty, and asks the browser to confirm before leaving the page.
 */
export function useUnsavedChanges(isDirty: boolean, label = "this form"): void {
  const id = useId();
  useEffect(() => {
    if (!isDirty) {
      dirty.delete(id);
      return;
    }
    dirty.set(id, label);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      dirty.delete(id);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [id, isDirty, label]);
}
