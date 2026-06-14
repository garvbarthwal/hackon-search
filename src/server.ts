import "dotenv/config";
import express from "express";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { processTurn } from "./lib/orchestrator.js";
import type { ChatMessage } from "./lib/planner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "..", "public")));

// In-memory session store. Maps sessionId → conversation history.
// Survives only the lifetime of this server process.
type Session = {
  history: ChatMessage[];
  createdAt: number;
  lastActivity: number;
};
const SESSIONS = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min idle timeout

function gcSessions() {
  const now = Date.now();
  for (const [id, s] of SESSIONS) {
    if (now - s.lastActivity > SESSION_TTL_MS) SESSIONS.delete(id);
  }
}
setInterval(gcSessions, 60_000).unref?.();

app.post("/api/chat", async (req, res) => {
  const message = (req.body?.message ?? "").toString().trim();
  let sessionId = (req.body?.sessionId ?? "").toString();
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  if (!sessionId || !SESSIONS.has(sessionId)) {
    sessionId = randomUUID();
    SESSIONS.set(sessionId, {
      history: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
  }

  const session = SESSIONS.get(sessionId)!;
  session.lastActivity = Date.now();

  try {
    const out = await processTurn({
      sessionId,
      history: session.history,
      message,
    });

    // Append turn to history.
    session.history.push({ role: "user", content: message });
    session.history.push({ role: "assistant", content: out.reply });

    // If the planner went 'ready' or 'needs_user_input', we close out the
    // shopping mission — the next turn from the user starts fresh history.
    if (out.status === "ready") {
      session.history = [];
    }

    res.json(out);
  } catch (err) {
    console.error("[api/chat] error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/session/reset", (req, res) => {
  const sessionId = (req.body?.sessionId ?? "").toString();
  if (sessionId) SESSIONS.delete(sessionId);
  res.json({ ok: true });
});

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  console.log(`[server] LLM provider: ${process.env.LLM_PROVIDER ?? "bedrock"}`);
});
