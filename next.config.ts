import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Enforce type-safety in production builds (previously silenced — hid real bugs).
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
};

export default nextConfig;
