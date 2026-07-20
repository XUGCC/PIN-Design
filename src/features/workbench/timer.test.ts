import { describe, expect, it } from "vitest";
import { formatElapsed, pauseTimer, startTimer, timerElapsed } from "./timer";

describe("accurate timer", () => {
  it("uses accumulated time and running timestamp", () => {
    const started = startTimer({ accumulatedMs: 5000, runningSince: null }, 10_000);
    expect(timerElapsed(started, 15_500)).toBe(10_500);
    const paused = pauseTimer(started, 15_500);
    expect(paused).toEqual({ accumulatedMs: 10_500, runningSince: null });
    expect(formatElapsed(paused.accumulatedMs)).toBe("0:10");
  });

  it("formats hour-long sessions", () => {
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });
});

