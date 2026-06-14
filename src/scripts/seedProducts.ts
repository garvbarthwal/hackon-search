import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../lib/db.js";

type RawProduct = {
  Image: string;
  Name: string;
  Price: number;
  Ratings: number | string;
  Review: number | string;
  Quantity: string;
  "Sub-Category": string;
  Category: string;
};

function toNum(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function main() {
  const file = path.resolve("tableConvert.com_epc695.json");
  console.log(`[seed] reading ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8")) as RawProduct[];
  console.log(`[seed] loaded ${data.length} products`);

  await prisma.product.deleteMany();

  // Simulate stock: ~85% in-stock so ranking has signal but composition isn't starved.
  const rows = data.map((p, i) => ({
    name: p.Name,
    image: p.Image,
    price: toNum(p.Price),
    rating: toNum(p.Ratings),
    reviews: Math.round(toNum(p.Review)),
    quantity: p.Quantity ?? "",
    subCategory: p["Sub-Category"] ?? "Unknown",
    category: p.Category ?? "Unknown",
    // deterministic pseudo-stock: 6/7 in stock, varies per row
    inStock: i % 7 !== 0,
  }));

  // Batch insert
  const BATCH = 1000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await prisma.product.createMany({ data: slice });
    console.log(`[seed] inserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }

  const total = await prisma.product.count();
  const inStock = await prisma.product.count({ where: { inStock: true } });
  console.log(`[seed] done. total=${total} inStock=${inStock}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
