import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  serverExternalPackages: ["@cognee/cognee-ts", "@cognee/neon-linux-x64-gnu", "ioredis", "bullmq"],
};

export default nextConfig;
