/**
 * AI assistant — BYO key client.
 *
 * Nothing in this module sends data anywhere except the
 * user-configured endpoint. Minerva never proxies AI traffic — the
 * browser talks to Anthropic / OpenAI / Ollama / BYO directly using
 * the user's own credentials.
 *
 * Providers:
 *   anthropic — POST /v1/messages, browser-direct beta header.
 *   openai    — POST /v1/chat/completions.
 *   ollama    — POST http://localhost:11434/api/chat (no auth).
 *   byo       — Any OpenAI-compatible chat-completions endpoint.
 */

const STORE = 'minerva.v2.ai';

export type AiProvider = 'anthropic' | 'openai' | 'ollama' | 'byo';

export type AiCfg = {
  provider?: AiProvider;
  apiKey?: string;
  endpoint?: string;
  model?: string;
};

export type AiMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function readCfg(): AiCfg {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') as AiCfg; }
  catch { return {}; }
}
export function writeCfg(patch: AiCfg): AiCfg {
  const next = { ...readCfg(), ...patch };
  localStorage.setItem(STORE, JSON.stringify(next));
  return next;
}
export function clearCfg() {
  localStorage.removeItem(STORE);
}

export function defaultEndpoint(provider: AiProvider): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com/v1/messages';
    case 'openai':    return 'https://api.openai.com/v1/chat/completions';
    case 'ollama':    return 'http://localhost:11434/api/chat';
    default:          return '';
  }
}
export function defaultModel(provider: AiProvider): string {
  switch (provider) {
    case 'anthropic': return 'claude-sonnet-4-6';
    case 'openai':    return 'gpt-4o';
    case 'ollama':    return 'llama3';
    default:          return '';
  }
}

async function askAnthropic(cfg: AiCfg, messages: AiMessage[], maxTokens: number) {
  if (!cfg.apiKey) throw new Error('Anthropic API key missing.');
  const url = cfg.endpoint || defaultEndpoint('anthropic');
  let systemPrompt = '';
  const conv: AiMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemPrompt += (systemPrompt ? '\n\n' : '') + m.content;
    else conv.push(m);
  }
  const body: Record<string, unknown> = {
    model: cfg.model || defaultModel('anthropic'),
    max_tokens: maxTokens,
    messages: conv,
  };
  if (systemPrompt) body.system = systemPrompt;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const data = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  return { text, raw: data };
}

async function askOpenAILike(cfg: AiCfg, messages: AiMessage[], maxTokens: number, label: string) {
  const url = cfg.endpoint || defaultEndpoint(cfg.provider || 'openai');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.model || defaultModel(cfg.provider || 'openai'),
    messages,
    max_tokens: maxTokens,
  };
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${label} ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { text: data.choices?.[0]?.message?.content || '', raw: data };
}

async function askOllama(cfg: AiCfg, messages: AiMessage[]) {
  const url = cfg.endpoint || defaultEndpoint('ollama');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model || defaultModel('ollama'),
      messages,
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const data = (await r.json()) as { message?: { content?: string } };
  return { text: data.message?.content || '', raw: data };
}

export async function ask(messages: AiMessage[], opts?: { maxTokens?: number }) {
  const cfg = readCfg();
  const provider = cfg.provider || 'anthropic';
  const maxTokens = opts?.maxTokens ?? 2048;
  if (provider === 'anthropic') return askAnthropic(cfg, messages, maxTokens);
  if (provider === 'openai') return askOpenAILike(cfg, messages, maxTokens, 'OpenAI');
  if (provider === 'byo')    return askOpenAILike(cfg, messages, maxTokens, 'BYO');
  if (provider === 'ollama') return askOllama(cfg, messages);
  throw new Error(`Unknown provider: ${provider}`);
}

export async function buildContext(opts?: { includeNotes?: boolean }): Promise<string> {
  const r = await fetch(`/api/ai/context?notes=${opts?.includeNotes ? '1' : '0'}`);
  if (!r.ok) return '';
  const j = (await r.json()) as { text?: string };
  return j.text || '';
}
