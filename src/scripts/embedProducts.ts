import "dotenv/config";
import { prisma } from "../lib/db.js";
import { embedTexts, toPgVector } from "../lib/gemini.js";

/**
 * Generate synthetic text per product and embed it.
 *
 * Format follows the v2 spec:
 *   Product: <name>
 *   Category: <category>
 *   SubCategory: <subCategory>
 *   Tags: <heuristic tags>
 *
 * Tags are derived from name keywords + sub-category — no description column exists.
 */

const TAG_RULES: { match: RegExp; tags: string[] }[] = [
  { match: /chips|crisps|wafers|kurkure|lays|bingo|doritos/i, tags: ["savory snack", "munchies", "tea-time"] },
  { match: /chocolate|kitkat|dairy milk|silk|ferrero|munch|5star|cadbury/i, tags: ["sweet snack", "chocolate", "dessert"] },
  { match: /cookie|biscuit|bourbon|oreo|hide.?seek|britannia|good day|parle/i, tags: ["sweet snack", "biscuit", "tea-time"] },
  { match: /namkeen|bhujia|mixture|sev|chivda|haldiram/i, tags: ["savory snack", "indian snack"] },
  { match: /popcorn|nachos|pretzel/i, tags: ["movie night", "savory snack"] },
  { match: /cake|pastry|brownie|muffin|donut/i, tags: ["dessert", "sweet snack", "tea-time"] },
  { match: /ice ?cream|kulfi|gelato/i, tags: ["dessert", "frozen", "sweet"] },
  { match: /milk|amul|mother dairy|paneer|curd|dahi|yogurt|butter|ghee|cheese/i, tags: ["dairy", "breakfast"] },
  { match: /bread|pav|bun|burger|loaf|toast/i, tags: ["bakery", "breakfast", "carb"] },
  { match: /tea|chai|teabag|darjeeling|assam/i, tags: ["beverage", "tea", "hot drink"] },
  { match: /coffee|nescafe|brew|bru/i, tags: ["beverage", "coffee", "hot drink"] },
  { match: /sugar|gud|jaggery|sweetener/i, tags: ["sweetener", "pantry essential"] },
  { match: /cola|pepsi|sprite|fanta|soda|soft drink|coke/i, tags: ["beverage", "cold drink", "fizzy"] },
  { match: /juice|tropicana|real|frooti|maaza/i, tags: ["beverage", "juice"] },
  { match: /water|aquafina|bisleri|kinley/i, tags: ["beverage", "hydration"] },
  { match: /diaper|pamper|huggies|mamy poko/i, tags: ["baby care", "diapers", "essential"] },
  { match: /baby food|cerelac|nan pro|lactogen|formula|nestum/i, tags: ["baby care", "baby food", "infant"] },
  { match: /baby (wipe|lotion|shampoo|oil|powder|soap|cream)/i, tags: ["baby care", "baby hygiene"] },
  { match: /atta|wheat flour|maida|besan|chakki/i, tags: ["staple", "cooking", "flour"] },
  { match: /rice|basmati|sona masoori/i, tags: ["staple", "cooking", "grain"] },
  { match: /dal|toor|moong|chana|masoor|urad|pulses/i, tags: ["staple", "protein", "cooking"] },
  { match: /oil|sunflower|mustard|olive oil|coconut oil/i, tags: ["staple", "cooking"] },
  { match: /salt|namak|haldi|turmeric|chilli|masala|spice|jeera|garam/i, tags: ["spice", "cooking", "pantry"] },
  { match: /tomato|onion|potato|aloo|pyaaz|capsicum|carrot|cabbage|cauliflower|brinjal/i, tags: ["vegetable", "fresh", "cooking"] },
  { match: /apple|banana|mango|orange|grape|pomegranate|kiwi/i, tags: ["fruit", "fresh"] },
  { match: /noodle|maggi|yippee|pasta|macaroni|spaghetti/i, tags: ["instant", "quick meal"] },
  { match: /sauce|ketchup|mayo|mustard sauce|chutney/i, tags: ["condiment", "sauce"] },
  { match: /soap|shampoo|conditioner|body wash|toothpaste|toothbrush/i, tags: ["hygiene", "personal care"] },
  { match: /detergent|surf|tide|ariel|cleaner|harpic|lizol|phenyl/i, tags: ["cleaning", "household"] },
  { match: /paper cup|tissue|napkin|disposable/i, tags: ["disposable", "party supply"] },
];

function deriveTags(p: { name: string; subCategory: string; category: string }): string[] {
  const tags = new Set<string>();
  tags.add(p.subCategory.toLowerCase());
  for (const r of TAG_RULES) if (r.match.test(p.name)) for (const t of r.tags) tags.add(t);
  return [...tags];
}

function buildSyntheticText(p: { name: string; subCategory: string; category: string }): string {
  const tags = deriveTags(p).join(" ");
  return [
    `Product: ${p.name}`,
    `Category: ${p.category}`,
    `SubCategory: ${p.subCategory}`,
    `Tags: ${tags}`,
  ].join(". ");
}

const BATCH_EMBED = 50;

async function main() {
  // Resume-friendly: only re-embed products that don't have an embedding yet.
  const remaining = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "Product" WHERE embedding IS NULL`,
  );
  const total = Number(remaining[0].count);
  console.log(`[embed] ${total} products without embeddings`);

  if (total === 0) {
    console.log(`[embed] all products already embedded.`);
    await prisma.$disconnect();
    return;
  }

  let done = 0;
  // Stream in chunks to keep memory bounded.
  const PAGE = 500;
  while (true) {
    // Resume by either: no synthetic text yet, OR synthetic text but no embedding.
    const batch = await prisma.$queryRawUnsafe<
      { id: string; name: string; subCategory: string; category: string }[]
    >(
      `
      SELECT id, name, "subCategory", category
      FROM "Product"
      WHERE embedding IS NULL
      ORDER BY id ASC
      LIMIT ${PAGE}
      `,
    );
    if (batch.length === 0) break;

    // Make sure synthetic text is persisted (idempotent).
    for (const p of batch) {
      const text = buildSyntheticText(p);
      await prisma.product.update({
        where: { id: p.id },
        data: { syntheticText: text },
      });
    }

    for (let i = 0; i < batch.length; i += BATCH_EMBED) {
      const slice = batch.slice(i, i + BATCH_EMBED);
      const texts = slice.map((p) => buildSyntheticText(p));
      const vectors = await embedTexts(texts);

      // Bulk update embeddings in a single statement using UNNEST.
      const ids = slice.map((p) => p.id);
      const vecLits = vectors.map(toPgVector);
      await prisma.$executeRaw`
        UPDATE "Product" AS p
        SET embedding = u.vec::vector
        FROM (
          SELECT UNNEST(${ids}::text[]) AS id,
                 UNNEST(${vecLits}::text[]) AS vec
        ) AS u
        WHERE p.id = u.id
      `;
      done += slice.length;
      console.log(`[embed] ${done}/${total}`);
    }
  }

  console.log(`[embed] done.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
