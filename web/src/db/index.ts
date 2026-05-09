import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

declare global {
  // Reuse the Postgres client across HMR reloads in dev.
  // eslint-disable-next-line no-var
  var __minervaPg: postgres.Sql | undefined;
}

// Lazy connection — defer the postgres client until the first query
// runs so `next build` can collect routes without DATABASE_URL set
// (Vercel / CI environments where the URL is injected at runtime).
function makeClient(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Configure it in .env.local for dev or in the runtime environment for production.');
  }
  return postgres(url, { prepare: false });
}

const client = global.__minervaPg ?? makeClient();
if (process.env.NODE_ENV !== 'production') global.__minervaPg = client;

export const db = drizzle(client, { schema });
export { schema };
