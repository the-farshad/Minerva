'use client';

import { useRouter } from 'next/navigation';
import { CalendarView } from '@/components/calendar-view';

type Row = {
  id: string;
  data: Record<string, unknown>;
  updatedAt: string;
  sectionSlug: string;
  sectionTitle: string;
};

export function ScheduleView({ rows }: { rows: Row[] }) {
  const router = useRouter();
  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Schedule</h1>
        <p className="text-sm text-zinc-500">
          Every dated row across your sections.
        </p>
      </header>
      <CalendarView
        rows={rows}
        onOpen={(r) => {
          const sl = (r as Row).sectionSlug;
          if (sl) router.push(`/s/${encodeURIComponent(sl)}`);
        }}
      />
    </main>
  );
}
