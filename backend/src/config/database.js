import { PrismaClient } from '../generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './environment.js';

const adapter = new PrismaPg({ connectionString: config.databaseUrl });

const prisma = new PrismaClient({ adapter });

// Test the database connection by running a simple query.
// Returns true if connected, throws if not.
async function testDatabaseConnection() {
  await prisma.$queryRawUnsafe('SELECT 1');
  return true;
}

export { prisma, testDatabaseConnection };
