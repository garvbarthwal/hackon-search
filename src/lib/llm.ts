/**
 * LLM provider abstraction. Embedding stays on Gemini (catalog is already
 * 768-dim Gemini embeddings); only generation/JSON-output dispatches.
 *
 * Switch via LLM_PROVIDER env: "gemini" or "bedrock".
 */
import { generateJSON as geminiGenerateJSON } from "./providers/gemini.js";
import { generateJSON as bedrockGenerateJSON } from "./providers/bedrock.js";

export type LlmMessage = { role: "user" | "assistant"; content: string };

export interface LlmProvider {
  /**
   * Force the model to return a JSON object validated against `schema`.
   * `system` is an optional system instruction.
   * `messages` is the multi-turn history. For single-shot calls, pass one user message.
   */
  generateJSON<T>(args: {
    system?: string;
    messages: LlmMessage[];
    schema: object;
    temperature?: number;
  }): Promise<T>;
}

const provider = (process.env.LLM_PROVIDER ?? "bedrock").toLowerCase();

const impl: LlmProvider =
  provider === "gemini"
    ? { generateJSON: geminiGenerateJSON }
    : { generateJSON: bedrockGenerateJSON };

export const llm: LlmProvider = impl;
export const ACTIVE_PROVIDER = provider;
