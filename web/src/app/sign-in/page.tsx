import { signIn, auth } from '@/auth';
import { redirect } from 'next/navigation';

export const metadata = { title: 'Sign in — Minerva' };

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect('/');
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        {/* Wordmark — quiet, type-only. No card chrome around the
          * sign-in flow; the page IS the sign-in. */}
        <div className="mb-10 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Minerva
          </h1>
          <p className="mt-2 text-sm text-zinc-500">
            Schema-driven planner · your data, your Drive.
          </p>
        </div>

        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: '/' });
          }}
          className="space-y-3"
        >
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center gap-2.5 rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 active:scale-[0.99] dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <GoogleGlyph />
            Continue with Google
          </button>
        </form>

        <p className="mt-8 text-center text-[11px] leading-relaxed text-zinc-500">
          Minerva requests only <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">drive.file</code> + email
          — it can only see files it created itself, never the rest of your Drive.
        </p>
      </div>
    </main>
  );
}

/** Google "G" glyph as inline SVG so the button stays crisp on
 *  every BG / theme and doesn't rely on a CDN icon font. */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.7 4.7-6.2 8-11.3 8a12 12 0 1 1 0-24c3 0 5.7 1.1 7.8 3l5.7-5.7A20 20 0 1 0 24 44a20 20 0 0 0 19.6-15.5c.3-1 .4-2.1.4-3.5 0-1.6-.2-3.1-.4-4.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8A12 12 0 0 1 24 12c3 0 5.7 1.1 7.8 3l5.7-5.7A20 20 0 0 0 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44a20 20 0 0 0 13.5-5.2l-6.2-5.2a12 12 0 0 1-18-6.3l-6.5 5A20 20 0 0 0 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4 5.5l6.2 5.2c-.4.4 6.5-4.7 6.5-14.7 0-1.6-.2-3.1-.4-4.5z" />
    </svg>
  );
}
