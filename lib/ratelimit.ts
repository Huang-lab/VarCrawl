/**
 * Per-client rate limiting using Upstash Redis (sliding-window).
 *
 * Keyed on the client IP (x-forwarded-for first hop, falling back to req.ip).
 * Graceful no-op if the Upstash env vars are not set, so local development
 * works without any external dependency — same pattern as lib/cache.ts.
 *
 * Configuration (all optional; defaults shown):
 *   RATE_LIMIT_MAX=20          requests allowed per window
 *   RATE_LIMIT_WINDOW="60 s"   window size, parsed by @upstash/ratelimit
 */

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { NextRequest } from "next/server";
import { envNumber } from "@/lib/entrez/scheduler";

const enabled = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

const max = envNumber("RATE_LIMIT_MAX", 20);
const windowStr = (process.env.RATE_LIMIT_WINDOW ?? "60 s") as `${number} ${
  | "ms"
  | "s"
  | "m"
  | "h"
  | "d"}`;

const limiter = enabled
  ? new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(max, windowStr),
      prefix: "varcrawl:rl",
      analytics: false,
    })
  : null;

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  // NextRequest.ip is populated by Vercel but not in all runtimes.
  const withIp = req as unknown as { ip?: string };
  return withIp.ip ?? "unknown";
}

export type RateLimitResult =
  | { success: true }
  | { success: false; retryAfterSec: number };

/**
 * Returns null when rate limiting is disabled (Upstash not configured).
 * Returns {success: true} when the request is allowed, otherwise
 * {success: false, retryAfterSec} so the caller can set Retry-After.
 */
export async function checkRateLimit(
  req: NextRequest,
): Promise<RateLimitResult | null> {
  if (!limiter) return null;
  try {
    const ip = clientIp(req);
    const r = await limiter.limit(ip);
    if (r.success) return { success: true };
    const retryAfterSec = Math.max(1, Math.ceil((r.reset - Date.now()) / 1000));
    return { success: false, retryAfterSec };
  } catch {
    // Fail-open on Upstash errors so a Redis outage doesn't take the app down.
    return null;
  }
}
