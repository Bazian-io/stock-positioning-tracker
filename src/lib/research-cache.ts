import "server-only";
import { unstable_cache } from "next/cache";
import { gzipSync, gunzipSync } from "node:zlib";

export const RESEARCH_CACHE_TAG = "stock-positioning-tracker:research";
export const RESEARCH_CACHE_MAX_BYTES = 1_000_000; // Headroom for encoding below Next's 2 MiB item limit.
const REVALIDATE_SECONDS = 24 * 60 * 60;
const MAX_EXPANDED_BYTES = 8_000_000;

type CachedResult<Result> = { encoding: "json"; value: Result } | { encoding: "gzip"; value: string };

function nonFinite(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (value && typeof value === "object") {
    for (const key in value) if (nonFinite((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

export function researchCacheSecret(): string | undefined {
  const secret = process.env.RESEARCH_CACHE_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : undefined;
}

class UncachedResult extends Error {
  value: unknown;
  constructor(value: unknown) {
    super("Research result is not eligible for caching");
    this.value = value;
    // Next may log background revalidation failures. Never log the financial payload.
    Object.defineProperty(this, "value", { enumerable: false });
  }
}

// Cache completed calculations as well as their reads. Throwing inside unstable_cache prevents
// a write; returning the rejected value outside it preserves the existing page's fallback.
export function cacheResearch<Args extends unknown[], Result>(
  name: string,
  read: (...args: Args) => Promise<Result>,
  { cacheable = () => true, compress = false }: { cacheable?: (result: Result) => boolean; compress?: boolean } = {},
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    // Deployment safety policy, not a Next requirement: enable caching with secure expiry available.
    if (!researchCacheSecret()) return read(...args);
    let fresh: { value: Result } | undefined;
    const checked = async (...args: Args): Promise<CachedResult<Result>> => {
      const result = await read(...args);
      if (!cacheable(result) || nonFinite(result)) throw new UncachedResult(result);
      const json = JSON.stringify(result);
      if (json === undefined) throw new UncachedResult(result);
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > (compress ? MAX_EXPANDED_BYTES : RESEARCH_CACHE_MAX_BYTES)) throw new UncachedResult(result);
      // Large comparison tables repeat field names and financial states. Low-level gzip preserves
      // the full result while avoiding repeated downloads/calculations on every filter or page.
      const entry: CachedResult<Result> = compress && bytes > 100_000
        ? { encoding: "gzip", value: gzipSync(json, { level: 1 }).toString("base64") }
        : { encoding: "json", value: result };
      if (Buffer.byteLength(JSON.stringify(entry), "utf8") > RESEARCH_CACHE_MAX_BYTES) throw new UncachedResult(result);
      fresh = { value: result };
      return entry;
    };
    const cached = unstable_cache(checked, [
      RESEARCH_CACHE_TAG, "v2", name, process.env.SUPABASE_URL ?? "unconfigured",
      // Identifier selection uses today's date. A UTC rollover must select current tickers again.
      new Date().toISOString().slice(0, 10),
    ], { revalidate: REVALIDATE_SECONDS, tags: [RESEARCH_CACHE_TAG] });
    try {
      const entry = await cached(...args);
      if (fresh) return fresh.value; // A cold fill already has the complete decoded result.
      return entry.encoding === "gzip"
        ? JSON.parse(gunzipSync(Buffer.from(entry.value, "base64"), { maxOutputLength: MAX_EXPANDED_BYTES }).toString("utf8")) as Result
        : entry.value;
    } catch (error) {
      if (error instanceof UncachedResult) return error.value as Result;
      throw error;
    }
  };
}
