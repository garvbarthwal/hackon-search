/**
 * Amazon Bedrock LLM provider — Nova Lite via Converse API.
 *
 * Structured output uses tool-call forcing: we declare a single "respond" tool
 * whose inputSchema is the caller's JSON schema, and force toolChoice to that
 * tool. Nova then returns the JSON as the tool's input args, no parsing of
 * free text needed.
 *
 * Auth: AWS_BEARER_TOKEN_BEDROCK is the Bedrock API key (long-term bearer token).
 * The SDK picks it up automatically as of @aws-sdk/client-bedrock-runtime v3.700+.
 */
import "dotenv/config";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message as BedrockMessage,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.BEDROCK_REGION ?? "us-east-1";
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-lite-v1:0";

const client = new BedrockRuntimeClient({ region: REGION });

type Message = { role: "user" | "assistant"; content: string };

export async function generateJSON<T>(args: {
  system?: string;
  messages: Message[];
  schema: object;
  temperature?: number;
}): Promise<T> {
  const messages: BedrockMessage[] = args.messages.map((m) => ({
    role: m.role,
    content: [{ text: m.content }],
  }));

  const tool: Tool = {
    toolSpec: {
      name: "respond",
      description: "Return a structured response matching the required schema.",
      // DocumentType is a recursive union — our schema is a plain JSON object,
      // safe to pass as-is.
      inputSchema: { json: args.schema as never },
    },
  };

  const cmd = new ConverseCommand({
    modelId: MODEL_ID,
    messages,
    system: args.system ? [{ text: args.system }] : undefined,
    toolConfig: {
      tools: [tool],
      toolChoice: { tool: { name: "respond" } },
    },
    inferenceConfig: {
      temperature: args.temperature ?? 0.2,
      maxTokens: 2048,
    },
  });

  const res = await withRetry(() => client.send(cmd));

  const blocks = res.output?.message?.content ?? [];
  for (const block of blocks) {
    if (block.toolUse?.input) {
      return block.toolUse.input as T;
    }
  }

  // Fallback: some models return JSON in text even when tool-forced.
  for (const block of blocks) {
    if (block.text) {
      try {
        // Strip markdown fences if present.
        const cleaned = block.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
        return JSON.parse(cleaned) as T;
      } catch {
        // continue
      }
    }
  }

  throw new Error(
    `bedrock.generateJSON: no tool-use or parseable JSON in response. stopReason=${res.stopReason}`,
  );
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const code = e?.$metadata?.httpStatusCode;
      const retriable =
        e?.name === "ThrottlingException" ||
        e?.name === "ServiceUnavailableException" ||
        code === 429 ||
        (code !== undefined && code >= 500);
      if (!retriable) throw err;
      const delay = 1000 * Math.pow(2, i);
      console.warn(`[bedrock] ${e?.name ?? code} retrying in ${delay}ms (${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
