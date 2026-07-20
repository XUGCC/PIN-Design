import type { WorkTimer } from "./model";

export function timerElapsed(timer: WorkTimer, now = Date.now()): number {
  return timer.accumulatedMs + (timer.runningSince === null ? 0 : Math.max(0, now - timer.runningSince));
}

export function startTimer(timer: WorkTimer, now = Date.now()): WorkTimer {
  return timer.runningSince === null ? { ...timer, runningSince: now } : timer;
}

export function pauseTimer(timer: WorkTimer, now = Date.now()): WorkTimer {
  if (timer.runningSince === null) return timer;
  return { accumulatedMs: timerElapsed(timer, now), runningSince: null };
}

export function resetTimer(): WorkTimer {
  return { accumulatedMs: 0, runningSince: null };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

