-- AlterTable
ALTER TABLE "LlmUsageLog" ADD COLUMN     "cachedTokens" INTEGER NOT NULL DEFAULT 0;
