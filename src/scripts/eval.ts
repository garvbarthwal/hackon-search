/**
 * v3.5 Offline Evaluation Harness.
 *
 * Hand-authored benchmark queries with expected outcomes per spec success criteria.
 * Run with: npm run eval
 *
 * Metrics:
 *  - classifierAccuracy: queryType matches expected
 *  - missionAccuracy:    when relevant, missionSlug matches expected
 *  - essentialPresence:  expected essentials present in cart
 *  - coverage:           ratio fulfilled / total
 *  - resolverPath:       expected primary resolver path was used
 */
import "dotenv/config";
import { processTurn } from "../lib/orchestrator.js";
import type { ChatTurnResponse } from "../lib/orchestrator.js";
import type { QueryType } from "../lib/classifier.js";
import { prisma } from "../lib/db.js";

type Expected = {
  query: string;
  queryType?: QueryType;
  missionSlug?: string;
  /** lowercase substrings — at least one essential's name OR requirement label must contain each. */
  mustHaveEssentials?: string[];
  /** lowercase brand expected in essentials (any item). */
  mustHaveBrand?: string;
  /** Resolver path the FIRST essential should use. */
  primaryResolverPath?: string;
  /** Acceptable to have unfulfilled essentials with these names (catalog gap). */
  expectedUnfulfilled?: string[];
  /** Coverage threshold: cart must meet at least this. */
  minCoverage?: number;
};

const BENCHMARK: Expected[] = [
  // ── Product queries ──────────────────────────────────────────────────
  {
    query: "Maggi",
    queryType: "product",
    mustHaveEssentials: ["maggi"],
    primaryResolverPath: "exact_product",
    minCoverage: 1,
  },
  {
    query: "Oreo biscuits",
    queryType: "product",
    mustHaveEssentials: ["oreo"],
    primaryResolverPath: "exact_product",
    minCoverage: 1,
  },
  {
    query: "Amul Butter",
    queryType: "product",
    mustHaveEssentials: ["amul"],
    minCoverage: 1,
  },
  {
    query: "Lay's Magic Masala",
    queryType: "product",
    mustHaveEssentials: ["lay"],
    minCoverage: 1,
  },

  // ── Brand queries ────────────────────────────────────────────────────
  {
    query: "Amul",
    queryType: "brand",
    mustHaveBrand: "amul",
    primaryResolverPath: "brand",
    minCoverage: 1,
  },
  {
    query: "Britannia",
    queryType: "brand",
    mustHaveBrand: "britannia",
    primaryResolverPath: "brand",
    minCoverage: 1,
  },

  // ── Ingredient queries ───────────────────────────────────────────────
  {
    query: "Lemon",
    queryType: "ingredient",
    mustHaveEssentials: ["lemon"],
    minCoverage: 1,
  },
  {
    query: "Tomato",
    queryType: "ingredient",
    mustHaveEssentials: ["tomato"],
    minCoverage: 1,
  },
  {
    query: "Paneer",
    queryType: "ingredient",
    mustHaveEssentials: ["paneer"],
    minCoverage: 1,
  },

  // ── Category queries ─────────────────────────────────────────────────
  {
    query: "Baby food and diapers",
    queryType: "category",
    mustHaveEssentials: ["baby food"],
    expectedUnfulfilled: ["diapers"],
    minCoverage: 0.5,
  },
  {
    query: "Chips and chocolates",
    queryType: "category",
    mustHaveEssentials: ["chip", "chocolate"],
    minCoverage: 1,
  },

  // ── Dish queries ─────────────────────────────────────────────────────
  {
    query: "Pav Bhaji",
    queryType: "dish",
    missionSlug: "pav_bhaji",
    mustHaveEssentials: ["pav", "potato", "tomato", "onion"],
    minCoverage: 0.9,
  },
  {
    query: "Biryani",
    queryType: "dish",
    missionSlug: "biryani",
    mustHaveEssentials: ["rice", "onion"],
    minCoverage: 0.75,
  },
  {
    query: "Maggi for hostel night",
    // 'dish' or 'mission' both acceptable — query is genuinely ambiguous
    // (Maggi-the-product vs hostel-starter-pack mission). Skip queryType check.
    mustHaveEssentials: ["maggi"],
    minCoverage: 1,
  },
  {
    query: "Dal chawal",
    queryType: "dish",
    missionSlug: "dal_chawal",
    mustHaveEssentials: ["dal", "rice"],
    minCoverage: 0.75,
  },

  // ── Mission queries ──────────────────────────────────────────────────
  {
    query: "Tea party",
    queryType: "mission",
    missionSlug: "tea_party",
    mustHaveEssentials: ["tea", "milk", "sugar"],
    minCoverage: 1,
  },
  {
    query: "Movie night for 5 with savory and sweet",
    queryType: "mission",
    missionSlug: "movie_night",
    mustHaveEssentials: ["snack", "beverage"], // matches Savory/Sweet Snack and Beverage
    minCoverage: 1,
  },
  {
    query: "Healthy breakfast for 2",
    queryType: "mission",
    missionSlug: "healthy_breakfast",
    mustHaveEssentials: ["milk", "fruit"],
    minCoverage: 0.9,
  },
  {
    query: "Birthday party for kids",
    queryType: "mission",
    missionSlug: "birthday_party",
    mustHaveEssentials: ["cake", "snack", "chocolate"],
    minCoverage: 0.75,
  },
];

type EvalResult = {
  query: string;
  pass: boolean;
  failures: string[];
  response: ChatTurnResponse;
};

function evaluate(expected: Expected, response: ChatTurnResponse): EvalResult {
  const failures: string[] = [];
  const cart = response.cart;
  const trace = response.trace;

  if (expected.queryType && trace.queryType !== expected.queryType) {
    failures.push(
      `queryType: expected '${expected.queryType}', got '${trace.queryType}'`,
    );
  }

  if (expected.missionSlug && trace.missionSlug !== expected.missionSlug) {
    failures.push(
      `missionSlug: expected '${expected.missionSlug}', got '${trace.missionSlug}'`,
    );
  }

  if (expected.mustHaveEssentials && cart) {
    const haystack = cart.essentials
      .map((p) => `${p.requirement} ${p.name}`.toLowerCase())
      .join(" | ");
    for (const need of expected.mustHaveEssentials) {
      // Allow it if it's in expectedUnfulfilled
      if (expected.expectedUnfulfilled?.some((u) => u.toLowerCase().includes(need))) continue;
      if (!haystack.includes(need.toLowerCase())) {
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
      failures.push(
        `resolverPath: expected '${expected.primaryResolverPath}', got '${path}'`,
      );
    }
  }

  if (expected.minCoverage !== undefined && response.coverage) {
    if (response.coverage.coverage < expected.minCoverage) {
      failures.push(
        `coverage: expected ≥${expected.minCoverage}, got ${response.coverage.coverage.toFixed(2)}`,
      );
    }
  }

  return { query: expected.query, pass: failures.length === 0, failures, response };
}

async function main() {
  const results: EvalResult[] = [];
  let i = 0;
  for (const exp of BENCHMARK) {
    i++;
    process.stdout.write(`[${i}/${BENCHMARK.length}] ${exp.query.padEnd(40)} `);
    const t0 = Date.now();
    try {
      const response = await processTurn({
        sessionId: `eval-${i}`,
        history: [],
        message: exp.query,
      });
      const r = evaluate(exp, response);
      results.push(r);
      const ms = Date.now() - t0;
      console.log(`${r.pass ? "PASS" : "FAIL"} (${ms}ms)`);
      if (!r.pass) {
        for (const f of r.failures) console.log(`     - ${f}`);
      }
    } catch (err) {
      results.push({
        query: exp.query,
        pass: false,
        failures: [`error: ${(err as Error).message}`],
        response: {} as ChatTurnResponse,
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
  for (let i = 0; i < BENCHMARK.length; i++) {
    const t = BENCHMARK[i].queryType ?? "unknown";
    const cur = byType.get(t) ?? { pass: 0, total: 0 };
    cur.total++;
    if (results[i].pass) cur.pass++;
    byType.set(t, cur);
  }
  console.log("\nBy queryType:");
  for (const [t, s] of byType) {
    console.log(`  ${t.padEnd(12)} ${s.pass}/${s.total}`);
  }

  await prisma.$disconnect();
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
