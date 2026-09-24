import { getSupabaseClient } from "./supabaseClient";
import { RAG_MATCH_COUNT } from "./config";

export type RetrievedPractice = {
  id: string;
  content: string;
  similarity: number;
};

// Calls the match_pm_practices Postgres function (docs/R2_BUILD-SPEC.md M3
// SQL) - the actual vector similarity search. PostgREST can't do vector math
// through plain table queries, so this is a SQL function exposed as an RPC.
export async function retrieveRelevantPractices(
  queryEmbedding: number[],
  matchCount: number = RAG_MATCH_COUNT
): Promise<RetrievedPractice[]> {
  const { data, error } = await getSupabaseClient().rpc("match_pm_practices", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
  });

  if (error) {
    throw new Error(`match_pm_practices RPC failed: ${error.message}`);
  }

  return data as RetrievedPractice[];
}
