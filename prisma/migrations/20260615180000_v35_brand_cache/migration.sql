-- v3.5: brand column + caches

ALTER TABLE "Product" ADD COLUMN "brand" TEXT;
CREATE INDEX "Product_brand_idx" ON "Product"("brand");
CREATE INDEX "Product_brand_trgm_idx" ON "Product" USING GIN ("brand" gin_trgm_ops);

CREATE TABLE "RequirementCache" (
    "id" SERIAL PRIMARY KEY,
    "query" TEXT NOT NULL,
    "queryType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "RequirementCache_query_queryType_key" ON "RequirementCache"("query","queryType");
CREATE INDEX "RequirementCache_createdAt_idx" ON "RequirementCache"("createdAt");

CREATE TABLE "Brand" (
    "name" TEXT PRIMARY KEY,
    "productCount" INTEGER NOT NULL,
    "avgRating" DOUBLE PRECISION NOT NULL,
    "totalReviews" INTEGER NOT NULL,
    "brandScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Brand_brandScore_idx" ON "Brand"("brandScore");
