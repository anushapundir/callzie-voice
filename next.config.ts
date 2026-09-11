import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run needs a self-contained server bundle, not a .next/ + node_modules pair.
  // See docs/adr/0001-gcp-deploy-target.md.
  output: "standalone",
};

export default nextConfig;
