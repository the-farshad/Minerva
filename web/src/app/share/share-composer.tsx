'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { notify } from '@/lib/notify';
import { Copy, ExternalLink, Lock } from 'lucide-react';
import { shareUrl, shareUrlEncrypted, type SharePayload } from '@/lib/share';
import { ShareCard } from '@/components/share-card';

export function ShareComposer() {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [choicesText, setChoicesText] = useState('');
  const [kind, setKind] = useState<SharePayload['kind']>('note');
  const [code, setCode] = useState('');

  const payload: SharePayload | null = useMemo(() => {
    const choices = choicesText.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!title.trim() && !body.trim()) return null;
    const effectiveKind: SharePayload['kind'] =
      choices.length && kind === 'note' ? 'poll' : kind;
    const p: SharePayload = { kind: effectiveKind, title: title.trim(), body: body.trim() };
    if (choices.length) p.choices = choices;
    return p;
  }, [title, body, choicesText, kind]);

  // The link is sync for a plain share but async when an access
  // code is set (key derivation), so it lives in state and is
  // recomputed by an effect rather than a useMemo.
  const [url, setUrl] = useState('');
  const codeProtected = code.trim().length > 0;
  useEffect(() => {
    if (!payload) { setUrl(''); return; }
    const trimmed = code.trim();
    if (!trimmed) { setUrl(shareUrl(payload)); return; }
    let cancelled = false;
    void shareUrlEncrypted(payload, trimmed).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [payload, code]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      notify.error('Copy failed — select the URL manually.');
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
        <label className="block">
          <span className="flex items-center gap-1 text-xs font-medium">
            <Lock className="h-3 w-3" /> Access code <span className="font-normal text-zinc-400">(optional)</span>
          </span>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Leave blank for an open link"
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <span className="mt-1 block text-[11px] text-zinc-500">
            {codeProtected
              ? 'The card is encrypted with this code — recipients must enter it to view. It is never sent to any server; share it separately from the link.'
              : 'With a code set, the share link is encrypted end-to-end and unreadable without it.'}
          </span>
        </label>
        {payload && url ? (
          <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            {codeProtected && (
              <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                <Lock className="h-3 w-3" /> Code-protected — recipients need the code
              </span>
            )}
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
                className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-zinc-900"
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
