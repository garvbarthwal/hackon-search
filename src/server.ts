import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSmartCart } from "./lib/orchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "..", "public")));

app.post("/api/cart", async (req, res) => {
  const query = (req.body?.query ?? "").toString().trim();
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  try {
    const result = await generateSmartCart(query);
    res.json(result);
  } catch (err) {
    console.error("[api/cart] error:", err);
    res.status(500).json({ error: (err as Error).message });
  }
});

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
});
