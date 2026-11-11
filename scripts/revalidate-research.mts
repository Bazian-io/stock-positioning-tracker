// Explicit post-import step. This contacts the web app only; it never writes to Supabase.
export async function revalidateResearch(env: Record<string, string | undefined> = process.env, send: typeof fetch = fetch) {
  const secret = env.RESEARCH_CACHE_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("Set RESEARCH_CACHE_SECRET to a random secret of at least 32 characters");
  const url = new URL(env.RESEARCH_APP_URL ?? "");
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("RESEARCH_APP_URL must be an HTTPS origin (or local HTTP for testing), without credentials or a path");
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${secret}` };
  if (env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const response = await send(new URL("/api/revalidate", url), {
    method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Cache invalidation failed (HTTP ${response.status})`);
  const result = await response.json();
  if (result.revalidationRequested !== true) throw new Error("The server did not acknowledge cache invalidation");
}

if (import.meta.main) {
  try {
    await revalidateResearch();
    console.log("Research cache invalidation requested. Verify the updated data on the next page load.");
  } catch {
    // Do not print URLs, credentials, fetch errors or an authentication page's response body.
    console.error("Cache invalidation failed. Check the app URL, secret, deployment protection and server logs; then retry.");
    process.exitCode = 1;
  }
}
