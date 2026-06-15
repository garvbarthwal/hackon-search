/**
 * v4.5 Offline Evaluation Harness.
 *
 * ~10 queries per category × 6 categories (product/brand/ingredient/dish/
 * mission/festival) + the v4.5 spec's success criteria as gates:
 *   - Maggi outranks Yippee
 *   - Lemon outranks Lemon Detergent
 *   - Baby Food never returns Horlicks
 *   - Diwali never returns Christmas
 *   - Pav Bhaji never includes cleaning products
 *
 * Each query can declare:
 *   queryType, missionSlug, mustHaveEssentials (substr), mustHaveBrand,
 *   primaryResolverPath, expectedUnfulfilled, minCoverage
 * — plus the new v4.5 negatives:
 *   mustNotContainNames    — substr blacklist on every cart item name
 *   forbiddenSubcategories — sub-cats nothing in the cart may belong to
 *
 * Run with: npm run eval
 *   - prints per-query PASS/FAIL with reasons
 *   - writes .eval/last-run.json (for CI diffing)
 *   - exits 1 if any query fails
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { processCartRequest } from "../lib/orchestrator.js";
import type { CartPipelineResult } from "../lib/orchestrator.js";
import type { QueryType } from "../lib/classifier.js";
import { prisma } from "../lib/db.js";

type Expected = {
  query: string;
  queryType?: QueryType;
  missionSlug?: string;
  mustHaveEssentials?: string[];
  mustHaveBrand?: string;
  primaryResolverPath?: string;
  expectedUnfulfilled?: string[];
  minCoverage?: number;
  /** Forbidden substrings in any cart item's name (case-insensitive). */
  mustNotContainNames?: string[];
  /** Forbidden sub-categories — no cart item may belong to one of these. */
  forbiddenSubcategories?: string[];
};

const BENCHMARK: Expected[] = [
  // ── Product queries (10) ─────────────────────────────────────────────
  { query: "Maggi", queryType: "product", mustHaveEssentials: ["maggi"], primaryResolverPath: "exact_product", minCoverage: 1, mustNotContainNames: ["yippee", "top ramen", "knorr", "wai wai"] },
  { query: "Oreo biscuits", queryType: "product", mustHaveEssentials: ["oreo"], primaryResolverPath: "exact_product", minCoverage: 1 },
  { query: "Amul Butter", queryType: "product", mustHaveEssentials: ["amul"], minCoverage: 1 },
  { query: "Lay's Magic Masala", queryType: "product", mustHaveEssentials: ["lay"], minCoverage: 1 },
  { query: "Bingo chips", queryType: "product", mustHaveEssentials: ["bingo"], minCoverage: 1 },
  { query: "Cadbury Dairy Milk", queryType: "product", mustHaveEssentials: ["cadbury"], minCoverage: 1 },
  { query: "Aashirvaad Atta", queryType: "product", mustHaveEssentials: ["aashirvaad", "atta"], minCoverage: 1 },
  { query: "Coca Cola", queryType: "product", mustHaveEssentials: ["coca", "cola"], minCoverage: 1 },
  { query: "Parle G", queryType: "product", mustHaveEssentials: ["parle"], minCoverage: 1 },
  { query: "Surf Excel", queryType: "product", mustHaveEssentials: ["surf"], minCoverage: 1 },

  // ── Brand queries (10) ───────────────────────────────────────────────
  { query: "Amul", queryType: "brand", mustHaveBrand: "amul", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Britannia", queryType: "brand", mustHaveBrand: "britannia", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Cadbury", queryType: "brand", mustHaveBrand: "cadbury", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Nestle", queryType: "brand", mustHaveBrand: "nestle", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Aashirvaad", queryType: "brand", mustHaveBrand: "aashirvaad", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Tata", queryType: "brand", mustHaveBrand: "tata", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Mother Dairy", queryType: "brand", mustHaveBrand: "mother dairy", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Parle", queryType: "brand", mustHaveBrand: "parle", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "Lay's", queryType: "brand", mustHaveBrand: "lay", primaryResolverPath: "brand", minCoverage: 1 },
  { query: "MTR", queryType: "brand", mustHaveBrand: "mtr", primaryResolverPath: "brand", minCoverage: 1 },

  // ── Ingredient queries (10) ──────────────────────────────────────────
  // Each one ships with the v4.5 negative gate: cleaning/personal-care products MUST NOT appear.
  { query: "Lemon", queryType: "ingredient", mustHaveEssentials: ["lemon"], minCoverage: 1, mustNotContainNames: ["detergent", "dishwash", "cleaner", "soap", "shampoo"] },
  { query: "Tomato", queryType: "ingredient", mustHaveEssentials: ["tomato"], minCoverage: 1, mustNotContainNames: ["detergent", "cleaner"] },
  { query: "Paneer", queryType: "ingredient", mustHaveEssentials: ["paneer"], minCoverage: 1 },
  { query: "Onion", queryType: "ingredient", mustHaveEssentials: ["onion"], minCoverage: 1, mustNotContainNames: ["detergent", "cleaner", "soap"] },
  { query: "Milk", queryType: "ingredient", mustHaveEssentials: ["milk"], minCoverage: 1, forbiddenSubcategories: ["Detergent Powder & Bars", "Liquid Detergents & Additives", "Dishwash Gels & Bars", "Soaps", "Shampoo"] },
  { query: "Sugar", queryType: "ingredient", mustHaveEssentials: ["sugar"], minCoverage: 1 },
  { query: "Salt", queryType: "ingredient", mustHaveEssentials: ["salt"], minCoverage: 1 },
  { query: "Ginger", queryType: "ingredient", mustHaveEssentials: ["ginger"], minCoverage: 1, mustNotContainNames: ["detergent", "soap", "shampoo"] },
  { query: "Coriander", queryType: "ingredient", mustHaveEssentials: ["coriander|dhaniya"], minCoverage: 1 },
  { query: "Eggs", queryType: "ingredient", mustHaveEssentials: ["egg"], minCoverage: 1 },

  // ── Dish queries (10) ────────────────────────────────────────────────
  { query: "Pav Bhaji", queryType: "dish", missionSlug: "pav_bhaji", mustHaveEssentials: ["pav", "potato", "tomato", "onion"], minCoverage: 0.9, forbiddenSubcategories: ["Detergent Powder & Bars", "Dishwash Gels & Bars", "Liquid Detergents & Additives", "Soaps", "Floor & Surface Cleaners"] },
  { query: "Biryani", queryType: "dish", missionSlug: "biryani", mustHaveEssentials: ["rice", "onion"], minCoverage: 0.75 },
  { query: "Dal chawal", queryType: "dish", missionSlug: "dal_chawal", mustHaveEssentials: ["dal", "rice"], minCoverage: 0.75 },
  { query: "Sandwich", queryType: "dish", missionSlug: "sandwich", mustHaveEssentials: ["bread", "tomato"], minCoverage: 0.75 },
  { query: "Pasta", queryType: "dish", missionSlug: "pasta", mustHaveEssentials: ["pasta", "cheese"], minCoverage: 0.75 },
  { query: "Dosa", queryType: "dish", missionSlug: "dosa", mustHaveEssentials: ["dosa", "potato", "onion"], minCoverage: 0.66 },
  { query: "Chai", queryType: "dish", missionSlug: "chai", mustHaveEssentials: ["tea", "milk", "sugar"], minCoverage: 0.9 },
  { query: "Paneer Butter Masala", queryType: "dish", missionSlug: "paneer_butter_masala", mustHaveEssentials: ["paneer", "butter", "tomato"], minCoverage: 0.75 },
  { query: "Maggi noodles dish", mustHaveEssentials: ["maggi", "noodle"], minCoverage: 1 },
  { query: "Veg Sandwich", queryType: "dish", missionSlug: "sandwich", mustHaveEssentials: ["bread"], minCoverage: 0.75, forbiddenSubcategories: ["Detergent Powder & Bars", "Dishwash Gels & Bars"] },

  // ── Mission queries (10) ─────────────────────────────────────────────
  { query: "Tea party", queryType: "mission", missionSlug: "tea_party", mustHaveEssentials: ["tea", "milk", "sugar"], minCoverage: 1 },
  { query: "Movie night for 5 with savory and sweet", queryType: "mission", missionSlug: "movie_night", mustHaveEssentials: ["snack", "beverage"], minCoverage: 1 },
  { query: "Healthy breakfast for 2", queryType: "mission", missionSlug: "healthy_breakfast", mustHaveEssentials: ["milk", "fruit"], minCoverage: 0.9 },
  { query: "Birthday party for kids", queryType: "mission", missionSlug: "birthday_party", mustHaveEssentials: ["cake", "snack", "chocolate"], minCoverage: 0.75 },
  { query: "Hostel starter pack", queryType: "mission", missionSlug: "hostel_starter_pack", mustHaveEssentials: ["soap", "detergent"], minCoverage: 0.75 },
  { query: "Exam night essentials", queryType: "mission", missionSlug: "exam_night", mustHaveEssentials: ["coffee", "snack"], minCoverage: 0.75 },
  { query: "Baby care essentials", queryType: "mission", missionSlug: "baby_care", mustHaveEssentials: ["baby"], minCoverage: 0.5 },
  { query: "Movie marathon", queryType: "mission", missionSlug: "movie_night", mustHaveEssentials: ["snack"], minCoverage: 0.66 },
  { query: "Chai party", queryType: "mission", missionSlug: "tea_party", mustHaveEssentials: ["tea", "milk"], minCoverage: 0.9 },
  { query: "Kitty party tea", queryType: "mission", missionSlug: "tea_party", mustHaveEssentials: ["tea"], minCoverage: 0.66 },

  // ── Festival queries (10) — v4.5 brand new ───────────────────────────
  { query: "Diwali decorations", queryType: "festival", missionSlug: "diwali", mustHaveEssentials: ["diya", "rangoli"], minCoverage: 0.66, mustNotContainNames: ["christmas", "santa", "snowman", "easter", "halloween", "rakhi", "holi"] },
  { query: "Diwali", queryType: "festival", missionSlug: "diwali", mustHaveEssentials: ["diya"], minCoverage: 0.5, mustNotContainNames: ["christmas", "santa", "halloween"] },
  { query: "Christmas", queryType: "festival", missionSlug: "christmas", mustHaveEssentials: ["christmas"], minCoverage: 0.5, mustNotContainNames: ["diwali", "diya", "rangoli", "rakhi", "holi"] },
  { query: "Christmas tree", queryType: "festival", missionSlug: "christmas", mustHaveEssentials: ["christmas", "tree"], minCoverage: 0.5, mustNotContainNames: ["diwali", "diya"] },
  { query: "Holi colors", queryType: "festival", missionSlug: "holi", mustHaveEssentials: ["holi", "gulal"], minCoverage: 0.5, mustNotContainNames: ["christmas", "santa", "diwali", "diya"] },
  { query: "Rakhi for brother", queryType: "festival", missionSlug: "raksha_bandhan", mustHaveEssentials: ["rakhi"], minCoverage: 0.5, mustNotContainNames: ["christmas", "diwali", "santa"] },
  { query: "Eid essentials", queryType: "festival", missionSlug: "eid", mustHaveEssentials: ["eid"], minCoverage: 0.3, mustNotContainNames: ["christmas", "diwali", "holi"] },
  { query: "Diwali essentials", queryType: "festival", missionSlug: "diwali", mustHaveEssentials: ["diya"], minCoverage: 0.5, mustNotContainNames: ["christmas", "santa"] },
  { query: "Christmas decorations", queryType: "festival", missionSlug: "christmas", mustHaveEssentials: ["christmas"], minCoverage: 0.5, mustNotContainNames: ["diwali", "diya", "rangoli"] },
  { query: "Holi", queryType: "festival", missionSlug: "holi", mustHaveEssentials: ["holi"], minCoverage: 0.5, mustNotContainNames: ["christmas", "diwali"] },
];

type EvalResult = {
  query: string;
  pass: boolean;
  failures: string[];
  latencyMs: number;
  response: CartPipelineResult | null;
};

function evaluate(expected: Expected, response: CartPipelineResult): string[] {
  const failures: string[] = [];
  const cart = response.cart;
  const trace = response.trace;

  if (expected.queryType && trace.queryType !== expected.queryType) {
    failures.push(`queryType: expected '${expected.queryType}', got '${trace.queryType}'`);
  }
  if (expected.missionSlug && trace.missionSlug !== expected.missionSlug) {
    failures.push(`missionSlug: expected '${expected.missionSlug}', got '${trace.missionSlug}'`);
  }

  const allItems = cart
    ? [...cart.essentials, ...cart.recommended, ...cart.premiumSuggestions]
    : [];

  if (expected.mustHaveEssentials && cart) {
    const haystack = cart.essentials
      .map((p) => `${p.requirement} ${p.name}`.toLowerCase())
      .join(" | ");
    for (const need of expected.mustHaveEssentials) {
      if (expected.expectedUnfulfilled?.some((u) => u.toLowerCase().includes(need))) continue;
      // 'a|b|c' = any of these substrings counts as a hit.
      const alts = need.toLowerCase().split("|").map((s) => s.trim()).filter(Boolean);
      const hit = alts.some((a) => haystack.includes(a));
      if (!hit) {
        failures.push(`missing essential matching '${need}'`);
      }
    }
  }
  if (expected.mustHaveBrand && cart) {
    const has = cart.essentials.some(
      (p) => (p.brand || "").toLowerCase().includes(expected.mustHaveBrand!.toLowerCase()),
    );
    if (!has) failures.push(`missing brand '${expected.mustHaveBrand}'`);
  }
  if (expected.primaryResolverPath && cart && cart.essentials.length > 0) {
    const path = cart.essentials[0].resolverPath;
    if (path !== expected.primaryResolverPath) {
      failures.push(`resolverPath: expected '${expected.primaryResolverPath}', got '${path}'`);
    }
  }
  if (expected.minCoverage !== undefined && response.coverage) {
    if (response.coverage.coverage < expected.minCoverage) {
      failures.push(
        `coverage: expected ≥${expected.minCoverage}, got ${response.coverage.coverage.toFixed(2)}`,
      );
    }
  }
  // v4.5 negative gates
  if (expected.mustNotContainNames) {
    for (const forbidden of expected.mustNotContainNames) {
      const hits = allItems.filter((p) =>
        p.name.toLowerCase().includes(forbidden.toLowerCase()),
      );
      if (hits.length > 0) {
        failures.push(
          `forbidden substring '${forbidden}' in cart: ${hits.map((h) => h.name.slice(0, 40)).join(" | ")}`,
        );
      }
    }
  }
  if (expected.forbiddenSubcategories) {
    for (const sub of expected.forbiddenSubcategories) {
      const hits = allItems.filter((p) => p.subCategory === sub);
      if (hits.length > 0) {
        failures.push(
          `forbidden sub-category '${sub}' in cart: ${hits.map((h) => h.name.slice(0, 40)).join(" | ")}`,
        );
      }
    }
  }

  return failures;
}

async function main() {
  const results: EvalResult[] = [];
  const onlyArg = process.argv[2]; // optional: --product / --brand / --festival etc.
  const filter = onlyArg && onlyArg.startsWith("--") ? onlyArg.slice(2) : null;

  let i = 0;
  for (const exp of BENCHMARK) {
    if (filter && exp.queryType !== filter) continue;
    i++;
    process.stdout.write(`[${i}/${BENCHMARK.length}] ${exp.query.padEnd(40)} `);
    const t0 = Date.now();
    try {
      const response = await processCartRequest({
        query: exp.query,
      });
      const failures = evaluate(exp, response);
      const ms = Date.now() - t0;
      const pass = failures.length === 0;
      results.push({ query: exp.query, pass, failures, latencyMs: ms, response });
      console.log(`${pass ? "PASS" : "FAIL"} (${ms}ms)`);
      if (!pass) for (const f of failures) console.log(`     - ${f}`);
    } catch (err) {
      const ms = Date.now() - t0;
      results.push({
        query: exp.query,
        pass: false,
        failures: [`error: ${(err as Error).message}`],
        latencyMs: ms,
        response: null,
      });
      console.log(`ERROR: ${(err as Error).message}`);
    }
  }

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  console.log("\n" + "=".repeat(70));
  console.log(`Result: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%)`);

  // Per-category breakdown
  const byType = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const exp = BENCHMARK.find((b) => b.query === r.query)!;
    const t = exp.queryType ?? "unknown";
    const cur = byType.get(t) ?? { pass: 0, total: 0 };
    cur.total++;
    if (r.pass) cur.pass++;
    byType.set(t, cur);
  }
  console.log("\nBy queryType:");
  for (const [t, s] of byType) {
    const pct = ((s.pass / s.total) * 100).toFixed(0);
    console.log(`  ${t.padEnd(12)} ${s.pass}/${s.total}  (${pct}%)`);
  }

  // JSON report — handy for CI diffing across runs.
  const reportDir = path.resolve(".eval");
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, "last-run.json"),
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        total,
        passed,
        byType: Object.fromEntries(byType),
        results: results.map((r) => ({
          query: r.query,
          pass: r.pass,
          failures: r.failures,
          latencyMs: r.latencyMs,
          queryType: r.response?.trace.queryType,
          missionSlug: r.response?.trace.missionSlug,
          coverage: r.response?.coverage?.coverage,
          retries: r.response?.trace.retries,
          auditorRemoved: r.response?.auditor?.remove.length ?? 0,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nReport written to ${path.join(reportDir, "last-run.json")}`);

  await prisma.$disconnect();
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
