'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, ExternalLink } from 'lucide-react';
import { shareUrl, type SharePayload } from '@/lib/share';
import { ShareCard } from '@/components/share-card';

export function ShareComposer() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [choicesText, setChoicesText] = useState('');
  const [kind, setKind] = useState<SharePayload['kind']>('note');

  const payload: SharePayload | null = useMemo(() => {
    const choices = choicesText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!title.trim() && !body.trim()) return null;
    const effectiveKind: SharePayload['kind'] =
      choices.length && kind === 'note' ? 'poll' : kind;
    const p: SharePayload = { kind: effectiveKind, title: title.trim(), body: body.trim() };
    if (choices.length) p.choices = choices;
    return p;
  }, [title, body, choicesText, kind]);

  const url = payload ? shareUrl(payload) : '';

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('Copy failed — select the URL manually.');
    }
  }

  return (
    <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-2">
      <div className="space-y-4">
        <label className="block">
          <span className="text-xs font-medium">Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Lunch poll"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium">Body / question</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="What should we eat on Friday?"
            rows={3}
            className="mt-1 w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium">Choices (one per line — turns it into a poll)</span>
          <textarea
            value={choicesText}
            onChange={(e) => setChoicesText(e.target.value)}
            placeholder={'Pizza\nSushi\nThai'}
            rows={4}
            className="mt-1 w-full resize-y rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SharePayload['kind'])}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="note">Note</option>
            <option value="question">Question</option>
            <option value="poll">Poll</option>
          </select>
        </label>
        {payload && url ? (
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <input
              readOnly
              value={url}
              className="w-full truncate rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-800"
              onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={copy}
                className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500"
              >
                <Copy className="h-3 w-3" /> Copy link
              </button>
              <a
                href={url}
                target="_blank"
                rel="noopener"
                className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                <ExternalLink className="h-3 w-3" /> Open public view
              </a>
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            Fill in a title or body to generate a sharable link.
          </p>
        )}
      </div>
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Preview</h2>
        <div className="mt-3">
          <ShareCard payload={payload} />
        </div>
      </div>
    </div>
  );
}
