import { Suspense } from 'react';
import { PathView } from './path-view';

export const metadata = { title: 'Path — Literature' };
// Removed force-static for the same reason as /lit/compare —
// PathView reads ?from=&to= via useSearchParams and force-static
// produced a broken interaction with the Suspense boundary.

export default function PathPage() {
  return (
    <Suspense fallback={null}>
      <PathView />
    </Suspense>
  );
}
