import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Content Builder's own small pgvector project - a scoped exception to
// "no database" (docs/R2_BUILD-SPEC.md §1.2, architecture doc §11.2).
// Separate from EmailServer's Supabase project entirely.
//
// Uses the service_role key, not the anon key: this only ever runs
// server-side, never in a browser, and RLS is enabled on pm_practices with
// no policies (server-only by design) - the service key is what's allowed
// to bypass that.
//
// Built lazily rather than at import time: the Reviewer's practice-alignment
// check wraps its own use of this client in a try/catch (matching every
// other pipeline stage's "degrade, don't error" behavior - see
// generateDaily.ts and docs/R2_BUILD-SPEC.md §4.3). A missing/bad credential
// should fail that one check, not crash the whole server at startup.
let client: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    const url = process.env.CONTENT_BUILDER_SUPABASE_URL;
    const serviceKey = process.env.CONTENT_BUILDER_SUPABASE_SERVICE_KEY;
    if (!url || !serviceKey) {
      throw new Error("CONTENT_BUILDER_SUPABASE_URL / CONTENT_BUILDER_SUPABASE_SERVICE_KEY not set");
    }
    client = createClient(url, serviceKey);
  }
  return client;
}
