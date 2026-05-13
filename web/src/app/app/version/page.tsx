/**
 * Friendly alias for /api/version — the URL pattern users keep
 * typing (the prefix `/app/` is mental shorthand for "the app",
 * even though the actual JSON endpoint lives at /api/version). This
 * page renders the same data plus a small label so a browser visit
 * shows something readable instead of bare JSON.
 *
 * Read at request time (no caching) so the value reflects what's
 * actually deployed.
 */
export const dynamic = 'force-dynamic';

export default function VersionPage() {
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA || 'unknown';
  const sha7 = sha === 'unknown' ? 'unknown' : sha.slice(0, 7);
  const built = process.env.NEXT_PUBLIC_BUILD_TIME || '';
  return (
    <main className="mx-auto max-w-md p-6 font-mono text-sm">
      <h1 className="mb-3 text-lg font-bold">Minerva · Version</h1>
      <dl className="space-y-1">
        <div className="flex gap-2"><dt className="w-20 text-zinc-500">sha</dt><dd>{sha}</dd></div>
        <div className="flex gap-2"><dt className="w-20 text-zinc-500">sha7</dt><dd>{sha7}</dd></div>
        {built && (
          <div className="flex gap-2"><dt className="w-20 text-zinc-500">built</dt><dd>{built}</dd></div>
        )}
      </dl>
      <p className="mt-4 text-[11px] text-zinc-500">
        JSON endpoint: <a href="/api/version" className="underline">/api/version</a>
      </p>
    </main>
  );
}
