import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey || apiKey === "your-google-ai-studio-key") {
  console.warn("[gemini] GEMINI_API_KEY is not set in .env — calls will fail.");
}

export const genai = new GoogleGenAI({ apiKey: apiKey ?? "" });

export const LLM_MODEL = process.env.GEMINI_LLM_MODEL ?? "gemini-2.5-flash-lite";
export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001";

/** SubCategory.embedding column dimensionality (matches the migration). */
export const EMBED_DIM = 768;

/** Embed a batch of texts. Returns one vector per input, truncated to EMBED_DIM. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await withRetry(() =>
    genai.models.embedContent({
      model: EMBED_MODEL,
      contents: texts,
      config: { outputDimensionality: EMBED_DIM },
    }),
  );
  const out = (res.embeddings ?? []).map((e) => e.values ?? []);
  if (out.length !== texts.length) {
    throw new Error(`embedTexts: expected ${texts.length} vectors, got ${out.length}`);
  }
  // Matryoshka models (gemini-embedding-*) need re-normalization after truncation.
  return out.map(normalize);
}

function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embedTexts([text]);
  return v;
}

/** JSON-mode generation. Caller passes a schema; returns parsed object of type T. */
export async function generateJSON<T>(prompt: string, schema: object): Promise<T> {
  const res = await withRetry(() =>
    genai.models.generateContent({
      model: LLM_MODEL,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.2,
      },
    }),
  );
  const text = res.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`generateJSON: invalid JSON from model: ${text.slice(0, 200)}`);
  }
}

/** Format a JS number array as a pgvector literal: '[0.1,0.2,...]'. */
export function toPgVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

/** Retry on 429 / 5xx. Honors retryDelay from Gemini's error payload when present. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const status = /got status:\s*(\d+)/.exec(msg)?.[1];
      const retriable = status === "429" || status?.startsWith("5");
      if (!retriable) throw err;

      // Try to honor the retryDelay the API suggests
      let delayMs = 2000 * Math.pow(2, i);
      const m = /Please retry in\s*([\d.]+)s/.exec(msg);
      if (m) delayMs = Math.max(delayMs, Math.ceil(parseFloat(m[1]) * 1000) + 500);

      // limit:0 indicates a hard quota (no free tier on this project) — fail fast
      if (/limit:\s*0/.test(msg) && i >= 1) throw err;

      console.warn(`[gemini] ${status ?? "?"} — retrying in ${delayMs}ms (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
