import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  // ponytail: DB drivers are loaded via `await import(name)` with a RUNTIME
  // variable in real-connectors.ts loadDriver() — output tracing cannot see a
  // dynamic specifier, so pg/mysql2/mssql/@clickhouse/client were silently
  // dropped from the standalone node_modules. Every "Data source provider"
  // connection then failed with "driver not installed" inside Docker while
  // working locally. Declaring them here forces them into the traced output.
  // Keep this list in sync with the loadDriver() call sites.
  outputFileTracingIncludes: {
    // Route globs — the driver set is shared across every entry point that can
    // reach loadDriver(): integration CRUD/test/query/schema, data-source
    // management, and the chat/tool execution routes (tool-router →
    // tool-branches/stream-preparers → real-connectors).
    "/api/integrations/**": [
      "./node_modules/pg/**",
      "./node_modules/mysql2/**",
      "./node_modules/mssql/**",
      "./node_modules/tedious/**",
      "./node_modules/@clickhouse/client/**",
    ],
    "/api/data-sources/**": [
      "./node_modules/pg/**",
      "./node_modules/mysql2/**",
      "./node_modules/mssql/**",
      "./node_modules/tedious/**",
      "./node_modules/@clickhouse/client/**",
    ],
    "/api/chat/**": [
      "./node_modules/pg/**",
      "./node_modules/mysql2/**",
      "./node_modules/mssql/**",
      "./node_modules/tedious/**",
      "./node_modules/@clickhouse/client/**",
    ],
    "/api/agent/**": [
      "./node_modules/pg/**",
      "./node_modules/mysql2/**",
      "./node_modules/mssql/**",
      "./node_modules/tedious/**",
      "./node_modules/@clickhouse/client/**",
    ],
    "/api/v1/chat/completions": [
      "./node_modules/pg/**",
      "./node_modules/mysql2/**",
      "./node_modules/mssql/**",
      "./node_modules/tedious/**",
      "./node_modules/@clickhouse/client/**",
    ],
    "/api/documents/**": [
      "./node_modules/pg/**",
      "./node_modules/mysql2/**",
      "./node_modules/mssql/**",
      "./node_modules/tedious/**",
      "./node_modules/@clickhouse/client/**",
    ],
  },
  serverExternalPackages: [
    "@cognee/cognee-ts",
    "@cognee/neon-linux-x64-gnu",
    "ioredis",
    "bullmq",
    // ponytail: DB drivers are require()'d at runtime through loadDriver()'s
    // dynamic import with a VARIABLE specifier — the bundler can neither trace
    // nor bundle that, and its failed attempt to resolve 'pg' at runtime broke
    // every data-source connection with "driver not installed" even in dev
    // (Turbopack rewrites the import to a bundled chunk lookup that misses).
    // external = left in node_modules, resolved by Node/Bun at runtime.
    "pg",
    "mysql2",
    "mssql",
    "tedious",
    "@clickhouse/client",
    // ponytail: OTel SDK packages are optional — dynamically imported in otel.ts
    // with try/catch. Listing here prevents the bundler from resolving them at
    // build time; they're require()'d at runtime only when OTEL_ENABLED=true.
    "@opentelemetry/sdk-node",
    "@opentelemetry/resources",
    "@opentelemetry/semantic-conventions",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-fetch",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/sdk-trace-base",
  ],
};

export default nextConfig;
