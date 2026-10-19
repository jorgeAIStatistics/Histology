"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, ScanLine, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { PREFS } from "@/lib/client/pref-keys";
import { usePref } from "@/lib/client/preferences";
import { useScan } from "@/lib/client/scan";
import { TONE_CLASSES, TONE_ICON } from "@/components/ui/tone";
import { IdText } from "@/components/domain/id-text";

/**
 * Global scan / search field (spec §5.1, §7). Same place on every page, 40px
 * tall, 20px mono input, prefix chip with the current scan target.
 * Keys: / or Ctrl/Cmd+K focus it (GlobalShortcuts); Enter submits (Tab too if
 * the scanner suffix preference is Tab); Esc clears; a second Esc resets the
 * target to "Find record". The result line under the field is announced
 * (aria-live polite; blocking mismatches use role="alert").
 */
export function ScanField() {
  const scan = useScan();
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  // Long results are clamped to two lines so the line under the field covers as little of the page as possible.
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const [politeMsg, setPoliteMsg] = useState("");
  const [alertMsg, setAlertMsg] = useState("");
  const [suffix] = usePref(PREFS.scannerSuffix);
  const resultId = useId();
  const lastAt = useRef(0);

  const result = scan.result;

  // Show + announce each new result. Success/info lines fade from view after 10 s; warnings and errors stay.
  useEffect(() => {
    if (!result || result.at === lastAt.current) {
      if (!result) setVisible(false);
      return;
    }
    lastAt.current = result.at;
    setVisible(true);
    setExpanded(false);
    setPoliteMsg("");
    setAlertMsg("");
    const say = window.setTimeout(() => {
      if (result.alert) setAlertMsg(result.message);
      else setPoliteMsg(result.message);
    }, 30);
    let hide: number | undefined;
    if (result.tone === "success" || result.tone === "info") hide = window.setTimeout(() => setVisible(false), result.tone === "info" ? 4000 : 8000);
    return () => {
      window.clearTimeout(say);
      if (hide) window.clearTimeout(hide);
    };
  }, [result]);

  // "Show all" only when the two-line clamp actually hides text (any width, any message).
  useLayoutEffect(() => {
    const el = messageRef.current;
    if (!el || expanded) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [result, visible, expanded]);

  const submit = async () => {
    const v = value;
    if (!v.trim() || scan.pending) return;
    const out = await scan.submit(v);
    if (!out?.keepValue) setValue("");
  };

  const tone = result?.tone ?? "info";
  const ResultIcon = TONE_ICON[tone];
  const c = TONE_CLASSES[tone];

  return (
    <div className="relative min-w-[200px] max-w-[560px] flex-1 max-lg:max-w-none">
      <div
        className={cn(
          "flex h-10 items-stretch overflow-hidden rounded-md border border-line-strong bg-surface",
          "focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus",
        )}
      >
        <label
          htmlFor="scan-field"
          className={cn(
            "flex max-w-[55%] shrink-0 cursor-text items-center gap-1.5 border-r border-line px-2.5 text-sm font-medium max-xl:px-2",
            scan.isDefault ? "bg-surface-subtle text-ink-secondary" : "bg-brand-50 text-brand-ink",
          )}
        >
          <ScanLine className="size-4 shrink-0" aria-hidden />
          <span className="sr-only">Scan target: </span>
          <span className="truncate">{scan.target.label}</span>
        </label>
        <input
          id="scan-field"
          ref={scan.inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Tab" && suffix === "tab" && value.trim() && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              // Esc clears the text (or the result line); the next Esc resets the target to "Find record".
              if (value) {
                setValue("");
                setVisible(false);
              } else if (visible) {
                setVisible(false);
              } else if (!scan.isDefault) {
                scan.resetTarget();
              }
            }
          }}
          placeholder={scan.target.placeholder ?? "Scan or type an ID"}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="go"
          aria-describedby={visible && result ? resultId : undefined}
          className="id-mono min-w-0 flex-1 bg-transparent px-2.5 text-lg text-ink outline-none placeholder:font-sans placeholder:text-sm placeholder:text-ink-muted"
        />
        {scan.pending ? (
          <span className="flex items-center pr-2.5" aria-hidden>
            <LoaderCircle className="size-4 animate-spin text-ink-muted motion-reduce:animate-none" />
          </span>
        ) : null}
      </div>

      {visible && result ? (
        <div
          id={resultId}
          className={cn(
            "animate-rise-in absolute left-0 right-0 top-[calc(100%+4px)] z-50 flex items-start gap-2 rounded-lg border bg-surface px-2.5 py-1.5 text-sm shadow-3",
            c.border,
          )}
        >
          <ResultIcon className={cn("mt-0.5 size-4 shrink-0", c.solidText)} aria-hidden />
          <div className="min-w-0 flex-1">
            <p ref={messageRef} className={cn(!expanded && "line-clamp-2", tone === "danger" || tone === "warning" ? c.fg : "text-ink")} title={result.message}>
              <IdText text={result.message} />
            </p>
            {clamped || expanded ? (
              <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-0.5 text-xs font-medium text-brand underline underline-offset-2">
                {expanded ? "Show less" : "Show all"}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setVisible(false)}
            aria-label="Hide scan result"
            className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-subtle hover:text-ink"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {/* Persistent live regions (exist before content changes, so updates are announced). */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {politeMsg}
      </div>
      <div className="sr-only" role="alert" aria-atomic="true">
        {alertMsg}
      </div>
    </div>
  );
}
