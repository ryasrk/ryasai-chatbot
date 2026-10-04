BEGIN;
-- pgvector types live in public; keep the selected application schema first.
SELECT set_config('search_path', quote_ident(current_schema()) || ', public', false);
-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "brandingJson" TEXT,
    "licenseKey" TEXT,
    "licensePlan" TEXT,
    "licenseStatus" TEXT NOT NULL DEFAULT 'none',
    "licenseValidatedAt" TIMESTAMP(3),
    "licenseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "amountIdr" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "midtransOrderId" TEXT NOT NULL,
    "snapToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "licenseKeyIssued" TEXT,
    "rawNotificationJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "token" TEXT NOT NULL,
    "invitedBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "avatarColor" TEXT NOT NULL DEFAULT 'oklch(0.55 0.18 250)',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "ssoSubject" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "businessContext" TEXT,
    "contextPrompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSchema" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columns" TEXT NOT NULL,
    "rowCount" INTEGER,
    "sampleRow" TEXT,
    "description" TEXT,
    "manualDescription" BOOLEAN NOT NULL DEFAULT false,
    "reflectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'OPENAI_COMPATIBLE',
    "baseUrl" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "availableModels" TEXT,
    "lastModelSyncAt" TIMESTAMP(3),
    "embeddingProvider" TEXT,
    "embeddingBaseUrl" TEXT,
    "encryptedEmbeddingApiKey" TEXT,
    "embeddingModel" TEXT,
    "embeddingAvailableModels" TEXT,
    "lastEmbeddingModelSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT,
    "description" TEXT,
    "contextPrompt" TEXT,
    "contentText" TEXT NOT NULL,
    "uploadPath" TEXT,
    "cognifyStatus" TEXT,
    "cognifyError" TEXT,
    "cognifiedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentChunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER,
    "keywords" TEXT,
    "contextPrefix" TEXT,
    "embeddingJson" TEXT,
    "embedding" vector(384),
    "tsv" tsvector,
    "embeddingProvider" TEXT,
    "embeddingModel" TEXT,
    "embeddedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KgRelation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KgRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorStoreConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'INTERNAL',
    "baseUrl" TEXT,
    "encryptedApiKey" TEXT,
    "collectionName" TEXT NOT NULL DEFAULT 'ryasai_chunks',
    "vectorSize" INTEGER NOT NULL DEFAULT 384,
    "distance" TEXT NOT NULL DEFAULT 'Cosine',
    "storageChosenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorStoreConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Sesi Baru',
    "summary" TEXT,
    "summaryUpTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT,
    "citations" TEXT,
    "chartData" TEXT,
    "integrationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "setupCompleted" BOOLEAN NOT NULL DEFAULT false,
    "organizationName" TEXT,
    "brandingJson" TEXT,
    "productionChecklist" TEXT,
    "promptSettings" TEXT,
    "cogneeEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cogneeDbProvider" TEXT,
    "cogneeDbUrl" TEXT,
    "cogneeBatchSize" INTEGER NOT NULL DEFAULT 50,
    "cogneeMaxRetries" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestApiConnector" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authType" TEXT NOT NULL DEFAULT 'NONE',
    "encryptedAuthConfig" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestApiConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestApiEndpoint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "description" TEXT,
    "parameterSchema" TEXT,
    "sampleRequest" TEXT,
    "sampleResponse" TEXT,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestApiEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestApiRequestLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "endpointId" TEXT,
    "statusCode" INTEGER,
    "latencyMs" INTEGER,
    "requestSummary" TEXT NOT NULL,
    "responseSummary" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RestApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "chatMessageId" TEXT,
    "restApiEndpointId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "inputSummary" TEXT NOT NULL,
    "outputSummary" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "requestLimitPerMinute" INTEGER,
    "dailyRequestLimit" INTEGER,
    "allowedIntegrationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedDocumentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedTools" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiRequestLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "endpoint" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "latencyMs" INTEGER,
    "requestId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "detail" TEXT NOT NULL,
    "ipAddress" TEXT,
    "hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryHistory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "naturalQuery" TEXT NOT NULL,
    "generatedSql" TEXT NOT NULL,
    "rowCount" INTEGER,
    "executionMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "manifestJson" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "agenticEnabled" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT NOT NULL DEFAULT 'general',
    "subcategory" TEXT NOT NULL DEFAULT 'general',
    "keywords" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plugin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "transport" TEXT NOT NULL DEFAULT 'stdio',
    "command" TEXT NOT NULL DEFAULT '',
    "args" TEXT NOT NULL DEFAULT '[]',
    "url" TEXT NOT NULL DEFAULT '',
    "envJson" TEXT NOT NULL DEFAULT '{}',
    "headersJson" TEXT NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "chatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "agenticEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cronExpr" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "promptId" TEXT,
    "timezone" TEXT DEFAULT 'UTC',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "notificationConfigId" TEXT,
    "integrationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledRunLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scheduledRunId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "answer" TEXT,
    "error" TEXT,
    "toolRunsJson" TEXT,
    "latencyMs" INTEGER,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledRunLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT,
    "question" TEXT NOT NULL,
    "planJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resultJson" TEXT,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmUsageLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "chunkCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedPrompt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Order_midtransOrderId_key" ON "Order"("midtransOrderId");

-- CreateIndex
CREATE INDEX "Order_organizationId_idx" ON "Order"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_idx" ON "Invitation"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_organizationId_email_key" ON "Invitation"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE INDEX "Integration_organizationId_idx" ON "Integration"("organizationId");

-- CreateIndex
CREATE INDEX "IntegrationSchema_organizationId_idx" ON "IntegrationSchema"("organizationId");

-- CreateIndex
CREATE INDEX "IntegrationSchema_integrationId_idx" ON "IntegrationSchema"("integrationId");

-- CreateIndex
CREATE INDEX "LlmConfig_organizationId_idx" ON "LlmConfig"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "LlmConfig_organizationId_purpose_key" ON "LlmConfig"("organizationId", "purpose");

-- CreateIndex
CREATE INDEX "Document_organizationId_idx" ON "Document"("organizationId");

-- CreateIndex
CREATE INDEX "Document_organizationId_status_isEnabled_createdAt_idx" ON "Document"("organizationId", "status", "isEnabled", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentChunk_organizationId_idx" ON "DocumentChunk"("organizationId");

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_idx" ON "DocumentChunk"("documentId");

-- CreateIndex
CREATE INDEX "DocumentChunk_tsv_idx" ON "DocumentChunk" USING GIN ("tsv");

-- CreateIndex
CREATE INDEX "DocumentChunk_embeddingModel_idx" ON "DocumentChunk"("embeddingModel");

-- CreateIndex
CREATE INDEX "KgRelation_organizationId_idx" ON "KgRelation"("organizationId");

-- CreateIndex
CREATE INDEX "KgRelation_chunkId_idx" ON "KgRelation"("chunkId");

-- CreateIndex
CREATE INDEX "KgRelation_source_idx" ON "KgRelation"("source");

-- CreateIndex
CREATE INDEX "KgRelation_target_idx" ON "KgRelation"("target");

-- CreateIndex
CREATE INDEX "VectorStoreConfig_organizationId_idx" ON "VectorStoreConfig"("organizationId");

-- CreateIndex
CREATE INDEX "VectorStoreConfig_provider_idx" ON "VectorStoreConfig"("provider");

-- CreateIndex
CREATE INDEX "ChatSession_organizationId_idx" ON "ChatSession"("organizationId");

-- CreateIndex
CREATE INDEX "ChatSession_userId_idx" ON "ChatSession"("userId");

-- CreateIndex
CREATE INDEX "ChatMessage_organizationId_idx" ON "ChatMessage"("organizationId");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_idx" ON "ChatMessage"("sessionId");

-- CreateIndex
CREATE INDEX "ChatMessage_userId_idx" ON "ChatMessage"("userId");

-- CreateIndex
CREATE INDEX "ChatMessage_integrationId_idx" ON "ChatMessage"("integrationId");

-- CreateIndex
CREATE INDEX "AppConfig_organizationId_idx" ON "AppConfig"("organizationId");

-- CreateIndex
CREATE INDEX "RestApiConnector_organizationId_idx" ON "RestApiConnector"("organizationId");

-- CreateIndex
CREATE INDEX "RestApiEndpoint_organizationId_idx" ON "RestApiEndpoint"("organizationId");

-- CreateIndex
CREATE INDEX "RestApiEndpoint_connectorId_idx" ON "RestApiEndpoint"("connectorId");

-- CreateIndex
CREATE INDEX "RestApiEndpoint_method_path_idx" ON "RestApiEndpoint"("method", "path");

-- CreateIndex
CREATE INDEX "RestApiRequestLog_organizationId_idx" ON "RestApiRequestLog"("organizationId");

-- CreateIndex
CREATE INDEX "RestApiRequestLog_connectorId_idx" ON "RestApiRequestLog"("connectorId");

-- CreateIndex
CREATE INDEX "RestApiRequestLog_endpointId_idx" ON "RestApiRequestLog"("endpointId");

-- CreateIndex
CREATE INDEX "ToolRun_organizationId_idx" ON "ToolRun"("organizationId");

-- CreateIndex
CREATE INDEX "ToolRun_chatMessageId_idx" ON "ToolRun"("chatMessageId");

-- CreateIndex
CREATE INDEX "ToolRun_restApiEndpointId_idx" ON "ToolRun"("restApiEndpointId");

-- CreateIndex
CREATE INDEX "ToolRun_type_idx" ON "ToolRun"("type");

-- CreateIndex
CREATE INDEX "ToolRun_status_idx" ON "ToolRun"("status");

-- CreateIndex
CREATE INDEX "ApiKey_organizationId_idx" ON "ApiKey"("organizationId");

-- CreateIndex
CREATE INDEX "ApiKey_keyPrefix_idx" ON "ApiKey"("keyPrefix");

-- CreateIndex
CREATE INDEX "ApiKey_isActive_idx" ON "ApiKey"("isActive");

-- CreateIndex
CREATE INDEX "ApiRequestLog_organizationId_idx" ON "ApiRequestLog"("organizationId");

-- CreateIndex
CREATE INDEX "ApiRequestLog_apiKeyId_idx" ON "ApiRequestLog"("apiKeyId");

-- CreateIndex
CREATE INDEX "ApiRequestLog_endpoint_idx" ON "ApiRequestLog"("endpoint");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_severity_idx" ON "AuditLog"("severity");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "QueryHistory_organizationId_idx" ON "QueryHistory"("organizationId");

-- CreateIndex
CREATE INDEX "QueryHistory_integrationId_idx" ON "QueryHistory"("integrationId");

-- CreateIndex
CREATE INDEX "QueryHistory_userId_idx" ON "QueryHistory"("userId");

-- CreateIndex
CREATE INDEX "Plugin_organizationId_idx" ON "Plugin"("organizationId");

-- CreateIndex
CREATE INDEX "Plugin_isEnabled_idx" ON "Plugin"("isEnabled");

-- CreateIndex
CREATE INDEX "Plugin_category_idx" ON "Plugin"("category");

-- CreateIndex
CREATE INDEX "McpServer_organizationId_idx" ON "McpServer"("organizationId");

-- CreateIndex
CREATE INDEX "McpServer_isEnabled_idx" ON "McpServer"("isEnabled");

-- CreateIndex
CREATE INDEX "ScheduledRun_organizationId_idx" ON "ScheduledRun"("organizationId");

-- CreateIndex
CREATE INDEX "ScheduledRun_isActive_idx" ON "ScheduledRun"("isActive");

-- CreateIndex
CREATE INDEX "ScheduledRun_nextRunAt_idx" ON "ScheduledRun"("nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduledRun_notificationConfigId_idx" ON "ScheduledRun"("notificationConfigId");

-- CreateIndex
CREATE INDEX "ScheduledRun_integrationId_idx" ON "ScheduledRun"("integrationId");

-- CreateIndex
CREATE INDEX "ScheduledRunLog_organizationId_idx" ON "ScheduledRunLog"("organizationId");

-- CreateIndex
CREATE INDEX "ScheduledRunLog_scheduledRunId_idx" ON "ScheduledRunLog"("scheduledRunId");

-- CreateIndex
CREATE INDEX "ScheduledRunLog_executedAt_idx" ON "ScheduledRunLog"("executedAt");

-- CreateIndex
CREATE INDEX "NotificationConfig_organizationId_idx" ON "NotificationConfig"("organizationId");

-- CreateIndex
CREATE INDEX "NotificationConfig_isActive_idx" ON "NotificationConfig"("isActive");

-- CreateIndex
CREATE INDEX "AgentRun_organizationId_idx" ON "AgentRun"("organizationId");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- CreateIndex
CREATE INDEX "AgentRun_userId_idx" ON "AgentRun"("userId");

-- CreateIndex
CREATE INDEX "AgentRun_sessionId_idx" ON "AgentRun"("sessionId");

-- CreateIndex
CREATE INDEX "LlmUsageLog_organizationId_idx" ON "LlmUsageLog"("organizationId");

-- CreateIndex
CREATE INDEX "LlmUsageLog_createdAt_idx" ON "LlmUsageLog"("createdAt");

-- CreateIndex
CREATE INDEX "LlmUsageLog_purpose_idx" ON "LlmUsageLog"("purpose");

-- CreateIndex
CREATE INDEX "LlmUsageLog_model_idx" ON "LlmUsageLog"("model");

-- CreateIndex
CREATE INDEX "DocumentVersion_organizationId_idx" ON "DocumentVersion"("organizationId");

-- CreateIndex
CREATE INDEX "DocumentVersion_documentId_idx" ON "DocumentVersion"("documentId");

-- CreateIndex
CREATE INDEX "DocumentVersion_version_idx" ON "DocumentVersion"("version");

-- CreateIndex
CREATE INDEX "SavedPrompt_organizationId_idx" ON "SavedPrompt"("organizationId");

-- CreateIndex
CREATE INDEX "SavedPrompt_userId_idx" ON "SavedPrompt"("userId");

-- CreateIndex
CREATE INDEX "SavedPrompt_category_idx" ON "SavedPrompt"("category");

-- CreateIndex
CREATE INDEX "SavedPrompt_isPublic_idx" ON "SavedPrompt"("isPublic");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSchema" ADD CONSTRAINT "IntegrationSchema_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSchema" ADD CONSTRAINT "IntegrationSchema_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmConfig" ADD CONSTRAINT "LlmConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KgRelation" ADD CONSTRAINT "KgRelation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorStoreConfig" ADD CONSTRAINT "VectorStoreConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppConfig" ADD CONSTRAINT "AppConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestApiConnector" ADD CONSTRAINT "RestApiConnector_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestApiEndpoint" ADD CONSTRAINT "RestApiEndpoint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestApiEndpoint" ADD CONSTRAINT "RestApiEndpoint_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "RestApiConnector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestApiRequestLog" ADD CONSTRAINT "RestApiRequestLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestApiRequestLog" ADD CONSTRAINT "RestApiRequestLog_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "RestApiConnector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestApiRequestLog" ADD CONSTRAINT "RestApiRequestLog_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "RestApiEndpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_chatMessageId_fkey" FOREIGN KEY ("chatMessageId") REFERENCES "ChatMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_restApiEndpointId_fkey" FOREIGN KEY ("restApiEndpointId") REFERENCES "RestApiEndpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiRequestLog" ADD CONSTRAINT "ApiRequestLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryHistory" ADD CONSTRAINT "QueryHistory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryHistory" ADD CONSTRAINT "QueryHistory_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueryHistory" ADD CONSTRAINT "QueryHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plugin" ADD CONSTRAINT "Plugin_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpServer" ADD CONSTRAINT "McpServer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledRun" ADD CONSTRAINT "ScheduledRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledRun" ADD CONSTRAINT "ScheduledRun_notificationConfigId_fkey" FOREIGN KEY ("notificationConfigId") REFERENCES "NotificationConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledRun" ADD CONSTRAINT "ScheduledRun_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledRunLog" ADD CONSTRAINT "ScheduledRunLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledRunLog" ADD CONSTRAINT "ScheduledRunLog_scheduledRunId_fkey" FOREIGN KEY ("scheduledRunId") REFERENCES "ScheduledRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationConfig" ADD CONSTRAINT "NotificationConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmUsageLog" ADD CONSTRAINT "LlmUsageLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedPrompt" ADD CONSTRAINT "SavedPrompt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedPrompt" ADD CONSTRAINT "SavedPrompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
