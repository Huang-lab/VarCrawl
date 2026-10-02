import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter, envNumber, mapWithLimiter } from "@/lib/entrez/scheduler";

/**
 * Track how many tasks are running at the same instant.
 *
 * A live counter is the only sound way to measure this: the limiter releases
 * each slot as its own task settles, so one slow task's start/end interval can
 * legitimately span several later batches. Comparing recorded intervals for
 * overlap therefore over-counts and is not a test of the concurrency cap.
 */
function concurrencyProbe() {
  let live = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async run<T>(fn: () => Promise<T>): Promise<T> {
      live += 1;
      peak = Math.max(peak, live);
      try {
        return await fn();
      } finally {
        live -= 1;
      }
    },
  };
}

describe("RateLimiter", () => {
  it("caps concurrency at the configured ceiling", async () => {
    const limiter = new RateLimiter({ ratePerSec: 1000, concurrency: 3, burst: 3 });
    const probe = concurrencyProbe();
    let completed = 0;
    await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.schedule(() =>
          probe.run(async () => {
            await new Promise((r) => setTimeout(r, 30));
            completed += 1;
          }),
        ),
      ),
    );
    expect(completed).toBe(12);
    expect(probe.peak).toBe(3);
  });

  it("runs a single task when concurrency is 1", async () => {
    const limiter = new RateLimiter({ ratePerSec: 1000, concurrency: 1, burst: 1 });
    const probe = concurrencyProbe();
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.schedule(() => probe.run(() => new Promise((r) => setTimeout(r, 5)))),
      ),
    );
    expect(probe.peak).toBe(1);
  });

  it("holds the sustained rate below the configured requests per second", async () => {
    // 20 tokens/sec, burst 4: 24 instant tasks need >= (24-4)/20 = 1.0s.
    const limiter = new RateLimiter({ ratePerSec: 20, concurrency: 8, burst: 4 });
    const started: number[] = [];
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 24 }, () =>
        limiter.schedule(async () => {
          started.push(Date.now() - t0);
        }),
      ),
    );
    const elapsed = Date.now() - t0;
    expect(started).toHaveLength(24);
    expect(elapsed).toBeGreaterThanOrEqual(950);

    // No 1-second window may contain more than burst + rate requests.
    for (const s of started) {
      const inWindow = started.filter((o) => o >= s && o < s + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(4 + 20);
    }
  });

  it("overlaps latency instead of accumulating it", async () => {
    // 12 tasks of 100ms each. Serial would be ~1200ms; at concurrency 6 the
    // rate budget (50/s, burst 6) is not the constraint, so expect ~200ms.
    const limiter = new RateLimiter({ ratePerSec: 50, concurrency: 6, burst: 6 });
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.schedule(() => new Promise((r) => setTimeout(r, 100))),
      ),
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(600);
  });

  it("releases the concurrency slot when a task rejects", async () => {
    const limiter = new RateLimiter({ ratePerSec: 1000, concurrency: 2, burst: 2 });
    const failures = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        limiter.schedule(async () => {
          throw new Error("upstream boom");
        }),
      ),
    );
    expect(failures.every((f) => f.status === "rejected")).toBe(true);
    // A healthy task still gets through afterwards, proving no slot leaked.
    await expect(limiter.schedule(async () => "ok")).resolves.toBe("ok");
    expect(limiter.stats().inFlight).toBe(0);
  });

  it("acquireToken() waits for budget without taking a concurrency slot", async () => {
    // Retries call this from inside a held slot. It must throttle them, and it
    // must not need a second slot (which would deadlock at the ceiling).
    const limiter = new RateLimiter({ ratePerSec: 5, concurrency: 1, burst: 1 });

    const t0 = Date.now();
    await limiter.schedule(async () => {
      // Two extra requests, as two retries of this one would be. Concurrency
      // is 1 and this task holds it, so a slot-based wait could never proceed.
      await limiter.acquireToken();
      await limiter.acquireToken();
    });
    // Burst 1 covers the initial call; each further token takes ~200ms at 5/s.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
  });

  it("keeps a retry storm inside the rate ceiling", async () => {
    // Every task retries twice, so 3x the requests. The bucket, not the task
    // count, must set the pace.
    const limiter = new RateLimiter({ ratePerSec: 8, concurrency: 6, burst: 2 });
    const times: number[] = [];
    const t0 = Date.now();

    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.schedule(async () => {
          times.push(Date.now() - t0);
          for (let retry = 0; retry < 2; retry++) {
            await limiter.acquireToken();
            times.push(Date.now() - t0);
          }
        }),
      ),
    );

    expect(times).toHaveLength(60);
    let peak = 0;
    for (const t of times) {
      peak = Math.max(peak, times.filter((o) => o >= t && o < t + 1000).length);
    }
    // burst + rate = 10 is the bound, retries included.
    expect(peak).toBeLessThanOrEqual(10);
  }, 30000);
});

describe("mapWithLimiter", () => {
  it("preserves input order regardless of completion order", async () => {
    const limiter = new RateLimiter({ ratePerSec: 1000, concurrency: 5, burst: 5 });
    const input = [50, 10, 40, 5, 30];
    const out = await mapWithLimiter(limiter, input, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:50", "1:10", "2:40", "3:5", "4:30"]);
  });

  it("returns an empty array for no tasks", async () => {
    const limiter = new RateLimiter({ ratePerSec: 10, concurrency: 2 });
    await expect(mapWithLimiter(limiter, [], async () => 1)).resolves.toEqual([]);
  });
});


describe("envNumber", () => {
  const NAME = "VARCRAWL_TEST_ENV_NUMBER";
  const original = process.env[NAME];

  afterEach(() => {
    if (original === undefined) delete process.env[NAME];
    else process.env[NAME] = original;
  });

  it("reads a valid positive number", () => {
    process.env[NAME] = "42";
    expect(envNumber(NAME, 7)).toBe(42);
    process.env[NAME] = "2.5";
    expect(envNumber(NAME, 7)).toBe(2.5);
  });

  it("falls back when unset", () => {
    delete process.env[NAME];
    expect(envNumber(NAME, 7)).toBe(7);
  });

  it("falls back on a defined-but-blank value", () => {
    // The failure this guards: `Number(process.env.X ?? 15000)` yields 0 here,
    // and a 0ms timeout aborts every upstream call. Blank is exactly the shape
    // .env.example uses and that deployment dashboards produce.
    process.env[NAME] = "";
    expect(envNumber(NAME, 15000)).toBe(15000);
    process.env[NAME] = "   ";
    expect(envNumber(NAME, 15000)).toBe(15000);
  });

  it("falls back on non-numeric, zero, negative and non-finite values", () => {
    for (const bad of ["abc", "0", "-1", "NaN", "Infinity", "1e999"]) {
      process.env[NAME] = bad;
      expect(envNumber(NAME, 7)).toBe(7);
    }
  });
});
