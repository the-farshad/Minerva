import type { Metadata } from 'next';
import { PublicShareView } from './public-share-view';

export const metadata: Metadata = { title: 'Shared card' };

export default function PublicSharePage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <PublicShareView />
    </main>
  );
}
