-- Product synthetic-text + embeddings
ALTER TABLE "Product" ADD COLUMN "syntheticText" TEXT;
ALTER TABLE "Product" ADD COLUMN "embedding" vector(768);

CREATE INDEX "Product_embedding_idx"
  ON "Product"
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Mission/Dish knowledge base. type ∈ ('mission','dish').
-- aliases: free-form strings that resolve to this entry.
-- requirements columns are jsonb arrays of { name: string, hints?: string[] }.
CREATE TABLE "MissionKB" (
    "slug"          TEXT PRIMARY KEY,
    "type"          TEXT NOT NULL,
    "aliases"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "essentials"    JSONB NOT NULL DEFAULT '[]'::jsonb,
    "recommended"   JSONB NOT NULL DEFAULT '[]'::jsonb,
    "premium"       JSONB NOT NULL DEFAULT '[]'::jsonb,
    "isLlmGenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "MissionKB_type_idx" ON "MissionKB"("type");
CREATE INDEX "MissionKB_aliases_gin" ON "MissionKB" USING GIN ("aliases");
