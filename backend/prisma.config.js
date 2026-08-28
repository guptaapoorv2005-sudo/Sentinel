// Prisma 7 configuration file.
//
// In Prisma 7, the database connection URL moved out of schema.prisma
// and into this config file. This keeps the schema focused on data models
// and gives us programmatic control over configuration.
//
// WHY THIS FILE EXISTS:
// Prisma 7 is a major version that made the connection URL a runtime concern
// (passed via adapter to PrismaClient) rather than a schema concern.
// This config file tells the Prisma CLI (migrations, generate) where to find
// the database.

import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

export default defineConfig({
  earlyAccess: true,
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  migrate: {
    async resolveAdapter() {
      const { PrismaPg } = await import("@prisma/adapter-pg");
      return new PrismaPg({ connectionString: process.env.DATABASE_URL });
    },
  },
});
