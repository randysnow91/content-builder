// One place to change the model every agent uses (docs/R2_BUILD-SPEC.md §2).
export const AGENT_MODEL = "claude-sonnet-5";

// The embedding model for the Reviewer's RAG check (docs/R2_BUILD-SPEC.md
// M3). Voyage's general-purpose model; 1024 is its output dimension - the
// pm_practices.embedding column is sized to match (see the M3 SQL).
export const EMBEDDING_MODEL = "voyage-3";
export const EMBEDDING_DIMENSIONS = 1024;

// How many practice documents the Reviewer retrieves per PM Perspective.
export const RAG_MATCH_COUNT = 4;
