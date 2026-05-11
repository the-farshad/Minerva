import type { SharePayload } from '@/lib/share';

export function ShareCard({ payload }: { payload: SharePayload | null }) {
  if (!payload) {
    return (
      <article className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900/50">
        Empty preview. Fill in the form to render a card.
      </article>
    );
  }
  const kindLabel = payload.kind.charAt(0).toUpperCase() + payload.kind.slice(1);
  return (
    <article className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{kindLabel}</div>
      {payload.title && (
        <h3 className="mt-1 text-xl font-semibold tracking-tight">{payload.title}</h3>
      )}
      {payload.body && (
        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">
          {payload.body}
        </p>
      )}
      {payload.choices && payload.choices.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {payload.choices.map((c, i) => (
            <li
              key={`${i}-${c}`}
              className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm dark:border-zinc-800"
            >
              {c}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
