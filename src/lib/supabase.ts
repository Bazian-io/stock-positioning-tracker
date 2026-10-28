import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

function jwtRole(key: string): string | undefined {
  try {
    return JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")).role;
  } catch {
    return undefined;
  }
}

// The web app reads Supabase with the publishable key only. Its database role can read reference
// data, completed filings and the research views, and cannot write. Queries run on the server, so
// the key is never sent to the browser.
export function readOnlySupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (see .env.example)");
  if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    throw new Error("SUPABASE_PUBLISHABLE_KEY holds a secret key; the web app must use the publishable key");
  }
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
