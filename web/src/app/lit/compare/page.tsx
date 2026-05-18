import { Suspense } from 'react';
import { CompareView } from './compare-view';

export const metadata = { title: 'Compare — Literature' };
export const dynamic = 'force-static';

export default function ComparePage() {
  return (
    <Suspense fallback={null}>
      <CompareView />
    </Suspense>
  );
}
