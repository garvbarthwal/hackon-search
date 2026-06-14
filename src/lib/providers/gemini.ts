/**
 * Gemini LLM provider (generation only). Embeddings live in src/lib/gemini.ts
 * because they're shared regardless of which LLM provider is active.
 */
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey ?? "" });

const LLM_MODEL = process.env.GEMINI_LLM_MODEL ?? "gemini-2.5-flash-lite";

type Message = { role: "user" | "assistant"; content: string };

export async function generateJSON<T>(args: {
  system?: string;
  messages: Message[];
  schema: object;
  temperature?: number;
}): Promise<T> {
  const contents = args.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const res = await withRetry(() =>
    ai.models.generateContent({
      model: LLM_MODEL,
      contents,
      config: {
        systemInstruction: args.system,
        responseMimeType: "application/json",
        responseSchema: args.schema,
        temperature: args.temperature ?? 0.2,
      },
    }),
  );
  const text = res.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`gemini.generateJSON: invalid JSON from model: ${text.slice(0, 200)}`);
  }
}

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
      let delayMs = 2000 * Math.pow(2, i);
      const m = /Please retry in\s*([\d.]+)s/.exec(msg);
      if (m) delayMs = Math.max(delayMs, Math.ceil(parseFloat(m[1]) * 1000) + 500);
      if (/limit:\s*0/.test(msg) && i >= 1) throw err;
      console.warn(`[gemini-llm] ${status ?? "?"} retrying in ${delayMs}ms (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
