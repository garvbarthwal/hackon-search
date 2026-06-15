-- v4.5: product domain tagging
--
-- Every product is assigned a coarse domain (food, ingredient, beverage,
-- snack, baby_care, medicine, household, cleaning, festival, personal_care).
-- The constraint engine reads this to block cross-domain pollution
-- (e.g. "Lemon Detergent" cannot satisfy a "Lemon" ingredient requirement).
ALTER TABLE "Product" ADD COLUMN "domain" TEXT;
CREATE INDEX "Product_domain_idx" ON "Product"("domain");
