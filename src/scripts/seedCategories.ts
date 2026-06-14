import "dotenv/config";
import { prisma } from "../lib/db.js";
import { embedTexts, toPgVector } from "../lib/gemini.js";
import { llm } from "../lib/llm.js";

type DescBatch = { name: string; description: string }[];

const BATCH_DESC = 30;
const BATCH_EMBED = 50;

async function main() {
  // Gather distinct sub-categories with parent + sample product names for grounding.
  // A sub-category name can appear under multiple parents (e.g. "Combos" under
  // "Munchies" and "Sweet Cravings"). Dedupe by name — keep the parent with the
  // most products, sum the counts.
  const raw = await prisma.product.groupBy({
    by: ["subCategory", "category"],
    _count: { _all: true },
  });

  const byName = new Map<string, { subCategory: string; category: string; count: number; topCount: number }>();
  for (const r of raw) {
    const cur = byName.get(r.subCategory);
    if (!cur) {
      byName.set(r.subCategory, {
        subCategory: r.subCategory,
        category: r.category,
        count: r._count._all,
        topCount: r._count._all,
      });
    } else {
      cur.count += r._count._all;
      if (r._count._all > cur.topCount) {
        cur.category = r.category;
        cur.topCount = r._count._all;
      }
    }
  }
  const groups = [...byName.values()];

  console.log(`[cat] found ${groups.length} sub-categories (deduped from ${raw.length})`);

  // Sample product names per sub-category — gives the LLM grounding for tight descriptions.
  const samples = new Map<string, string[]>();
  for (const g of groups) {
    const rows = await prisma.product.findMany({
      where: { subCategory: g.subCategory },
      select: { name: true },
      orderBy: { reviews: "desc" },
      take: 6,
    });
    samples.set(g.subCategory, rows.map((r) => r.name));
  }

  // Step 1: generate descriptions in batches via Gemini JSON mode.
  const descSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
          },
          required: ["name", "description"],
        },
      },
    },
    required: ["items"],
  };

  const descriptions = new Map<string, string>();
  for (let i = 0; i < groups.length; i += BATCH_DESC) {
    const batch = groups.slice(i, i + BATCH_DESC);
    const payload = batch.map((g) => ({
      subCategory: g.subCategory,
      parentCategory: g.category,
      sampleProducts: samples.get(g.subCategory) ?? [],
    }));

    const prompt = [
      "You are building a semantic index for an Indian quick-commerce shopping app.",
      "For each sub-category, write ONE compact description (1-2 sentences, max 30 words).",
      "Capture: what kinds of products it contains, typical use cases, occasions, meal contexts.",
      "Use natural shopping language a customer would use ('movie night', 'breakfast', 'baby care', 'cleaning').",
      "Return JSON: { items: [{ name, description }] } — name MUST exactly match the input subCategory.",
      "",
      "INPUT:",
      JSON.stringify(payload, null, 2),
    ].join("\n");

    const out = await llm.generateJSON<{ items: DescBatch }>({
      messages: [{ role: "user", content: prompt }],
      schema: descSchema,
    });
    for (const item of out.items) {
      descriptions.set(item.name, item.description);
    }
    console.log(`[cat] described ${Math.min(i + BATCH_DESC, groups.length)}/${groups.length}`);
  }

  // Fallback for any sub-cat the LLM missed
  for (const g of groups) {
    if (!descriptions.has(g.subCategory)) {
      descriptions.set(
        g.subCategory,
        `${g.subCategory} products in the ${g.category} aisle.`,
      );
    }
  }

  // Step 2: embed each "name + description" — name carries the literal token, description carries semantics.
  const names: string[] = [];
  const texts: string[] = [];
  for (const g of groups) {
    names.push(g.subCategory);
    texts.push(`${g.subCategory}. ${descriptions.get(g.subCategory) ?? ""}`);
  }

  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_EMBED) {
    const slice = texts.slice(i, i + BATCH_EMBED);
    const vs = await embedTexts(slice);
    vectors.push(...vs);
    console.log(`[cat] embedded ${Math.min(i + BATCH_EMBED, texts.length)}/${texts.length}`);
  }

  // Step 3: upsert. SubCategory.embedding is vector(768) — Prisma client doesn't speak vector,
  // so we use raw SQL with the pgvector text literal format ([v1,v2,...]).
  await prisma.$executeRawUnsafe(`TRUNCATE "SubCategory" RESTART IDENTITY`);

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const desc = descriptions.get(g.subCategory) ?? "";
    const vec = toPgVector(vectors[i]);
    await prisma.$executeRaw`
      INSERT INTO "SubCategory" (name, category, description, "productCount", embedding)
      VALUES (${g.subCategory}, ${g.category}, ${desc}, ${g.count}, ${vec}::vector)
    `;
  }

  console.log(`[cat] done. ${groups.length} sub-categories indexed.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
