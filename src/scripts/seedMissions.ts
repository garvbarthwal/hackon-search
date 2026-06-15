import "dotenv/config";
import { prisma } from "../lib/db.js";

/**
 * Seed v2 Mission/Dish knowledge base.
 *
 * Each requirement has:
 *   - name:  human label ("Tea", "Pav", "Diapers")
 *   - hints: optional sub-category names that should match (resolver tries these first)
 *
 * All `hints` are verified against actual sub-category names in this dataset.
 * Where a logical sub-category doesn't exist (e.g. there is no "Diapers" sub-cat
 * — only adult diapers in "Elderly Care"), the resolver will fall back to product
 * name matching and the coverage validator will surface the gap honestly.
 */

type Req = { name: string; hints?: string[]; nameMatch?: string[] };
type Entry = {
  slug: string;
  type: "mission" | "dish" | "festival";
  aliases: string[];
  essentials: Req[];
  recommended: Req[];
  premium: Req[];
};

const ENTRIES: Entry[] = [
  // ─── Missions ──────────────────────────────────────────────────────────
  {
    slug: "tea_party",
    type: "mission",
    aliases: ["tea party", "high tea", "kitty party tea", "evening tea", "chai party"],
    essentials: [
      { name: "Tea", hints: ["Tea", "Tea & Coffee", "Green & Herbal Tea"] },
      { name: "Milk", hints: ["Milk"] },
      { name: "Sugar", hints: ["Salt, Sugar & Jaggery"], nameMatch: ["sugar"] },
    ],
    recommended: [
      { name: "Cookies", hints: ["Cookies"] },
      { name: "Cake or Pastry", hints: ["Pastries & Cakes"] },
      { name: "Biscuits", hints: ["Crackers", "Glucose & Marie", "Digestives"] },
    ],
    premium: [
      { name: "Premium Tea", hints: ["Premium Tea"] },
      { name: "Tissues / Paper Cups", hints: ["Tissues & Disposables"] },
    ],
  },
  {
    slug: "movie_night",
    type: "mission",
    aliases: ["movie night", "movie snacks", "film night", "movie marathon"],
    essentials: [
      { name: "Savory Snack", hints: ["Chips & Crisps", "Namkeens", "Wafers"] },
      { name: "Sweet Snack", hints: ["Chocolates", "Cookies"] },
      { name: "Beverage", hints: ["Soft Drinks", "Fruit Juices & Drinks", "Soda & Mixers"] },
    ],
    recommended: [
      { name: "Popcorn", hints: ["Popcorn"] },
      { name: "Nachos", hints: ["Nachos"] },
      { name: "Chocolate", hints: ["Chocolates"] },
    ],
    premium: [
      { name: "Premium Chocolates", hints: ["Premium Chocolates"] },
      { name: "Dips & Sauces", hints: ["Ketchup & Sauces", "Honey & Spreads"] },
    ],
  },
  {
    slug: "baby_care",
    type: "mission",
    aliases: ["baby care", "baby food and diapers", "baby essentials", "newborn care"],
    essentials: [
      // No "Diapers" sub-cat exists — resolver will fall back to name match,
      // and validator will surface as unfulfilled if the catalog has none.
      { name: "Diapers", nameMatch: ["diaper", "pamper", "huggies", "mamy poko"] },
      { name: "Baby Food", hints: ["Baby Food", "Kids' Nutrition"] },
    ],
    recommended: [
      { name: "Baby Wipes", hints: ["Baby Hygiene"], nameMatch: ["wipe"] },
      { name: "Baby Bath Items", hints: ["Baby Bath"] },
    ],
    premium: [
      { name: "Baby Lotion", hints: ["Baby Bath"], nameMatch: ["lotion", "cream"] },
      { name: "Baby Shampoo", hints: ["Baby Bath"], nameMatch: ["shampoo"] },
    ],
  },
  {
    slug: "healthy_breakfast",
    type: "mission",
    aliases: ["healthy breakfast", "morning meal", "fitness breakfast", "breakfast for two"],
    essentials: [
      { name: "Milk", hints: ["Milk"] },
      { name: "Bread or Cereal", hints: ["Breads & Buns", "Muesli & Oats", "Breakfast Cereals"] },
      { name: "Fruit", hints: ["Fresh Fruits"] },
    ],
    recommended: [
      { name: "Eggs", hints: ["Eggs", "Egg"] },
      { name: "Honey or Spread", hints: ["Honey & Spreads", "Peanut Butter"] },
    ],
    premium: [
      { name: "Yogurt", hints: ["Yogurt & Shrikhand"] },
      { name: "Dry Fruits", hints: ["Dry Fruits & Nuts"] },
    ],
  },
  {
    slug: "exam_night",
    type: "mission",
    aliases: ["exam night", "study night", "all nighter", "study session"],
    essentials: [
      { name: "Coffee", hints: ["Coffee", "Cold Coffee & Iced Tea"] },
      { name: "Light Snacks", hints: ["Chips & Crisps", "Namkeens"] },
      { name: "Water or Hydration", hints: ["Water", "Value Added Hydration"] },
    ],
    recommended: [
      { name: "Energy Drink", hints: ["Non-Alcoholic & Energy Drink"] },
      { name: "Chocolate", hints: ["Chocolates"] },
    ],
    premium: [
      { name: "Premium Chocolates", hints: ["Premium Chocolates"] },
      { name: "Premium Coffee", hints: ["Premium Coffee"] },
    ],
  },
  {
    slug: "hostel_starter_pack",
    type: "mission",
    aliases: ["hostel starter pack", "hostel essentials", "moving to hostel", "pg starter kit"],
    essentials: [
      { name: "Instant Noodles", hints: ["Noodles & Vermicelli"], nameMatch: ["maggi", "noodle"] },
      { name: "Tea or Coffee", hints: ["Tea & Coffee", "Tea", "Coffee"] },
      { name: "Soap", hints: ["Soaps"] },
      { name: "Detergent", hints: ["Detergent Powder & Bars", "Liquid Detergents & Additives"] },
    ],
    recommended: [
      { name: "Biscuits", hints: ["Cookies", "Glucose & Marie"] },
      { name: "Toothpaste", hints: ["Toothpaste", "Toothbrush & More"] },
    ],
    premium: [
      { name: "Energy Bars", hints: ["Energy Bars"] },
      { name: "Shampoo", nameMatch: ["shampoo"] },
    ],
  },
  {
    slug: "birthday_party",
    type: "mission",
    aliases: ["birthday party", "kids birthday", "birthday supplies", "birthday for kids"],
    essentials: [
      { name: "Cake", hints: ["Pastries & Cakes"] },
      { name: "Soft Drinks", hints: ["Soft Drinks", "Fruit Juices & Drinks"] },
      { name: "Snacks", hints: ["Chips & Crisps", "Namkeens"] },
      { name: "Chocolates", hints: ["Chocolates"] },
    ],
    recommended: [
      { name: "Candies", hints: ["Candies, Gums & Mints", "Mints & Gums"] },
      { name: "Mithai", hints: ["Indian Mithai"] },
    ],
    premium: [
      { name: "Tissues / Paper Cups", hints: ["Tissues & Disposables"] },
      { name: "Premium Chocolates", hints: ["Premium Chocolates"] },
    ],
  },

  // ─── Dishes ────────────────────────────────────────────────────────────
  {
    slug: "pav_bhaji",
    type: "dish",
    aliases: ["pav bhaji", "pavbhaji"],
    essentials: [
      // No "Pav" sub-cat — but "Breads & Buns" carries pav-equivalents (white bread/buns).
      { name: "Pav", hints: ["Breads & Buns"], nameMatch: ["pav", "bun", "ladi"] },
      { name: "Potato", hints: ["Fresh Vegetables"], nameMatch: ["potato", "aloo"] },
      { name: "Tomato", hints: ["Fresh Vegetables"], nameMatch: ["tomato"] },
      { name: "Onion", hints: ["Fresh Vegetables"], nameMatch: ["onion"] },
      {
        name: "Pav Bhaji Masala",
        hints: ["Powders & Pastes", "Whole Spices & Seasonings"],
        nameMatch: ["pav bhaji"],
      },
    ],
    recommended: [
      { name: "Butter", hints: ["Butter"] },
      { name: "Lemon", hints: ["Fresh Vegetables"], nameMatch: ["lemon", "lime"] },
      { name: "Capsicum", hints: ["Fresh Vegetables"], nameMatch: ["capsicum", "bell pepper"] },
    ],
    premium: [
      { name: "Cheese", hints: ["Cheese"] },
      { name: "Coriander", hints: ["Leafy, Herbs & Seasonings"], nameMatch: ["coriander", "cilantro", "dhaniya"] },
    ],
  },
  {
    slug: "biryani",
    type: "dish",
    aliases: ["biryani", "chicken biryani", "veg biryani"],
    essentials: [
      { name: "Basmati Rice", hints: ["Rice & More"], nameMatch: ["basmati"] },
      { name: "Onion", hints: ["Fresh Vegetables"], nameMatch: ["onion"] },
      {
        name: "Biryani Masala",
        hints: ["Powders & Pastes", "Whole Spices & Seasonings"],
        nameMatch: ["biryani"],
      },
      { name: "Yogurt", hints: ["Yogurt & Shrikhand"] },
    ],
    recommended: [
      { name: "Ghee", hints: ["Ghee"] },
      { name: "Saffron", hints: ["Whole Spices & Seasonings"], nameMatch: ["saffron", "kesar"] },
    ],
    premium: [
      { name: "Mint Leaves", hints: ["Leafy, Herbs & Seasonings"], nameMatch: ["mint", "pudina"] },
      { name: "Cashews", hints: ["Dry Fruits & Nuts"], nameMatch: ["cashew", "kaju"] },
    ],
  },
  {
    slug: "dal_chawal",
    type: "dish",
    aliases: ["dal chawal", "dal rice", "dal and rice"],
    essentials: [
      { name: "Toor Dal", hints: ["Dals & Pulses"], nameMatch: ["toor", "tur", "arhar"] },
      { name: "Rice", hints: ["Rice & More"] },
      { name: "Onion", hints: ["Fresh Vegetables"], nameMatch: ["onion"] },
      { name: "Tomato", hints: ["Fresh Vegetables"], nameMatch: ["tomato"] },
    ],
    recommended: [
      { name: "Ghee", hints: ["Ghee"] },
      { name: "Pickle", hints: ["Papads, Pickles & Chutney"] },
    ],
    premium: [
      { name: "Papad", hints: ["Papads, Pickles & Chutney"], nameMatch: ["papad"] },
      { name: "Curd", hints: ["Curd & Probiotic Drink"] },
    ],
  },
  {
    slug: "maggi",
    type: "dish",
    aliases: ["maggi", "instant noodles", "2-minute noodles"],
    essentials: [
      { name: "Maggi Noodles", hints: ["Noodles & Vermicelli"], nameMatch: ["maggi", "noodle"] },
    ],
    recommended: [
      { name: "Onion", hints: ["Fresh Vegetables"], nameMatch: ["onion"] },
      { name: "Tomato", hints: ["Fresh Vegetables"], nameMatch: ["tomato"] },
      { name: "Egg", hints: ["Eggs", "Egg"] },
    ],
    premium: [
      { name: "Cheese", hints: ["Cheese"] },
      { name: "Capsicum", hints: ["Fresh Vegetables"], nameMatch: ["capsicum"] },
    ],
  },
  {
    slug: "sandwich",
    type: "dish",
    aliases: ["sandwich", "veg sandwich", "grilled sandwich"],
    essentials: [
      { name: "Bread", hints: ["Breads & Buns"] },
      { name: "Cheese or Butter", hints: ["Cheese", "Butter"] },
      { name: "Tomato", hints: ["Fresh Vegetables"], nameMatch: ["tomato"] },
      { name: "Cucumber or Onion", hints: ["Fresh Vegetables"], nameMatch: ["cucumber", "onion"] },
    ],
    recommended: [
      { name: "Mayo or Sauce", hints: ["Ketchup & Sauces"], nameMatch: ["mayo", "ketchup"] },
      { name: "Sandwich Masala", hints: ["Powders & Pastes"], nameMatch: ["sandwich"] },
    ],
    premium: [
      { name: "Bell Peppers", hints: ["Fresh Vegetables"], nameMatch: ["capsicum", "bell pepper"] },
      { name: "Olives", hints: ["Gourmet Store"], nameMatch: ["olive"] },
    ],
  },
  {
    slug: "pasta",
    type: "dish",
    aliases: ["pasta", "italian pasta", "white sauce pasta", "red sauce pasta"],
    essentials: [
      { name: "Pasta", hints: ["Pasta & Soups"], nameMatch: ["pasta", "macaroni", "penne"] },
      { name: "Pasta Sauce", hints: ["Ketchup & Sauces"], nameMatch: ["pasta", "marinara", "arrabiata"] },
      { name: "Cheese", hints: ["Cheese"] },
    ],
    recommended: [
      { name: "Onion", hints: ["Fresh Vegetables"], nameMatch: ["onion"] },
      { name: "Capsicum", hints: ["Fresh Vegetables"], nameMatch: ["capsicum", "bell pepper"] },
    ],
    premium: [
      { name: "Olives", hints: ["Gourmet Store"], nameMatch: ["olive"] },
      { name: "Mushrooms", hints: ["Fresh Vegetables"], nameMatch: ["mushroom"] },
    ],
  },
  {
    slug: "dosa",
    type: "dish",
    aliases: ["dosa", "masala dosa", "plain dosa"],
    essentials: [
      // Dataset has both spellings — try both.
      { name: "Dosa Batter", hints: ["Batter & Mixes", "Batters & Mixes", "Ready To Cook"], nameMatch: ["dosa", "idli"] },
      { name: "Potato", hints: ["Fresh Vegetables"], nameMatch: ["potato", "aloo"] },
      { name: "Onion", hints: ["Fresh Vegetables"], nameMatch: ["onion"] },
    ],
    recommended: [
      { name: "Coconut Chutney", hints: ["Papads, Pickles & Chutney"], nameMatch: ["chutney", "coconut"] },
      { name: "Sambar Mix", hints: ["Powders & Pastes", "Pasta & Soups"], nameMatch: ["sambar"] },
    ],
    premium: [
      { name: "Ghee", hints: ["Ghee"] },
      { name: "Curry Leaves", hints: ["Leafy, Herbs & Seasonings"], nameMatch: ["curry leaves"] },
    ],
  },
  {
    slug: "chai",
    type: "dish",
    aliases: ["chai", "masala chai", "indian tea"],
    essentials: [
      { name: "Tea", hints: ["Tea", "Tea & Coffee"] },
      { name: "Milk", hints: ["Milk"] },
      { name: "Sugar", hints: ["Salt, Sugar & Jaggery"], nameMatch: ["sugar"] },
    ],
    recommended: [
      { name: "Ginger", hints: ["Fresh Vegetables"], nameMatch: ["ginger", "adrak"] },
      { name: "Cardamom", hints: ["Whole Spices & Seasonings"], nameMatch: ["cardamom", "elaichi"] },
    ],
    premium: [{ name: "Premium Tea", hints: ["Premium Tea"] }],
  },
  {
    slug: "paneer_butter_masala",
    type: "dish",
    aliases: ["paneer butter masala", "paneer makhani", "butter paneer"],
    essentials: [
      { name: "Paneer", hints: ["Paneer & Cream"] },
      { name: "Tomato", hints: ["Fresh Vegetables"], nameMatch: ["tomato"] },
      { name: "Butter", hints: ["Butter"] },
      { name: "Cream", hints: ["Paneer & Cream"], nameMatch: ["cream"] },
    ],
    recommended: [
      { name: "Garam Masala", hints: ["Powders & Pastes", "Whole Spices & Seasonings"], nameMatch: ["garam masala"] },
      { name: "Onion", hints: ["Fresh Vegetables"], nameMatch: ["onion"] },
    ],
    premium: [
      { name: "Cashews", hints: ["Dry Fruits & Nuts"], nameMatch: ["cashew", "kaju"] },
      { name: "Kasuri Methi", hints: ["Whole Spices & Seasonings"], nameMatch: ["kasuri methi"] },
    ],
  },

  // ─── Festivals ─────────────────────────────────────────────────────────
  {
    slug: "diwali",
    type: "festival",
    aliases: ["diwali", "diwali decorations", "diwali essentials", "diwali shopping", "deepavali"],
    essentials: [
      { name: "Diyas & Candles", hints: ["Festive Needs", "Pooja & Worship Needs"], nameMatch: ["diya", "candle"] },
      { name: "Rangoli", hints: ["Festive Needs"], nameMatch: ["rangoli"] },
      { name: "Pooja Items", hints: ["Pooja & Worship Needs"], nameMatch: ["pooja", "puja", "lakshmi", "ganesh"] },
    ],
    recommended: [
      { name: "Lights & Toran", hints: ["Festive Needs"], nameMatch: ["light", "toran", "lantern"] },
      { name: "Sweets & Mithai", hints: ["Indian Mithai"] },
    ],
    premium: [
      { name: "Premium Gift Hampers", hints: ["Festive Needs"], nameMatch: ["hamper", "gift"] },
      { name: "Premium Chocolates", hints: ["Premium Chocolates"] },
    ],
  },
  {
    slug: "christmas",
    type: "festival",
    aliases: ["christmas", "xmas", "christmas decorations", "christmas tree"],
    essentials: [
      { name: "Christmas Tree & Decor", hints: ["Festive Needs"], nameMatch: ["christmas", "xmas", "santa"] },
    ],
    recommended: [
      { name: "Christmas Sweets", hints: ["Premium Chocolates", "Chocolates"] },
    ],
    premium: [
      { name: "Christmas Gift Hampers", hints: ["Festive Needs"], nameMatch: ["christmas", "santa"] },
    ],
  },
  {
    slug: "holi",
    type: "festival",
    aliases: ["holi", "holi colors", "holi gulal", "festival of colors"],
    essentials: [
      { name: "Gulal & Colors", hints: ["Festive Needs"], nameMatch: ["gulal", "holi", "color"] },
    ],
    recommended: [
      { name: "Sweets", hints: ["Indian Mithai"] },
      { name: "Snacks", hints: ["Namkeens"] },
    ],
    premium: [
      { name: "Thandai Mix", hints: ["Drink Mixes", "Powders & Pastes"], nameMatch: ["thandai"] },
    ],
  },
  {
    slug: "eid",
    type: "festival",
    aliases: ["eid", "eid essentials", "ramadan", "ramzan", "eid mubarak"],
    essentials: [
      { name: "Eid Decor", hints: ["Festive Needs"], nameMatch: ["eid", "ramadan", "ramzan"] },
    ],
    recommended: [
      { name: "Sevaiyan", hints: ["Noodles & Vermicelli"], nameMatch: ["seviyan", "vermicelli"] },
      { name: "Dates", hints: ["Dates & Seeds"], nameMatch: ["date"] },
      { name: "Sweets", hints: ["Indian Mithai"] },
    ],
    premium: [
      { name: "Dry Fruits", hints: ["Dry Fruits & Nuts"] },
    ],
  },
  {
    slug: "raksha_bandhan",
    type: "festival",
    aliases: ["raksha bandhan", "rakhi", "rakhi for brother", "raksha bandhan gifts"],
    essentials: [
      { name: "Rakhi", hints: ["Festive Needs"], nameMatch: ["rakhi", "raksha"] },
    ],
    recommended: [
      { name: "Sweets & Mithai", hints: ["Indian Mithai"] },
      { name: "Chocolates", hints: ["Chocolates"] },
    ],
    premium: [
      { name: "Premium Gift Hampers", hints: ["Festive Needs"], nameMatch: ["hamper", "gift"] },
      { name: "Dry Fruits", hints: ["Dry Fruits & Nuts"] },
    ],
  },
];

async function main() {
  await prisma.missionKB.deleteMany({ where: { isLlmGenerated: false } });
  for (const e of ENTRIES) {
    await prisma.missionKB.upsert({
      where: { slug: e.slug },
      create: {
        slug: e.slug,
        type: e.type,
        aliases: e.aliases,
        essentials: e.essentials as object,
        recommended: e.recommended as object,
        premium: e.premium as object,
        isLlmGenerated: false,
      },
      update: {
        type: e.type,
        aliases: e.aliases,
        essentials: e.essentials as object,
        recommended: e.recommended as object,
        premium: e.premium as object,
        isLlmGenerated: false,
      },
    });
    console.log(`[kb] ${e.type}: ${e.slug} (${e.essentials.length} essentials)`);
  }
  console.log(`[kb] seeded ${ENTRIES.length} entries.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
