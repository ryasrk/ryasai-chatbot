-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "accessMode" TEXT NOT NULL DEFAULT 'open';

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "allowedRoles" TEXT[] DEFAULT ARRAY['admin', 'analyst', 'viewer']::TEXT[];

-- CreateTable
CREATE TABLE "DataAccessPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "allowedColumns" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataAccessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataAccessPolicy_organizationId_integrationId_idx" ON "DataAccessPolicy"("organizationId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "DataAccessPolicy_organizationId_integrationId_role_tableNam_key" ON "DataAccessPolicy"("organizationId", "integrationId", "role", "tableName");

-- AddForeignKey
ALTER TABLE "DataAccessPolicy" ADD CONSTRAINT "DataAccessPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataAccessPolicy" ADD CONSTRAINT "DataAccessPolicy_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

