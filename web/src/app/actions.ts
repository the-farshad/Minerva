'use server';

import { signOut } from '@/auth';

/** Sign out via NextAuth server action — used by forms in Nav and
 * Settings. Bouncing through the API route required a CSRF token
 * the SPA wasn't sending. */
export async function signOutAction() {
  await signOut({ redirectTo: '/sign-in' });
}
