"use client";

import { useEffect, useId, useState } from "react";
import { Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { PREFS, usePref, type Density, type ScannerSuffix } from "@/lib/client/preferences";
import { playTone } from "@/lib/client/sound";

function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  hint,
}: {
  legend: string;
  name: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <fieldset className="grid gap-1" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="text-sm font-medium text-ink">{legend}</legend>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {options.map((o) => (
        <label key={o.value} className="flex min-h-[max(2rem,var(--hlo-target-min))] cursor-pointer items-start gap-2.5 rounded-sm py-1 text-sm">
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="mt-0.5 size-[1.125rem] shrink-0 accent-[var(--hlo-brand)]" />
          <span>
            <span className="text-ink">{o.label}</span>
            {o.hint ? <span className="block text-sm text-ink-muted">{o.hint}</span> : null}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function PreferencesTab() {
  const [density, setDensity] = usePref(PREFS.density);
  const [sound, setSound] = usePref(PREFS.sound);
  const [volume, setVolume] = usePref(PREFS.soundVolume);
  const [singleKey, setSingleKey] = usePref(PREFS.singleKeyShortcuts);
  const [suffix, setSuffix] = usePref(PREFS.scannerSuffix);
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);
  const volumeId = useId();

  useEffect(() => {
    try {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      setReducedMotion(mq.matches);
      const on = () => setReducedMotion(mq.matches);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    } catch {
      setReducedMotion(null);
    }
  }, []);

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
      <div className="grid grid-cols-1 content-start gap-4">
        <Card title="Display" description="Saved in this browser only. Other workstations keep their own settings.">
          <RadioGroup<Density>
            legend="Table density"
            name="density"
            value={density}
            onChange={setDensity}
            options={[
              { value: "auto", label: "Automatic", hint: "Compact on wide screens, comfortable below 1280px or on touch screens" },
              { value: "compact", label: "Compact", hint: "Bench workstation: 36px rows, 13px text" },
              { value: "comfortable", label: "Comfortable", hint: "Bench tablet: 48px rows, 15px text, 44px touch targets" },
            ]}
          />
          <p className="mt-4 text-sm text-ink-secondary">
            Reduce motion follows your system setting:{" "}
            <span className="font-medium text-ink">{reducedMotion === null ? "Unknown" : reducedMotion ? "On (system)" : "Off (system)"}</span>. The app uses only short fades either way.
          </p>
        </Card>

        <Card title="Keyboard" description="Saved in this browser only.">
          <Checkbox
            label="Single-key shortcuts"
            hint="J/K to move between rows, G then a letter to change page, ? for help. Turn off if they get in the way."
            checked={singleKey}
            onChange={(e) => setSingleKey(e.target.checked)}
          />
          <ul className="mt-3 grid gap-1 text-sm text-ink-secondary">
            <li>
              <Kbd>/</Kbd> or <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd> focus the scan field (always on)
            </li>
            <li>
              <Kbd>Esc</Kbd> close a panel or dialog
            </li>
            <li>
              <Kbd>?</Kbd> show all shortcuts {singleKey ? "" : "(off while single-key shortcuts are off)"}
            </li>
          </ul>
        </Card>
      </div>

      <Card title="Scanning and sound" description="Saved in this browser only.">
        <div className="grid grid-cols-1 gap-4">
          <Checkbox
            label="Sound feedback after scans"
            hint="Off by default. A short high tone for a match, two lower tones for a mismatch. Always shown on screen too."
            checked={sound}
            onChange={(e) => setSound(e.target.checked)}
          />
          <div className="grid gap-1">
            <label htmlFor={volumeId} className="text-sm font-medium text-ink">
              Volume <span className="font-normal text-ink-muted">({Math.round(volume * 100)}%)</span>
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                id={volumeId}
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="h-[max(2rem,var(--hlo-target-min))] w-48 accent-[var(--hlo-brand)]"
              />
              <Button size="sm" icon={<Volume2 />} onClick={() => playTone("match", volume)}>
                Play match tone
              </Button>
              <Button size="sm" icon={<Volume2 />} onClick={() => playTone("mismatch", volume)}>
                Play mismatch tone
              </Button>
            </div>
          </div>
          <RadioGroup<ScannerSuffix>
            legend="Scanner ends each code with"
            name="scanner-suffix"
            value={suffix}
            onChange={setSuffix}
            hint="Match your scanner's configuration. Scanners act like keyboards."
            options={[
              { value: "enter", label: "Enter" },
              { value: "tab", label: "Tab" },
            ]}
          />
        </div>
      </Card>

    </div>
  );
}
