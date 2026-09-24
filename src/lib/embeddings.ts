import { EMBEDDING_MODEL } from "./config";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

type VoyageEmbeddingsResponse = {
  data: { embedding: number[]; index: number }[];
};

// "document" for corpus text being stored (seeding), "query" for text being
// searched with (the Reviewer's PM Perspective) - Voyage's models are tuned
// differently for each, so this matters for retrieval quality, not just
// bookkeeping.
type InputType = "document" | "query";

async function callVoyage(texts: string[], inputType: InputType): Promise<number[][]> {
  const apiKey = process.env.EMBEDDING_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error("EMBEDDING_PROVIDER_API_KEY is not set");
  }

  const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL, input_type: inputType }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Voyage embeddings request failed (${response.status}): ${body}`);
  }

  const parsed = (await response.json()) as VoyageEmbeddingsResponse;
  // Voyage returns results in the same order as the input array, but sorts
  // by its own `index` field - restore input order explicitly rather than
  // trusting that coincidence.
  return parsed.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedText(text: string, inputType: InputType): Promise<number[]> {
  const [embedding] = await callVoyage([text], inputType);
  return embedding;
}

export async function embedTexts(texts: string[], inputType: InputType): Promise<number[][]> {
  if (texts.length === 0) return [];
  return callVoyage(texts, inputType);
}
