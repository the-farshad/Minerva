'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Sparkles, X } from 'lucide-react';
import { appConfirm } from './confirm';
import {
  readCfg, writeCfg, clearCfg, defaultEndpoint, defaultModel, ask,
  type AiCfg, type AiProvider,
} from '@/lib/ai';

const PROVIDERS: { v: AiProvider; label: string }[] = [
  { v: 'anthropic', label: 'Anthropic (Claude)' },
  { v: 'openai',    label: 'OpenAI' },
  { v: 'ollama',    label: 'Ollama (local)' },
  { v: 'byo',       label: 'BYO endpoint (OpenAI-compatible)' },
];

export function AiCard() {
  const [cfg, setCfg] = useState<AiCfg>({});
  const [testing, setTesting] = useState(false);
  const [reply, setReply] = useState<string | null>(null);

  useEffect(() => { setCfg(readCfg()); }, []);

  const provider = cfg.provider || 'anthropic';

  function update<K extends keyof AiCfg>(k: K, v: AiCfg[K]) {
    setCfg((c) => ({ ...c, [k]: v }));
  }
  function save() {
    const next: AiCfg = {
      provider,
      apiKey: cfg.apiKey?.trim() || '',
      endpoint: cfg.endpoint?.trim() || '',
      model: cfg.model?.trim() || '',
    };
    writeCfg(next);
    setCfg(next);
    toast.success('AI settings saved.');
  }
  async function test() {
    if (testing) return;
    setTesting(true);
    setReply(null);
    try {
      const r = await ask([
        { role: 'system', content: 'You are a terse assistant.' },
        { role: 'user', content: 'Reply with the word "ready".' },
      ], { maxTokens: 32 });
      setReply((r.text || '').trim() || '(empty response)');
    } catch (e) {
      setReply('Error: ' + (e as Error).message);
    } finally {
      setTesting(false);
    }
  }
  async function clearAll() {
    const ok = await appConfirm('Clear AI settings?', { dangerLabel: 'Clear' });
    if (!ok) return;
    clearCfg();
    setCfg({});
    setReply(null);
    toast.success('Cleared.');
  }

  const ready = !!(cfg.provider && (cfg.apiKey || cfg.provider === 'ollama'));

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-zinc-500" />
        <strong className="text-sm">AI assistant</strong>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        BYO API key. Open with <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1 py-0.5 text-[10px] dark:border-zinc-700 dark:bg-zinc-800">⌘/Ctrl + J</kbd>.
        Prompts go directly from your browser to the configured endpoint — Minerva never proxies AI traffic.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Provider</span>
          <select
            value={provider}
            onChange={(e) => update('provider', e.target.value as AiProvider)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            {PROVIDERS.map((p) => (
              <option key={p.v} value={p.v}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">API key</span>
          <input
            type="password"
            value={cfg.apiKey || ''}
            onChange={(e) => update('apiKey', e.target.value)}
            placeholder={provider === 'ollama' ? 'not needed for Ollama' : 'sk-…'}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Endpoint</span>
          <input
            type="text"
            value={cfg.endpoint || ''}
            onChange={(e) => update('endpoint', e.target.value)}
            placeholder={defaultEndpoint(provider)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">Model</span>
          <input
            type="text"
            value={cfg.model || ''}
            onChange={(e) => update('model', e.target.value)}
            placeholder={defaultModel(provider)}
            className="rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500"
        >
          Save
        </button>
        <button
          type="button"
          onClick={test}
          disabled={!ready || testing}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-3 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <X className="h-3 w-3" /> Clear
        </button>
      </div>
      {reply && (
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2 text-xs dark:bg-zinc-800/50">
          {reply}
        </pre>
      )}
      <p className="mt-3 text-xs text-zinc-500">
        Anthropic uses the browser-direct beta header. Ollama runs against a local server (set
        {' '}<code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">OLLAMA_ORIGINS=*</code> on it).
        BYO points at any OpenAI-compatible endpoint (LM Studio, vLLM, OpenRouter…).
      </p>
    </div>
  );
}
