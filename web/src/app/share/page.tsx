import type { Metadata } from 'next';
import { ShareComposer } from './share-composer';

export const metadata: Metadata = { title: 'Quick share' };

export default function SharePage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Quick share</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Build a public card — note, question, or poll — and get a stable URL. The data lives
        <em> in the URL itself</em>, so nothing is uploaded; anyone with the link sees the same card you do.
      </p>
      <ShareComposer />
    </main>
  );
}
