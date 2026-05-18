import { auth } from '@/auth';
import { redirect } from 'next/navigation';
import { SharesView } from './shares-view';

export const metadata = { title: 'Shares — Minerva' };
export const dynamic = 'force-dynamic';

export default async function SharesPage() {
  const session = await auth();
  if (!session?.user) redirect('/sign-in');
  return <SharesView />;
}
