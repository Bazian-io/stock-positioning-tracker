import { createHash, timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";
import { RESEARCH_CACHE_TAG, researchCacheSecret } from "../../../lib/research-cache";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const secret = researchCacheSecret();
  if (!secret) return Response.json({ error: "Cache invalidation is not configured" }, { status: 503, headers });
  const authorization = request.headers.get("authorization") ?? "";
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  // All derived results depend on amendments, identifiers and sometimes other investors' holdings.
  revalidateTag(RESEARCH_CACHE_TAG, { expire: 0 });
  return Response.json({ revalidationRequested: true }, { headers });
}
