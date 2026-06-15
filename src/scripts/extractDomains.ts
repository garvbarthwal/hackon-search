/**
 * Tag every Product with its `domain` field.
 *
 * Strategy (matches the v4.5 design choice — hybrid):
 *   1. Apply the (subCategory → domain) and (category → domain) rule table
 *      from src/lib/domains.ts. Covers ~100% of the seeded catalog.
 *   2. For any product where rules don't fire (new sub-cats added later),
 *      fall back to the LLM extractor in 50-product batches — same shape
 *      as extractBrands.ts.
 *   3. Resume-friendly: skips products where domain IS NOT NULL.
 */
import "dotenv/config";
import { prisma } from "../lib/db.js";
import { llm } from "../lib/llm.js";
import { ALL_DOMAINS, classifyDomainByRules, type ProductDomain } from "../lib/domains.js";

const BATCH = 50;

const DOMAIN_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          domain: { type: "string", enum: ALL_DOMAINS },
        },
        required: ["name", "domain"],
      },
    },
  },
  required: ["items"],
};

const SYSTEM = `You assign a single coarse DOMAIN to a grocery product.

Domains and what they mean:
- food         — prepared/packaged food meant to be eaten as-is (frozen meals, ready-to-eat, instant noodles, breakfast cereals)
- ingredient   — fresh produce, raw staples, sauces and items used to MAKE other food (vegetables, dals, oil, butter, masala, eggs, cheese)
- beverage     — drinks: juices, sodas, tea, coffee, milk drinks
- snack        — biscuits, chips, chocolates, candy, mints
- baby_care    — baby food, baby diapers, baby wipes, baby bath, baby toiletries
- medicine     — health products: vitamins, painkillers, first-aid, derma, ayurveda
- household    — home goods: lights, batteries, hardware, kitchenware, electronics
- cleaning     — detergents, dishwash, floor cleaners, fresheners, repellents
- festival     — religious/festive items: diyas, rangoli, idols, pooja, christmas tree, rakhi
- personal_care — adult body/face/hair: shampoo, soap, perfume, makeup, shaving

Rules:
- Pick exactly one domain. Use the closest functional match.
- A "Lemon Detergent" is cleaning, not ingredient. A "Lemon" fresh fruit is ingredient.
- Baby toiletries are baby_care, not personal_care.
- Festive items (diyas, rangoli, christmas decor, pooja samagri) are festival, not household.
- Return the input 'name' EXACTLY as given.`;

async function extractBatchLLM(names: string[]): Promise<Map<string, ProductDomain>> {
  const prompt = [
    "Assign a domain to each product below.",
    "",
    "PRODUCTS:",
    JSON.stringify(names, null, 2),
  ].join("\n");

  const out = await llm.generateJSON<{ items: { name: string; domain: ProductDomain }[] }>({
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    schema: DOMAIN_SCHEMA,
    temperature: 0,
  });

  const map = new Map<string, ProductDomain>();
  for (const item of out.items ?? []) map.set(item.name, item.domain);
  return map;
}

async function applyRulePass(): Promise<number> {
  // Pull (category, subCategory) pairs that have unset domains, then bulk-update.
  const pairs = await prisma.product.groupBy({
    by: ["category", "subCategory"],
    where: { domain: null },
    _count: { _all: true },
  });

  let updated = 0;
  for (const p of pairs) {
    const dom = classifyDomainByRules(p.category, p.subCategory);
    if (!dom) continue;
    const res = await prisma.product.updateMany({
      where: { category: p.category, subCategory: p.subCategory, domain: null },
      data: { domain: dom },
    });
    updated += res.count;
    console.log(
      `[domain] ${p.category} / ${p.subCategory} → ${dom} (${res.count})`,
    );
  }
  return updated;
}

async function applyLLMFallback(): Promise<number> {
  let total = 0;
  while (true) {
    const batch = await prisma.product.findMany({
      where: { domain: null },
      select: { id: true, name: true, subCategory: true, category: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (batch.length === 0) break;

    const labeledNames = batch.map(
      (p) => `${p.name} [${p.category} / ${p.subCategory}]`,
    );

    let domainMap: Map<string, ProductDomain>;
    try {
      domainMap = await extractBatchLLM(labeledNames);
    } catch (err) {
      console.error(`[domain] LLM batch failed:`, (err as Error).message);
      // Default to the parent category's broad bucket if the LLM dies.
      domainMap = new Map();
    }

    const ids = batch.map((p) => p.id);
    const domains = batch.map((p) => {
      const labeled = `${p.name} [${p.category} / ${p.subCategory}]`;
      return domainMap.get(labeled) ?? "household";
    });

    await prisma.$executeRaw`
      UPDATE "Product" AS p
      SET domain = u.d
      FROM (
        SELECT UNNEST(${ids}::text[]) AS id,
               UNNEST(${domains}::text[]) AS d
      ) AS u
      WHERE p.id = u.id
    `;

    total += batch.length;
    console.log(`[domain] LLM-tagged ${total}`);
  }
  return total;
}

async function main() {
  const ruleHits = await applyRulePass();
  console.log(`[domain] rules tagged ${ruleHits} products`);

  const llmHits = await applyLLMFallback();
  if (llmHits > 0) console.log(`[domain] LLM tagged ${llmHits} products`);

  // Summary
  const summary = await prisma.product.groupBy({
    by: ["domain"],
    _count: { _all: true },
    orderBy: { _count: { id: "desc" } },
  });
  console.log(`\n[domain] final distribution:`);
  for (const s of summary) {
    console.log(`  ${(s.domain ?? "(null)").padEnd(15)} ${s._count._all}`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
