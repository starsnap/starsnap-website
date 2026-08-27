import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Keep the historical SQLite/D1 snapshots intact for the one-time ETL.
  // New generated migrations must use PostgreSQL metadata.
  out: './drizzle-postgres',
  schema: './db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://mealops:mealops@localhost:5432/mealops',
  },
});
