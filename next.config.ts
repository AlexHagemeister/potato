import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // next dev otherwise writes an AGENTS.md into the repo on every run.
  // Agent instructions for this project live in CLAUDE.md.
  agentRules: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
