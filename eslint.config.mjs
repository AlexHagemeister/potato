import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const FRAMEWORK_MESSAGE =
  "src/core and src/db must not import framework or UI code (CLAUDE.md architecture rule 3).";

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
    // Agent worktrees live under .claude/ and carry their own copies and builds.
    ".claude/**",
  ]),
  // The core layer holds all app logic and stays framework-free, so the UI,
  // the API, and the future MCP can all call it (CLAUDE.md architecture rule 3).
  // src/db gets the same framework bans, since core imports it.
  // Keep these blocks last so nothing after them overrides the rules.
  {
    files: ["src/core/**", "src/db/**"],
    rules: {
      // Framework and UI packages, static imports.
      "no-restricted-imports": [
        "error",
        {
          paths: ["next", "react", "react-dom", "server-only", "client-only"].map((name) => ({
            name,
            message: FRAMEWORK_MESSAGE,
          })),
          patterns: [
            {
              group: ["next/*", "next-*", "@next/*", "react/*", "react-dom/*"],
              message: FRAMEWORK_MESSAGE,
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        // Framework and UI packages, dynamic import(), which no-restricted-imports does not see.
        {
          selector:
            "ImportExpression[source.value=/^(next|react|react-dom|server-only|client-only)($|\\u002F)|^next-|^@next\\u002F/]",
          message: FRAMEWORK_MESSAGE,
        },
        // Only literal specifiers, so the rules above can check every dynamic import.
        {
          selector: "ImportExpression:not([source.type='Literal'])",
          message: "Dynamic import() in src/core and src/db must use a string literal specifier.",
        },
      ],
    },
  },
  {
    files: ["src/core/**"],
    rules: {
      // Local code: core may import only itself, the database layer, and packages.
      // Resolved paths, so aliases (@/app/...), relative paths, next.config, and import() are covered.
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: "./",
              except: ["./src/core", "./src/db", "./node_modules"],
              message: "src/core may import only from src/core, src/db, and packages.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
