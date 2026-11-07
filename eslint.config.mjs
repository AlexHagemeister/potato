import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // The core layer holds all app logic and stays framework-free, so the UI,
  // the API, and the future MCP can all call it (CLAUDE.md architecture rule 3).
  // Keep this block last so nothing after it overrides the rule.
  {
    files: ["src/core/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "next", message: "src/core must not import framework code." },
            { name: "react", message: "src/core must not import UI code." },
            { name: "react-dom", message: "src/core must not import UI code." },
          ],
          patterns: [
            { group: ["next/*"], message: "src/core must not import framework code." },
            { group: ["react/*", "react-dom/*"], message: "src/core must not import UI code." },
            {
              group: ["@/app", "@/app/*", "**/app", "**/app/*"],
              message: "src/core must not import from src/app.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
