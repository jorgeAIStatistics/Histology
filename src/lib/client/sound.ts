"use client";

import { PREFS } from "./pref-keys";
import { readPreference } from "./preferences";

/**
 * Optional scan sound feedback (spec §9): two distinct tones generated with
 * the Web Audio API, no audio files. Off by default. Sound always accompanies
 * on-screen text and is never the only signal. Browsers only allow audio after
 * the user's first interaction; failures are silent.
 */
export type ScanSound = "match" | "mismatch";

let audioCtx: AudioContext | null = null;

export function playTone(kind: ScanSound, volume = 0.5): void {
  try {
    const Ctor: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const level = Math.min(1, Math.max(0, volume)) * 0.25;
    if (level <= 0) return;
    // match: one short higher tone. mismatch: two lower notes.
    const notes: [freq: number, start: number, dur: number][] =
      kind === "match" ? [[880, 0, 0.09]] : [[330, 0, 0.14], [247, 0.17, 0.2]];
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, start, dur] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + start);
      gain.gain.exponentialRampToValueAtTime(level, t0 + start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.03);
    }
  } catch {
    /* audio unavailable: on-screen text still carries the result */
  }
}

/** Plays the tone only when the user turned sound feedback on in Preferences. */
export function playScanFeedback(kind: ScanSound): void {
  if (!readPreference(PREFS.sound.key, PREFS.sound.default)) return;
  playTone(kind, readPreference(PREFS.soundVolume.key, PREFS.soundVolume.default));
}
