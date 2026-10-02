/**
 * Rate-limited, bounded-concurrency scheduler for outbound upstream calls.
 *
 * Why this exists
 * ---------------
 * NCBI allows 3 requests/second without an API key and 10 with one. The
 * original client honoured that by running every call serially with a
 * `sleep(delayMs)` between them. That is safe but leaves most of the quota
 * unused: one in-flight request at a time means the achieved rate is
 * `1 / (delay + round-trip)`, i.e. ~2.5 req/s against a 10 req/s allowance,
 * because the round-trip dominates. A search over 50 variant representations
 * therefore took ~20s per database.
 *
 * A token bucket decouples *rate* from *concurrency*: tokens refill at the
 * permitted requests-per-second, and several requests may be in flight at once
 * so round-trip latency overlaps instead of accumulating. The achieved rate is
 * capped by the bucket, not by network latency.
 *
 * Scope and limitations
 * ---------------------
 * The bucket is module-level, so it governs one server instance. NCBI's quota
 * is per API key / per IP, and a serverless deployment can run several
 * instances concurrently, so this is not a distributed guarantee. It is a large
 * improvement over no coordination at all (the previous code had none across
 * concurrent requests either), and the real backstop remains unchanged: 429
 * responses are retried with `Retry-After` honoured. Default rates leave
 * deliberate headroom below the documented ceiling for that reason.
 */

export interface LimiterOptions {
  /** Sustained requests per second. */
  ratePerSec: number;
  /** Maximum requests in flight at once. */
  concurrency: number;
  /** Burst capacity; defaults to `concurrency`. */
  burst?: number;
}

/**
 * Token bucket with a concurrency ceiling. Tokens accrue continuously at
 * `ratePerSec` up to `burst`; `schedule()` resolves once a token is available
 * and a concurrency slot is free.
 */
export class RateLimiter {
  private readonly ratePerSec: number;
  private readonly concurrency: number;
  private readonly burst: number;

  private tokens: number;
  private lastRefill: number;
  private inFlight = 0;
  /** Waiters that need a token and a concurrency slot (new work). */
  private slotWaiters: (() => void)[] = [];
  /** Waiters that need only a token, already holding a slot (retries). */
  private tokenWaiters: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: LimiterOptions) {
    this.ratePerSec = Math.max(0.1, opts.ratePerSec);
    this.concurrency = Math.max(1, Math.floor(opts.concurrency));
    this.burst = Math.max(1, Math.floor(opts.burst ?? opts.concurrency));
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  /** Accrue tokens for the time elapsed since the last refill. */
  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefill = now;
  }

  /** Milliseconds until at least one whole token is available. */
  private msUntilToken(): number {
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }

  /**
   * Hand out tokens and concurrency slots to as many queued waiters as the
   * budget currently allows, then arm a timer for the next refill if any
   * waiters remain.
   */
  private pump(): void {
    this.refill();

    // Token-only waiters go first. They are retries that already hold a
    // concurrency slot, so queueing them behind new work would leave that slot
    // idle while they wait.
    while (this.tokenWaiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.tokenWaiters.shift()!();
    }

    while (
      this.slotWaiters.length > 0 &&
      this.inFlight < this.concurrency &&
      this.tokens >= 1
    ) {
      this.tokens -= 1;
      this.inFlight += 1;
      this.slotWaiters.shift()!();
    }

    this.arm();
  }

  /** Schedule the next pump when waiters remain that only time can release. */
  private arm(): void {
    if (this.timer) return;
    if (this.tokenWaiters.length === 0 && this.slotWaiters.length === 0) return;
    // Slot waiters blocked purely on concurrency are released by a completing
    // request, not by the clock.
    if (this.tokenWaiters.length === 0 && this.inFlight >= this.concurrency) return;

    const wait = Math.max(1, this.msUntilToken());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, wait);
    // Deliberately not unref'd: this timer is the only thing that will release
    // token-blocked waiters, so letting the event loop exit while it is pending
    // would abandon queued work and leave its promises unsettled.
  }

  /**
   * Run `fn` once the rate and concurrency budget allows. Rejections from `fn`
   * propagate to the caller; the concurrency slot is released either way.
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      this.pump();
    }
  }

  /**
   * Wait for one token without taking a concurrency slot.
   *
   * This is what a retry needs: the caller is already inside `schedule()` and
   * holds a slot, so calling `schedule()` again would wait for a second slot
   * and deadlock once every slot is held by a retrying request. Each retry is
   * still a real request against the quota, so it must wait its turn rather
   * than fire immediately.
   */
  async acquireToken(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.tokenWaiters.push(resolve);
      this.pump();
    });
  }

  /** Introspection for tests and diagnostics. */
  stats(): {
    ratePerSec: number;
    concurrency: number;
    queued: number;
    inFlight: number;
  } {
    return {
      ratePerSec: this.ratePerSec,
      concurrency: this.concurrency,
      queued: this.slotWaiters.length + this.tokenWaiters.length,
      inFlight: this.inFlight,
    };
  }
}

/**
 * Run `tasks` through a limiter, preserving input order in the results.
 *
 * `fn` must not itself call `schedule()` on the same limiter: the outer call
 * holds a concurrency slot while the inner one waits for a free slot, which
 * deadlocks once the batch fills the ceiling. Batch already-scheduled helpers
 * with plain `Promise.all` instead.
 */
export async function mapWithLimiter<T, R>(
  limiter: RateLimiter,
  tasks: T[],
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return Promise.all(tasks.map((item, i) => limiter.schedule(() => fn(item, i))));
}

/**
 * Read a positive number from the environment.
 *
 * `Number(process.env.X ?? fallback)` is not equivalent: `??` only falls back
 * on undefined, so a defined-but-blank variable — the shape `.env.example`
 * uses and deployment dashboards commonly produce — yields `Number("") === 0`,
 * and a typo yields NaN. Both are silently destructive when the value is a
 * timeout or a size limit.
 */
export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * NCBI's documented ceiling is 10 requests/second with an API key and 3
 * without.
 *
 * Choosing the numbers: a token bucket admits at most `burst + ratePerSec`
 * requests in any one-second window, so `burst + ratePerSec` — not
 * `ratePerSec` alone — is what has to stay within the ceiling. Sustained rate
 * sits below it as well, leaving room for the retries that `consume()` charges
 * against the same budget.
 *
 * Concurrency is set independently and higher: it bounds how many requests are
 * in flight, which is what lets round-trip latency overlap. It is not the
 * constraint on rate, so a generous value costs nothing.
 */
function ncbiLimiterFor(hasApiKey: boolean): RateLimiter {
  return hasApiKey
    ? new RateLimiter({
        // 8 + 2 = 10 req/s worst case, 8 sustained.
        ratePerSec: envNumber("NCBI_RATE_PER_SEC", 8),
        concurrency: envNumber("NCBI_CONCURRENCY", 6),
        burst: envNumber("NCBI_BURST", 2),
      })
    : new RateLimiter({
        // 2 + 1 = 3 req/s worst case, 2 sustained.
        ratePerSec: envNumber("NCBI_RATE_PER_SEC_NO_KEY", 2),
        concurrency: envNumber("NCBI_CONCURRENCY_NO_KEY", 2),
        burst: envNumber("NCBI_BURST_NO_KEY", 1),
      });
}

// One limiter per credential class, created lazily and shared process-wide so
// that PubMed and ClinVar searches running concurrently draw on a single
// budget rather than each assuming the whole quota.
let keyedLimiter: RateLimiter | null = null;
let anonLimiter: RateLimiter | null = null;

export function entrezLimiter(hasApiKey: boolean): RateLimiter {
  if (hasApiKey) {
    keyedLimiter ??= ncbiLimiterFor(true);
    return keyedLimiter;
  }
  anonLimiter ??= ncbiLimiterFor(false);
  return anonLimiter;
}

/**
 * Europe PMC (EBI) publishes no hard numeric limit and asks for considerate
 * use. It is a different host with a different quota, so it gets its own
 * limiter rather than competing with NCBI's.
 */
let europePmcLimiterInstance: RateLimiter | null = null;

export function europePmcLimiter(): RateLimiter {
  europePmcLimiterInstance ??= new RateLimiter({
    ratePerSec: envNumber("EUROPEPMC_RATE_PER_SEC", 8),
    concurrency: envNumber("EUROPEPMC_CONCURRENCY", 5),
    burst: envNumber("EUROPEPMC_BURST", 2),
  });
  return europePmcLimiterInstance;
}

/** Test hook: drop cached limiters so options are re-read. */
export function __resetLimitersForTests(): void {
  keyedLimiter = null;
  anonLimiter = null;
  europePmcLimiterInstance = null;
}
