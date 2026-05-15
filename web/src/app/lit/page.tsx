/**
 * Public, read-only "literature" view of a single configured
 * user's papers section. Lives under `/lit` on minerva.thefarshad.com
 * and is intended to be served at lit.thefarshad.com via a CNAME
 * + reverse-proxy rule — no auth required, no sign-in prompt.
 *
 * Gating: the env var `PUBLIC_LIT_USER_EMAIL` names the one account
 * whose papers are publicly exposed. If it's not set, the page
 * 404s — no accidental leak of someone else's library.
 *
 * Only the rows of the user's `papers`-preset section are shown,
 * and only public-safe fields (title, authors, year, venue,
 * citation count, public URL). Drive offline copies and any
 * underscore-prefixed internal markers are filtered out.
 */
import { notFound } from 'next/navigation';
import { db, schema } from '@/db';
import { and, desc, eq } from 'drizzle-orm';

export const metadata = { title: 'Literature' };
// Reads from env + DB at request time. Not statically prerenderable.
export const dynamic = 'force-dynamic';

type RowData = Record<string, unknown>;

function publicUrl(d: RowData): string {
  const url = String(d.url || '');
  if (url && /^https?:\/\//i.test(url)) return url;
  const doi = String(d.doi || '');
  if (doi) return `https://doi.org/${doi}`;
  const arxiv = String(d.arxiv || '');
  if (arxiv) return `https://arxiv.org/abs/${arxiv}`;
  return '';
}

export default async function LitPage() {
  const email = process.env.PUBLIC_LIT_USER_EMAIL?.trim();
  if (!email) notFound();

  const user = await db.query.users.findFirst({
    where: eq(schema.users.email, email),
  });
  if (!user) notFound();

  const section = await db.query.sections.findFirst({
    where: and(
      eq(schema.sections.userId, user.id),
      eq(schema.sections.preset, 'papers'),
      eq(schema.sections.enabled, true),
    ),
  });
  if (!section) notFound();

  const rows = await db.query.rows.findMany({
    where: and(
      eq(schema.rows.userId, user.id),
      eq(schema.rows.sectionId, section.id),
      eq(schema.rows.deleted, false),
    ),
    orderBy: [desc(schema.rows.updatedAt)],
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8 border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <h1 className="text-3xl font-semibold tracking-tight">Literature</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Papers I&rsquo;m reading and have read &mdash; updated as I add new ones in my library.
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No papers yet.</p>
      ) : (
        <ul className="space-y-4">
          {rows.map((r) => {
            const d = r.data as RowData;
            const title = String(d.title || d.name || '(untitled)');
            const authors = String(d.authors || '');
            const year = d.year ? String(d.year) : '';
            const venue = String(d.venue || d.journal || '');
            const abstract = String(d.abstract || '');
            const cc = typeof d.citationCount === 'number' ? d.citationCount : null;
            const link = publicUrl(d);
            return (
              <li
                key={r.id}
                className="rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {link ? (
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener"
                      className="text-base font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {title}
                    </a>
                  ) : (
                    <span className="text-base font-medium text-zinc-900 dark:text-zinc-100">{title}</span>
                  )}
                  {year && <span className="text-sm text-zinc-500">{year}</span>}
                  {cc !== null && cc > 0 && (
                    <span
                      title="Citations (Semantic Scholar)"
                      className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {cc >= 1000 ? `${(cc / 1000).toFixed(cc >= 10_000 ? 0 : 1)}k` : cc} cites
                    </span>
                  )}
                </div>
                {(authors || venue) && (
                  <div className="mt-1 text-sm text-zinc-500">
                    {authors}
                    {authors && venue ? ' · ' : ''}
                    {venue}
                  </div>
                )}
                {abstract && (
                  <p className="mt-2 line-clamp-3 text-sm leading-snug text-zinc-600 dark:text-zinc-400">
                    {abstract}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <footer className="mt-12 text-center text-xs text-zinc-400">
        <a href="https://thefarshad.com" className="hover:underline">thefarshad.com</a>
        <span className="mx-2">&middot;</span>
        <a href="https://minerva.thefarshad.com" className="hover:underline">powered by Minerva</a>
      </footer>
    </main>
  );
}
