import "dotenv/config";
import { generateSmartCart } from "../lib/orchestrator.js";
import { prisma } from "../lib/db.js";

const QUERIES = [
  "Tea party",
  "Pav bhaji",
  "Movie night snacks for 5",
  "Baby food and diapers",
  "Healthy breakfast for 2",
  "Maggi for hostel night",
];

const SUCCESS_CHECKS: Record<string, (out: any) => string | null> = {
  "Tea party": (o) => {
    const reqs = (o.cart.essentials || []).map((p: any) => p.requirement.toLowerCase());
    const need = ["tea", "milk", "sugar"];
    const missing = need.filter((n) => !reqs.some((x: string) => x.includes(n)));
    return missing.length === 0 ? null : `missing essential: ${missing.join(", ")}`;
  },
  "Pav bhaji": (o) => {
    const reqs = (o.cart.essentials || []).map((p: any) => p.requirement.toLowerCase());
    return reqs.some((n: string) => n.includes("pav")) ? null : "missing essential: Pav";
  },
  "Movie night snacks for 5": (o) => {
    const reqs = (o.cart.essentials || []).map((p: any) => p.requirement.toLowerCase());
    return reqs.some((n: string) => n.includes("beverage")) ? null : "missing essential: Beverage";
  },
  // Baby Care: pass if Diapers is either fulfilled in cart OR honestly reported unfulfilled
  // (catalog has no baby diapers — system correctly surfaces the gap).
  "Baby food and diapers": (o) => {
    const fulfilled = (o.cart.essentials || []).some((p: any) =>
      p.requirement.toLowerCase().includes("diaper"),
    );
    const honestlyUnfulfilled = (o.trace.unfulfilled || []).some((u: string) =>
      u.toLowerCase().includes("diaper"),
    );
    return fulfilled || honestlyUnfulfilled
      ? null
      : "Diapers neither fulfilled nor reported unfulfilled";
  },
};

function pad(s: string, n: number) {
  return s + " ".repeat(Math.max(0, n - s.length));
}

async function main() {
  for (const q of QUERIES) {
    console.log("\n" + "=".repeat(80));
    console.log(`QUERY: ${q}`);
    console.log("=".repeat(80));
    const t0 = performance.now();
    const out = await generateSmartCart(q);
    const ms = Math.round(performance.now() - t0);

    console.log(`Intent: ${out.trace.intentType}  Plan: ${out.trace.mission ?? "—"}  Coverage: ${(out.trace.coverage * 100).toFixed(0)}% (${out.coverage.fulfilledEssentials}/${out.coverage.totalEssentials})  Validation: ${out.trace.validation}${out.trace.retried ? "  [retried]" : ""}`);

    if (out.trace.unfulfilled.length) {
      console.log(`Unfulfilled: ${out.trace.unfulfilled.join(", ")}`);
    }

    console.log(`\nEssentials (${out.cart.essentials.length}):`);
    for (const p of out.cart.essentials) {
      console.log(`  ${pad("[" + p.requirement + "]", 22)} ${pad(p.subCategory, 26)} ${p.name} — ₹${p.price} (${p.quantity}) <${p.resolverPath}>`);
    }

    console.log(`\nRecommended (top 2 of ${out.trace.requirements.recommended.length}):`);
    for (const p of out.cart.recommended) {
      console.log(`  ${pad("[" + p.requirement + "]", 22)} ${p.name} — ₹${p.price}`);
    }

    console.log(`\nPremium suggestions (top 3 — not auto-added):`);
    for (const p of out.cart.premiumSuggestions) {
      console.log(`  ${pad("[" + p.requirement + "]", 22)} ${p.name} — ₹${p.price}`);
    }

    const check = SUCCESS_CHECKS[q];
    if (check) {
      const fail = check(out);
      console.log(`\n✓ Success criterion: ${fail ? `FAIL — ${fail}` : "PASS"}`);
    }

    console.log(`\n[${ms} ms]`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
