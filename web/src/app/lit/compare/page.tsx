import { Suspense } from 'react';
import { CompareView } from './compare-view';

export const metadata = { title: 'Compare — Literature' };
// Not force-static — the page renders a client component that
// reads localStorage on mount, so pre-rendering it as static HTML
// gave the user an HTML shell that never reached the client hook
// when JS hydrated. Letting Next render it dynamically (the
// default for routes that import client components) fixes the
// "click Compare and nothing happens" symptom.

export default function ComparePage() {
  return (
    <Suspense fallback={null}>
      <CompareView />
    </Suspense>
  );
}
