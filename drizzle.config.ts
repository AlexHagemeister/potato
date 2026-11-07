import { defineConfig } from "drizzle-kit";

// Generation only: `bun run db:generate` diffs src/db/schema.ts against the
// snapshots in drizzle/ and needs no database. Migrations are applied by
// scripts/migrate.ts, which names its target database before it runs.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
