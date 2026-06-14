/**
 * Extract brand from product names using the LLM in batches, then compute
 * Brand aggregates (productCount, avgRating, totalReviews, brandScore).
 *
 * - Resume-friendly: only re-extracts products with brand IS NULL.
 * - Idempotent: re-running computes Brand stats from scratch.
 * - Uses the configured LLM provider (Bedrock by default, Gemini if LLM_PROVIDER=gemini).
 */
import "dotenv/config";
import { prisma } from "../lib/db.js";
import { llm } from "../lib/llm.js";

type BrandRow = { name: string; brand: string };

const BATCH = 50;

const BRAND_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          brand: {
            type: "string",
            description: "Canonical brand name. 'Unknown' if no clear brand.",
          },
        },
        required: ["name", "brand"],
      },
    },
  },
  required: ["items"],
};

const SYSTEM = `You extract canonical brand names from grocery product names.

Rules:
- Return the canonical brand only (e.g. "Aashirvaad", "Maggi", "Lay's", "Cadbury", "Amul").
- Do NOT include sub-brands or product lines (e.g. "Lay's Magic Masala" → "Lay's", not "Lay's Magic Masala").
- For unbranded fresh produce or generic items, return "Generic".
- For products where you cannot identify a clear brand, return "Unknown".
- Use the same canonical spelling consistently across the batch (Lay's not Lays, Maggi not MAGGI, Aashirvaad not AASHIRVAAD).
- The 'name' field in your output MUST exactly match the input product name.`;

async function extractBatch(names: string[]): Promise<Map<string, string>> {
  const prompt = [
    "Extract the brand for each product name below.",
    "",
    "PRODUCTS:",
    JSON.stringify(names, null, 2),
  ].join("\n");

  const out = await llm.generateJSON<{ items: BrandRow[] }>({
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    schema: BRAND_SCHEMA,
    temperature: 0,
  });

  const map = new Map<string, string>();
  for (const item of out.items ?? []) map.set(item.name, item.brand);
  return map;
}

async function extractAll() {
  let done = 0;
  while (true) {
    const batch = await prisma.product.findMany({
      where: { brand: null },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;

    const names = [...new Set(batch.map((p) => p.name))];
    let brandMap: Map<string, string>;
    try {
      brandMap = await extractBatch(names);
    } catch (err) {
      console.error(`[brand] batch failed:`, (err as Error).message);
      // Mark these as Unknown so we don't retry forever.
      brandMap = new Map(names.map((n) => [n, "Unknown"]));
    }

    // Bulk update via UNNEST
    const ids = batch.map((p) => p.id);
    const brands = batch.map((p) => brandMap.get(p.name) ?? "Unknown");
    await prisma.$executeRaw`
      UPDATE "Product" AS p
      SET brand = u.b
      FROM (
        SELECT UNNEST(${ids}::text[]) AS id,
               UNNEST(${brands}::text[]) AS b
      ) AS u
      WHERE p.id = u.id
    `;

    done += batch.length;
    console.log(`[brand] extracted ${done}`);
  }
}

async function computeBrandStats() {
  console.log(`[brand] computing aggregates…`);
  await prisma.$executeRawUnsafe(`TRUNCATE "Brand"`);

  // avgRating / totalReviews / productCount per brand
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Brand" (name, "productCount", "avgRating", "totalReviews", "brandScore", "createdAt")
    SELECT
      COALESCE(brand, 'Unknown') AS name,
      COUNT(*)::int             AS "productCount",
      COALESCE(AVG(rating), 0)  AS "avgRating",
      COALESCE(SUM(reviews), 0)::int AS "totalReviews",
      0                          AS "brandScore",
      NOW()
    FROM "Product"
    WHERE brand IS NOT NULL
    GROUP BY COALESCE(brand, 'Unknown')
  `);

  // Compute brandScore: blend of avgRating and log(reviews) — both normalized to 0..1.
  // brandScore = 0.5 * (avgRating/5) + 0.5 * (ln(1+totalReviews) / max_ln(reviews))
  await prisma.$executeRawUnsafe(`
    WITH stats AS (
      SELECT MAX(LN(1 + "totalReviews")) AS max_log FROM "Brand"
    )
    UPDATE "Brand" b
    SET "brandScore" =
      0.5 * LEAST(GREATEST(b."avgRating" / 5.0, 0), 1) +
      0.5 * (CASE WHEN s.max_log = 0 THEN 0
                  ELSE LN(1 + b."totalReviews") / s.max_log END)
    FROM stats s
  `);

  const top = await prisma.brand.findMany({
    orderBy: { brandScore: "desc" },
    take: 20,
  });
  console.log(`[brand] top brands by score:`);
  for (const b of top) {
    console.log(
      `  ${b.brandScore.toFixed(3)}  ${b.name.padEnd(28)} (${b.productCount} prods, avg ${b.avgRating.toFixed(2)}★, ${b.totalReviews} reviews)`,
    );
  }
}

async function main() {
  await extractAll();
  await computeBrandStats();
  await prisma.$disconnect();
  console.log(`[brand] done.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
