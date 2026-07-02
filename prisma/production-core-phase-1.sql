CREATE TABLE IF NOT EXISTS "AppConfig" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "setupCompleted" BOOLEAN NOT NULL DEFAULT false,
  "organizationName" TEXT,
  "brandingJson" TEXT,
  "productionChecklist" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AppConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "AppConfig_companyId_key" ON "AppConfig"("companyId");

CREATE TABLE IF NOT EXISTS "RestApiConnector" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "authType" TEXT NOT NULL DEFAULT 'NONE',
  "encryptedAuthConfig" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RestApiConnector_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RestApiConnector_companyId_idx" ON "RestApiConnector"("companyId");

CREATE TABLE IF NOT EXISTS "RestApiEndpoint" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "connectorId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "description" TEXT,
  "parameterSchema" TEXT,
  "sampleRequest" TEXT,
  "sampleResponse" TEXT,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RestApiEndpoint_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "RestApiConnector" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RestApiEndpoint_connectorId_idx" ON "RestApiEndpoint"("connectorId");
CREATE INDEX IF NOT EXISTS "RestApiEndpoint_method_path_idx" ON "RestApiEndpoint"("method", "path");

CREATE TABLE IF NOT EXISTS "RestApiRequestLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "connectorId" TEXT NOT NULL,
  "endpointId" TEXT,
  "statusCode" INTEGER,
  "latencyMs" INTEGER,
  "requestSummary" TEXT NOT NULL,
  "responseSummary" TEXT,
  "errorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RestApiRequestLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RestApiRequestLog_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "RestApiConnector" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RestApiRequestLog_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "RestApiEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RestApiRequestLog_companyId_idx" ON "RestApiRequestLog"("companyId");
CREATE INDEX IF NOT EXISTS "RestApiRequestLog_connectorId_idx" ON "RestApiRequestLog"("connectorId");
CREATE INDEX IF NOT EXISTS "RestApiRequestLog_endpointId_idx" ON "RestApiRequestLog"("endpointId");

CREATE TABLE IF NOT EXISTS "ToolRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "chatMessageId" TEXT,
  "restApiEndpointId" TEXT,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "latencyMs" INTEGER,
  "inputSummary" TEXT NOT NULL,
  "outputSummary" TEXT,
  "errorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ToolRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ToolRun_chatMessageId_fkey" FOREIGN KEY ("chatMessageId") REFERENCES "ChatMessage" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ToolRun_restApiEndpointId_fkey" FOREIGN KEY ("restApiEndpointId") REFERENCES "RestApiEndpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ToolRun_companyId_idx" ON "ToolRun"("companyId");
CREATE INDEX IF NOT EXISTS "ToolRun_chatMessageId_idx" ON "ToolRun"("chatMessageId");
CREATE INDEX IF NOT EXISTS "ToolRun_restApiEndpointId_idx" ON "ToolRun"("restApiEndpointId");
CREATE INDEX IF NOT EXISTS "ToolRun_type_idx" ON "ToolRun"("type");
CREATE INDEX IF NOT EXISTS "ToolRun_status_idx" ON "ToolRun"("status");

CREATE TABLE IF NOT EXISTS "ApiKey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "keyPrefix" TEXT NOT NULL,
  "keyHash" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "requestLimitPerMinute" INTEGER,
  "dailyRequestLimit" INTEGER,
  "lastUsedAt" DATETIME,
  "revokedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiKey_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ApiKey_companyId_idx" ON "ApiKey"("companyId");
CREATE INDEX IF NOT EXISTS "ApiKey_keyPrefix_idx" ON "ApiKey"("keyPrefix");
CREATE INDEX IF NOT EXISTS "ApiKey_isActive_idx" ON "ApiKey"("isActive");

CREATE TABLE IF NOT EXISTS "ApiRequestLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "apiKeyId" TEXT,
  "endpoint" TEXT NOT NULL,
  "status" INTEGER NOT NULL,
  "latencyMs" INTEGER,
  "requestId" TEXT,
  "errorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiRequestLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ApiRequestLog_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ApiRequestLog_companyId_idx" ON "ApiRequestLog"("companyId");
CREATE INDEX IF NOT EXISTS "ApiRequestLog_apiKeyId_idx" ON "ApiRequestLog"("apiKeyId");
CREATE INDEX IF NOT EXISTS "ApiRequestLog_endpoint_idx" ON "ApiRequestLog"("endpoint");
