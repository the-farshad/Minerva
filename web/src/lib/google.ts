/**
 * Per-user Google API token resolver. Reads the access_token cached
 * on the user's `accounts` row, refreshes via the refresh_token when
 * it has expired, and returns a freshly-valid bearer string.
 *
 * NextAuth stores the refresh_token only when access_type=offline +
 * prompt=consent are passed at sign-in (configured in src/auth.ts).
 */
import { eq, and } from 'drizzle-orm';
import { db, schema } from '@/db';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  refresh_token?: string;
}

export async function getGoogleAccessToken(userId: string): Promise<string> {
  const row = await db.query.accounts.findFirst({
    where: and(
      eq(schema.accounts.userId, userId),
      eq(schema.accounts.provider, 'google'),
    ),
  });
  if (!row) throw new Error('No Google account linked.');

  const now = Math.floor(Date.now() / 1000);
  const margin = 60; // refresh 1 min before expiry
  if (row.access_token && row.expires_at && row.expires_at - margin > now) {
    return row.access_token;
  }
  if (!row.refresh_token) {
    throw new Error('Access token expired and no refresh token on file. Sign in again.');
  }

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    grant_type: 'refresh_token',
    refresh_token: row.refresh_token,
  });
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Google token refresh failed: ${resp.status} ${text}`);
  }
  const json = (await resp.json()) as RefreshResponse;
  await db.update(schema.accounts)
    .set({
      access_token: json.access_token,
      expires_at: now + json.expires_in,
      // Some refresh responses omit refresh_token (Google reuses the
      // existing one); only overwrite when the response carries one.
      ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}),
    })
    .where(and(
      eq(schema.accounts.userId, userId),
      eq(schema.accounts.provider, 'google'),
    ));
  return json.access_token;
}
