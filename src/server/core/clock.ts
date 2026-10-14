import type { DB } from "../db/db";
import { getSetting, setSetting } from "./settings";

/**
 * Controllable demo clock. The demo "now" is anchored to a wall-clock instant;
 * while running it advances in real time, while paused it stays fixed.
 * All domain timestamps use this clock so the demonstration is reproducible.
 */
export interface ClockState {
  now: string;
  running: boolean;
  anchorDemo: string;
  anchorWall: string;
}

export function readClock(db: DB, wallNow = Date.now()): ClockState {
  const anchorDemo = getSetting(db, "clock_anchor_demo") ?? new Date(wallNow).toISOString();
  const anchorWall = getSetting(db, "clock_anchor_wall") ?? new Date(wallNow).toISOString();
  const running = getSetting(db, "clock_running") === "1";
  const base = Date.parse(anchorDemo);
  const elapsed = running ? Math.max(0, wallNow - Date.parse(anchorWall)) : 0;
  return { now: new Date(base + elapsed).toISOString(), running, anchorDemo, anchorWall };
}

export function demoNow(db: DB): string {
  return readClock(db).now;
}

export function setClock(db: DB, isoDemoTime: string, running: boolean, wallNow = Date.now()): ClockState {
  const wall = new Date(wallNow).toISOString();
  setSetting(db, "clock_anchor_demo", new Date(isoDemoTime).toISOString(), wall);
  setSetting(db, "clock_anchor_wall", wall, wall);
  setSetting(db, "clock_running", running ? "1" : "0", wall);
  return readClock(db, wallNow);
}

export function advanceClock(db: DB, minutes: number): ClockState {
  const state = readClock(db);
  return setClock(db, new Date(Date.parse(state.now) + minutes * 60_000).toISOString(), state.running);
}

/** Move the clock forward to `iso` only if it is later than the current demo time. */
export function advanceClockTo(db: DB, iso: string): ClockState {
  const state = readClock(db);
  if (Date.parse(iso) <= Date.parse(state.now)) return state;
  return setClock(db, iso, state.running);
}

export function setClockRunning(db: DB, running: boolean): ClockState {
  const state = readClock(db);
  return setClock(db, state.now, running);
}
