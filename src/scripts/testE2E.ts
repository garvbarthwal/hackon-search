import "dotenv/config";
import { generateCart } from "../lib/pipeline.js";
import { prisma } from "../lib/db.js";

const QUERIES = [
  "Movie night snacks for 5 people with savory and sweet taste",
  "Baby food and diapers",
  "Healthy breakfast for 2 people",
];

async function main() {
  for (const q of QUERIES) {
    console.log("\n" + "=".repeat(80));
    console.log("QUERY:", q);
    console.log("=".repeat(80));
    const t0 = performance.now();
    const out = await generateCart(q);
    const ms = Math.round(performance.now() - t0);

    console.log(`\nIntent:`, out.intent);
    console.log(`Sub-categories: ${out.selectedCategories.join(", ")}`);
    console.log(`\nCart (${out.cart.length} items):`);
    for (const item of out.cart) {
      console.log(`  · [${item.subCategory}] ${item.name} — ₹${item.price} (${item.quantity})`);
      if (item.reason) console.log(`      reason: ${item.reason}`);
    }
    if (out.removed.length) {
      console.log(`\nValidator removed:`);
      for (const r of out.removed) console.log(`  · ${r.name} — ${r.reason}`);
    }
    console.log(`\nReasoning:`);
    for (const r of out.reasoning) console.log(`  - ${r}`);
    console.log(`\n[${ms} ms]`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
