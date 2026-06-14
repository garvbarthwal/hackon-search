-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviews" INTEGER NOT NULL DEFAULT 0,
    "quantity" TEXT NOT NULL,
    "subCategory" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "inStock" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubCategory" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "productCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SubCategory_pkey" PRIMARY KEY ("id")
);

-- Vector column (managed via raw SQL — Prisma has no first-class vector type)
ALTER TABLE "SubCategory" ADD COLUMN "embedding" vector(768);

-- Indexes
CREATE INDEX "Product_subCategory_idx" ON "Product"("subCategory");
CREATE INDEX "Product_category_idx" ON "Product"("category");
CREATE UNIQUE INDEX "SubCategory_name_key" ON "SubCategory"("name");
CREATE INDEX "SubCategory_category_idx" ON "SubCategory"("category");

-- Full-text search on product name (Stage 3 keyword half of hybrid retrieval)
CREATE INDEX "Product_name_trgm_idx" ON "Product" USING GIN ("name" gin_trgm_ops);

-- Vector similarity index for sub-category embeddings (cosine)
CREATE INDEX "SubCategory_embedding_idx"
  ON "SubCategory"
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 20);
