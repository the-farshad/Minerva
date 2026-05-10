import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db, schema } from '@/db';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  // Behind Cloudflare → Caddy → Next, the request's Host header is
  // the public hostname (next.thefarshad.com), not the container's
  // internal one. Auth.js v5 errors with "UntrustedHost" until we
  // explicitly opt in.
  trustHost: true,
  session: { strategy: 'database' },
  providers: [
    Google({
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: SCOPES,
          access_type: 'offline',
          prompt: 'consent',
        },
      },
      // Google's authorization response sometimes omits the `iss`
      // query parameter that the strict OAuth 2.1 BCP requires.
      // The id_token always carries it, so dropping the URL-level
      // check is safe and matches Auth.js's documented workaround.
      checks: ['pkce', 'state'],
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      // Surface the user id to client components so per-user
      // queries can skip a re-fetch.
      if (session.user) (session.user as { id?: string }).id = user.id;
      return session;
    },
  },
  pages: { signIn: '/sign-in' },
});
