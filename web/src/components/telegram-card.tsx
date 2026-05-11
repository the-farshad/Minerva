'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Send, Check } from 'lucide-react';

type State = { chatId: string; enabled: boolean; hasToken: boolean; tokenSuffix: string };

export function TelegramCard() {
  const [state, setState] = useState<State>({ chatId: '', enabled: false, hasToken: false, tokenSuffix: '' });
  const [tokenInput, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, []);

  async function load() {
    try {
      const r = await fetch('/api/telegram');
      if (r.ok) setState(await r.json());
    } catch { /* tolerate */ }
  }

  async function save() {
    setBusy(true);
    try {
      const r = await fetch('/api/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: state.chatId,
          enabled: state.enabled,
          botToken: tokenInput || undefined,
        }),
      });
      if (!r.ok) throw new Error(String(r.status));
      setTokenInput('');
      await load();
      toast.success('Saved.');
    } catch (e) {
      toast.error('Save failed: ' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      const r = await fetch('/api/telegram/test', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || String(r.status));
      toast.success('Test message sent.');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-zinc-500" />
        <strong className="text-sm">Telegram notifications</strong>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        BYO bot. Create one via <a className="underline" href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>,
        then DM your bot and grab the chat id from <code>https://api.telegram.org/bot&lt;token&gt;/getUpdates</code>.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Bot token</span>
          <input
            type="password"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder={state.hasToken ? `(set, ending ${state.tokenSuffix})` : 'paste token…'}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Chat id</span>
          <input
            type="text"
            value={state.chatId}
            onChange={(e) => setState((s) => ({ ...s, chatId: e.target.value }))}
            placeholder="e.g. 1234567890"
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      </div>

      <label className="mt-3 inline-flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => setState((s) => ({ ...s, enabled: e.target.checked }))}
        />
        Enable notifications (offline saves, bookmarklet drops)
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500 disabled:opacity-50"
        >
          <Check className="h-3 w-3" /> Save
        </button>
        <button
          type="button"
          onClick={test}
          disabled={busy || (!state.hasToken && !tokenInput) || !state.chatId}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <Send className="h-3 w-3" /> Send test
        </button>
      </div>
    </div>
  );
}
