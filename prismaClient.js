// Shared Prisma Client singleton for the Postgres/Supabase side of the
// migration. Prisma connects lazily on first query, so requiring this file
// has no effect until something actually calls a Prisma method - safe to
// import even while SUPABASE_ENABLED=false.
// Mirrors grfmxstatusupdate's data/prismaClient.js.
const { PrismaClient } = require('@prisma/client');

const prisma = global.__prisma || new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
    global.__prisma = prisma;
}

module.exports = prisma;
