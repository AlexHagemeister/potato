import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const FRAMEWORK_MESSAGE = "src/core must not import framework or UI code (CLAUDE.md architecture rule 3).";

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
  // Keep this block last so nothing after it overrides these rules.
  {
    files: ["src/core/**"],
    rules: {
      // Local code: core may import only itself and the database layer.
      // Resolved paths, so aliases (@/app/...), relative paths, and import() are all covered.
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./src/core",
              from: "./src",
              except: ["./core", "./db"],
              message: "src/core may import only from src/core and src/db.",
            },
          ],
        },
      ],
      // Framework and UI packages, static imports.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "next", message: FRAMEWORK_MESSAGE },
            { name: "react", message: FRAMEWORK_MESSAGE },
            { name: "react-dom", message: FRAMEWORK_MESSAGE },
          ],
          patterns: [{ group: ["next/*", "react/*", "react-dom/*"], message: FRAMEWORK_MESSAGE }],
        },
      ],
      // Framework and UI packages, dynamic import(), which no-restricted-imports does not see.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^(next|react|react-dom)($|\\u002F)/]",
          message: FRAMEWORK_MESSAGE,
        },
      ],
    },
  },
]);

export default eslintConfig;
