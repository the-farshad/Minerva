import { Suspense } from 'react';
import { PathView } from './path-view';

export const metadata = { title: 'Path — Literature' };
export const dynamic = 'force-static';

export default function PathPage() {
  return (
    <Suspense fallback={null}>
      <PathView />
    </Suspense>
  );
}
