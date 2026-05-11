'use client';

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, Sparkles, Send } from 'lucide-react';
import Link from 'next/link';
import { ask, buildContext, readCfg, defaultModel, type AiMessage } from '@/lib/ai';

type Quick = {
  label: string;
  build: () => Promise<AiMessage[]>;
};

const QUICKS: Quick[] = [
  {
    label: 'Summarize my week',
    build: async () => {
      const ctx = await buildContext({ includeNotes: true });
      return [
        { role: 'system', content: 'You are a concise planning assistant. Use the user\'s data below to write a short markdown summary of their last week — what shipped, what slipped, themes. Keep it tight: 5–10 bullet points.\n\n' + ctx },
        { role: 'user', content: 'Summarize my week.' },
      ];
    },
  },
  {
    label: 'Suggest a next action',
    build: async () => {
      const ctx = await buildContext();
      return [
        { role: 'system', content: 'You are a focused planning assistant. Given the user\'s tasks/goals/projects below, propose ONE next concrete action they should take right now — not a list, just the single most-leveraged thing — with a one-sentence rationale.\n\n' + ctx },
        { role: 'user', content: 'What should I do next?' },
      ];
    },
  },
  {
    label: 'Find duplicates',
    build: async () => {
      const ctx = await buildContext({ includeNotes: true });
      return [
        { role: 'system', content: 'You are a librarian for the user\'s planning data. Scan the rows below and report any likely duplicates or overlaps — same intent under different wording, near-identical titles, etc. Output as a short markdown list grouped by section.\n\n' + ctx },
        { role: 'user', content: 'Find likely duplicates across my data.' },
      ];
    },
  },
  {
    label: 'Cluster my notes',
    build: async () => {
      const ctx = await buildContext({ includeNotes: true });
      return [
        { role: 'system', content: 'You are a librarian. Cluster the user\'s notes into 3–6 themes; for each theme, list the matching note titles as a sublist. Markdown output.\n\n' + ctx },
        { role: 'user', content: 'Cluster my notes into themes.' },
      ];
    },
  },
];

const SYSTEM_FREEFORM =
  'You are a concise planning assistant for the Minerva personal-planning app. Reply in markdown when listing or structuring information.';

export function AiOverlay() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => taRef.current?.focus(), 50);
  }, [open]);

  const cfg = readCfg();
  const hasProvider = !!(cfg.provider && (cfg.apiKey || cfg.provider === 'ollama'));

  async function send(messages: AiMessage[]) {
    if (sending) return;
    setSending(true);
    setReply('Thinking…');
    try {
      const r = await ask(messages, { maxTokens: 2048 });
      setReply((r.text || '').trim() || '(empty response)');
    } catch (e) {
      setReply(`Request failed: ${(e as Error).message}\n\nCommon causes: missing/invalid API key, CORS blocked (try Ollama or a BYO proxy), wrong model name.`);
    } finally {
      setSending(false);
    }
  }

  function sendFree() {
    const text = input.trim();
    if (!text) return;
    void send([
      { role: 'system', content: SYSTEM_FREEFORM },
      { role: 'user', content: text },
    ]);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(720px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
          <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <Sparkles className="h-4 w-4 text-zinc-500" />
            <Dialog.Title className="flex-1 text-sm font-medium">AI assistant</Dialog.Title>
            <span className="text-xs text-zinc-500">
              {hasProvider
                ? <>Provider: <strong>{cfg.provider}</strong> · model: <em>{cfg.model || defaultModel(cfg.provider!)}</em> · <Link href="/settings" onClick={() => setOpen(false)} className="underline">change</Link></>
                : <>No provider configured. <Link href="/settings" onClick={() => setOpen(false)} className="underline">Open Settings</Link></>}
            </span>
            <Dialog.Close
              aria-label="Close"
              className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </header>

          <div className="flex flex-wrap gap-1.5 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            {QUICKS.map((q) => (
              <button
                key={q.label}
                type="button"
                disabled={!hasProvider || sending}
                onClick={async () => {
                  const msgs = await q.build();
                  void send(msgs);
                }}
                className="rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-800 dark:hover:bg-zinc-800"
              >
                {q.label}
              </button>
            ))}
          </div>

          <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
            <div className="flex gap-2">
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    sendFree();
                  }
                }}
                placeholder="Ask the assistant…  (⌘/Ctrl+Enter to send)"
                rows={3}
                className="flex-1 resize-none rounded-md border border-zinc-300 bg-white p-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={sendFree}
                disabled={!hasProvider || sending || !input.trim()}
                className="inline-flex items-center gap-1 self-start rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
              >
                <Send className="h-3 w-3" /> Send
              </button>
            </div>
            {reply !== null && (
              <pre className="whitespace-pre-wrap rounded-md bg-zinc-50 p-3 text-xs leading-relaxed dark:bg-zinc-900">
                {reply}
              </pre>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
