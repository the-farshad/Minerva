import { signIn, auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect('/');
  return (
    <div className="grid min-h-screen place-items-center px-6">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 text-center shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Welcome to Minerva</h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Schema-driven planner. Your data lives in your own Google Drive.
        </p>
        <form action={async () => {
          'use server';
          await signIn('google', { redirectTo: '/' });
        }}>
          <button
            type="submit"
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            <span aria-hidden>🔑</span> Sign in with Google
          </button>
        </form>
        <p className="mt-6 text-xs text-zinc-500">
          We request the minimum scopes needed: <code>drive.file</code> +
          email. We can only see files Minerva itself created.
        </p>
      </div>
    </div>
  );
}
