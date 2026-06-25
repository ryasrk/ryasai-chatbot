# Chatbot Production Core Design

Date: 2026-06-25
Project: `/home/ryasr/ryasai/Chatbot`

## Goal

Turn the current Chatbot application into a dedicated production chatbot for a mid-sized company. The product should be simple to set up, usable by one admin, able to answer from documents, databases, and REST APIs, and expose a stable API for integration with other programs.

The product uses external LLM APIs only. It does not run local model inference and does not need model pulling, GPU/CUDA management, or local runner administration.

## Product Direction

The approved approach is **Modular Production Core**.

The application stays as the existing Next.js product instead of being replaced by PrivateGPT, Dify, or Open WebUI. Those repositories are used as product references:

- Open WebUI: chat UX, provider settings, knowledge workspace, simple self-hosted operation.
- Dify: workflow discipline, dataset/RAG management, observability, prompt/model operations.
- PrivateGPT: API-first chat, retrieval citations, tools, database access, and external integrations.

The v1 scope is intentionally smaller than a full workflow platform. It should be production-friendly without becoming a Dify clone.

## Deployment Assumptions

- Dedicated deployment for one company.
- Single admin account.
- No multi-tenant UI.
- No role matrix such as admin, manager, and staff.
- LLMs are reached through API endpoints.
- Data sources include documents, read-only databases, and REST APIs.
- Other internal programs must be able to call the chatbot via API.

## Main Navigation

The production UI should use these top-level menu items:

1. **Setup**
   - First-run wizard.
   - Admin account setup.
   - LLM API setup.
   - Health checks.
   - Optional first knowledge/data source setup.
   - Final test chat.

2. **Chat**
   - Main usage surface.
   - Session list.
   - Source selector.
   - Streaming responses.
   - Citations.
   - SQL/API provenance.
   - Tables or charts when data is structured.

3. **Knowledge**
   - Document upload and management.
   - Supported files: PDF, DOCX, XLSX, TXT, MD.
   - Indexing status.
   - Chunk preview.
   - Category filter.
   - Retrieval/search tester.

4. **Data Sources**
   - Database connections.
   - REST API connectors.
   - Schema and endpoint registry.
   - Query/API test tools.

5. **AI Configuration**
   - LLM provider API base URL.
   - API key.
   - Chat model.
   - Embedding model.
   - Timeout.
   - Fallback provider.
   - Rate limits.

6. **Prompt & Tools**
   - System prompt.
   - Routing rules.
   - Allowed tools.
   - SQL guardrails.
   - REST API endpoint whitelist rules.

7. **Monitoring**
   - Audit log.
   - Chat history.
   - Failed requests.
   - Blocked SQL.
   - REST API errors.
   - Token usage.
   - Tool latency.
   - Retrieval quality signals.

8. **Settings**
   - Organization profile.
   - Single admin profile.
   - API keys for external programs.
   - Branding.
   - Backup and restore.
   - Environment checklist.

Existing pages should be renamed or reorganized:

- "Integrasi Data" becomes **Data Sources**.
- "Keamanan & Audit" moves into **Monitoring**.
- AI provider settings move out of general settings into **AI Configuration**.
- Multi-user and user-switching UI is removed from the main product.

## Architecture

The current Next.js application remains the host application.

### Frontend Views

- `SetupView`
- `ChatView`
- `KnowledgeView`
- `DataSourcesView`
- `AIConfigurationView`
- `PromptToolsView`
- `MonitoringView`
- `SettingsView`

### Backend Modules

Current API routes remain the primary backend surface. The socket.io mini-service remains responsible for realtime chat streaming.

The backend should be organized around these modules:

- `ai.ts`: external LLM API wrapper.
- `database-connectors.ts`: read-only SQL connectors.
- `rest-api-connectors.ts`: REST API connector execution and auth handling.
- `tool-router.ts`: route user intent to RAG, SQL, REST API, or direct chat.
- `rag.ts`: document parsing, chunking, retrieval, and citation helpers.
- `guardrails.ts`: SQL and tool safety checks.
- `api-keys.ts`: external API key hashing, verification, revocation, and usage limits.
- `monitoring.ts`: audit events, tool runs, request logs, and latency tracking.

## Chat Data Flow

1. Admin or an external API client sends a chat request.
2. The router decides the route:
   - Document question: RAG retrieval.
   - Structured data question: SQL connector.
   - Business system/API question: REST API connector.
   - General question: direct LLM response.
3. The selected tool runs under guardrails:
   - SQL must be read-only.
   - REST API must match an enabled whitelist endpoint.
   - Document retrieval must return source chunks.
4. Tool outputs are summarized by the configured LLM.
5. The response includes provenance:
   - Document source and chunk reference.
   - Database connection and SQL query.
   - REST API connector, endpoint, status code, and request summary.
6. Monitoring records audit events, tool runs, request latency, failures, and blocked actions.

## Single Admin Simplification

The existing schema may keep `Company`, `User`, and role fields for compatibility during migration, but product behavior should treat the deployment as a singleton organization with one admin.

The product should not expose:

- Tenant switching.
- User switching.
- Multi-role management.
- Staff/manager/admin role flows.

Production should replace demo auth fallback with a clear first-run setup and admin login path.

## Data Model Strategy

To avoid a risky rewrite, migrate incrementally.

Keep or adapt existing models:

- `Company`: internal singleton organization.
- `User`: single admin account.
- `LlmConfig`: API-only LLM configuration.
- `Document`
- `DocumentChunk`
- `Integration`: current database connector concept.
- `IntegrationSchema`
- `ChatSession`
- `ChatMessage`
- `AuditLog`
- `QueryHistory`

Add or extend models:

- `AppConfig`
  - setup status.
  - organization name.
  - branding.
  - production checklist state.

- `RestApiConnector`
  - name.
  - base URL.
  - auth type.
  - encrypted auth config.
  - enabled state.
  - timeout.

- `RestApiEndpoint`
  - connector id.
  - method.
  - path.
  - description.
  - parameter schema.
  - sample request.
  - sample response or response schema.
  - enabled state.

- `RestApiRequestLog`
  - endpoint id.
  - status code.
  - latency.
  - sanitized request summary.
  - sanitized response summary.
  - error message.

- `ToolRun`
  - chat message or request id.
  - type: `RAG`, `SQL`, `REST_API`, or `CHAT`.
  - status.
  - latency.
  - input summary.
  - output summary.
  - error message.

- `ApiKey`
  - key prefix.
  - key hash.
  - label.
  - enabled/revoked state.
  - last used at.
  - request limits.

- `ApiRequestLog`
  - API key id.
  - endpoint.
  - status.
  - latency.
  - request id.
  - error message.

## Environment Configuration

Production `.env` should be simple and explicit:

```env
DATABASE_URL=...
ENCRYPTION_SECRET_KEY=...
ADMIN_EMAIL=...
ADMIN_INITIAL_PASSWORD=...
APP_URL=...
PORT=3000
WS_PORT=3003

AUTH_DEMO_FALLBACK=false

DEFAULT_LLM_BASE_URL=...
DEFAULT_LLM_API_KEY=...
DEFAULT_LLM_MODEL=...
DEFAULT_EMBEDDING_MODEL=...
```

The app should fail closed when required secrets are missing.

## Setup Wizard

If setup has not been completed, route the admin to setup.

Wizard steps:

1. Create admin account.
2. Configure LLM API.
3. Test the model.
4. Upload sample document or skip.
5. Add database or REST API connector or skip.
6. Run a test chat.
7. Mark setup completed.

The goal is that an admin can reach a working chat with minimal decisions.

## REST API Connectors

REST API connectors are for business systems that expose HTTP APIs instead of direct database access.

Minimum production fields:

- Name.
- Base URL.
- Auth type:
  - none.
  - bearer token.
  - API key header.
- Encrypted auth config.
- Endpoint whitelist.
- Method.
- Path.
- Description.
- Parameter schema.
- Test request.
- Response sample or schema.
- Timeout.
- Enabled/disabled state.

Execution rules:

- The chatbot may only call enabled whitelist endpoints.
- Arbitrary URLs are not allowed.
- Secrets are never exposed to the LLM.
- Request and response logs are sanitized.
- Failures are visible in Monitoring.

## Database Connectors

Database access is read-only.

Rules:

- Enforce `SELECT` only.
- Apply row limits.
- Block destructive SQL.
- Prefer database credentials that are read-only at the database server level.
- Show generated SQL in citations.
- Record query history and latency.

The existing demo SQLite connector can remain for setup/demo, but production labels must make it clear when a connector is demo-backed versus real.

## Knowledge/RAG

The current keyword-based retrieval is acceptable for a demo but should be upgraded for production.

Production direction:

- Extract real text from supported files.
- Store chunks.
- Add embedding generation through the configured embedding API.
- Use vector or hybrid retrieval.
- Show citations.
- Provide a retrieval tester in the UI.

The first implementation plan can choose the smallest safe upgrade path, but the design target is real retrieval rather than synthetic binary-document text.

## External Chat API

The chatbot must be usable by other programs through a stable API.

Required endpoints:

```http
POST /api/v1/chat/completions
POST /api/v1/chat/sessions
GET  /api/v1/chat/sessions/:id
POST /api/v1/knowledge/search
POST /api/v1/tools/query
GET  /api/v1/health
```

### Chat Completion Request

Support an OpenAI-compatible shape:

```json
{
  "model": "default",
  "messages": [
    { "role": "user", "content": "Tampilkan invoice overdue bulan ini" }
  ],
  "stream": true
}
```

### Response Modes

Support:

- Non-streaming JSON response.
- Streaming Server-Sent Events.

### Auth

External programs authenticate with admin-created API keys:

```http
Authorization: Bearer ryas_xxx
```

API keys must be stored as hashes. The UI only shows the key once at creation time and later shows prefix, label, status, last-used time, and usage count.

### Response Provenance

Responses should include citations and tool runs:

```json
{
  "id": "chatcmpl_xxx",
  "answer": "Ada 12 invoice overdue bulan ini.",
  "citations": [
    {
      "type": "DATABASE",
      "source": "ERP Production",
      "query_used": "SELECT ..."
    },
    {
      "type": "REST_API",
      "source": "Invoice API",
      "endpoint": "GET /invoices"
    }
  ],
  "tool_runs": [
    {
      "type": "SQL",
      "status": "success",
      "latency_ms": 340
    }
  ]
}
```

## Security

Security requirements:

- Encrypt LLM API keys, database passwords, and REST API credentials with AES-256-GCM.
- Store external API keys as hashes.
- Disable demo auth in production.
- Enforce read-only SQL.
- Restrict REST API calls to endpoint whitelist.
- Sanitize logs.
- Audit all configuration changes.
- Audit all external API calls.
- Audit blocked SQL and failed tool runs.

## Error Handling

Expected failure states should be visible and actionable:

- LLM provider unavailable.
- Invalid API key.
- REST API timeout.
- REST API non-2xx response.
- SQL rejected by guardrails.
- Database connection failed.
- Document extraction failed.
- Retrieval returned no confident source.

UI errors should explain the next admin action instead of only showing a generic failure.

## Testing Strategy

Testing should focus on production risk:

- Unit tests for API key hashing and verification.
- Unit tests for REST API whitelist matching.
- Unit tests for SQL guardrails.
- Route tests for external chat API auth.
- Route tests for non-streaming chat completion.
- Route tests for knowledge search.
- Integration test for one REST API connector using a mocked endpoint.
- Smoke test for setup wizard path.

## Out of Scope for V1

- Local model inference.
- GPU/CUDA management.
- Model pulling/building.
- Multi-tenant UI.
- Multi-role user management.
- Dify-style visual workflow canvas.
- Public anonymous chat.
- Arbitrary web browsing by the model.
- Unrestricted REST API calls.

## Implementation Notes

The current application already has many useful pieces:

- Next.js app shell.
- Chat streaming UI.
- socket.io mini-service.
- Document upload and chunking.
- Integration UI.
- LLM config.
- Audit page.
- Prisma schema with singleton-compatible company/user models.

The implementation should preserve working surfaces and refactor incrementally rather than replacing the app wholesale.
