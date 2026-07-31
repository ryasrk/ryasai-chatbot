import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  serverExternalPackages: [
    "@cognee/cognee-ts",
    "@cognee/neon-linux-x64-gnu",
    "ioredis",
    "bullmq",
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
