/* Minerva — AI assistant wrapper.
 *
 * Provider-agnostic: the user's own API key (or local Ollama URL) is the
 * trust boundary. Nothing in this module ever sends data anywhere except
 * the configured endpoint.
 *
 * Supported provider modes:
 *   anthropic — POST https://api.anthropic.com/v1/messages with the
 *               browser-direct beta header. Default model:
 *               'claude-sonnet-4-6'.
 *   openai    — POST https://api.openai.com/v1/chat/completions.
 *               Default model: 'gpt-4o'. (Note: OpenAI typically blocks
 *               browser-origin calls; works best when proxied or pointed
 *               at an OpenAI-compatible local endpoint.)
 *   ollama    — POST http://localhost:11434/api/chat. Default 'llama3'.
 *               Requires `OLLAMA_ORIGINS=*` (or the Minerva origin) set
 *               on the Ollama server.
 *   byo       — POST <endpoint> with OpenAI-compatible chat-completions
 *               body. Use for LM Studio, vLLM, OpenRouter, or any
 *               compatible proxy.
 */
(function () {
  'use strict';

  var STORE = 'minerva.ai.v1';

  function readCfg() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; }
    catch (e) { return {}; }
  }
  function writeCfg(patch) {
    var cur = readCfg();
    var next = Object.assign({}, cur, patch);
    localStorage.setItem(STORE, JSON.stringify(next));
    return next;
  }
  function clearCfg() { localStorage.removeItem(STORE); }

  function defaultEndpoint(provider) {
    if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
    if (provider === 'openai')    return 'https://api.openai.com/v1/chat/completions';
    if (provider === 'ollama')    return 'http://localhost:11434/api/chat';
    return '';
  }

  function defaultModel(provider) {
    if (provider === 'anthropic') return 'claude-sonnet-4-6';
    if (provider === 'openai')    return 'gpt-4o';
    if (provider === 'ollama')    return 'llama3';
    return '';
  }

  // ---- per-provider request shape -------------------------------------

  async function askAnthropic(cfg, messages, opts) {
    var url = cfg.endpoint || defaultEndpoint('anthropic');
    if (!cfg.apiKey) throw new Error('Anthropic API key missing.');
    // System messages need to be promoted to the system param in the
    // Anthropic format; Anthropic does not accept system as a role
    // inside `messages`.
    var systemPrompt = '';
    var conv = [];
    messages.forEach(function (m) {
      if (m.role === 'system') systemPrompt += (systemPrompt ? '\n\n' : '') + m.content;
      else conv.push({ role: m.role, content: m.content });
    });
    var body = {
      model: cfg.model || defaultModel('anthropic'),
      max_tokens: (opts && opts.maxTokens) || 2048,
      messages: conv
    };
    if (systemPrompt) body.system = systemPrompt;

    var resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      var t = await resp.text();
      throw new Error('Anthropic ' + resp.status + ': ' + t.slice(0, 400));
    }
    var data = await resp.json();
    var text = '';
    (data.content || []).forEach(function (b) {
      if (b.type === 'text' && b.text) text += b.text;
    });
    return { text: text, raw: data };
  }

  async function askOpenAICompatible(cfg, messages, opts, providerLabel) {
    var url = cfg.endpoint || defaultEndpoint(cfg.provider || 'openai');
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    var body = {
      model: cfg.model || defaultModel(cfg.provider || 'openai'),
      messages: messages,
      max_tokens: (opts && opts.maxTokens) || 2048
    };
    var resp = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    if (!resp.ok) {
      var t = await resp.text();
      throw new Error(providerLabel + ' ' + resp.status + ': ' + t.slice(0, 400));
    }
    var data = await resp.json();
    var text = '';
    if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
      text = data.choices[0].message.content;
    }
    return { text: text, raw: data };
  }

  async function askOllama(cfg, messages, opts) {
    var url = cfg.endpoint || defaultEndpoint('ollama');
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model || defaultModel('ollama'),
        messages: messages,
        stream: false
      })
    });
    if (!resp.ok) {
      var t = await resp.text();
      throw new Error('Ollama ' + resp.status + ': ' + t.slice(0, 400));
    }
    var data = await resp.json();
    var text = (data.message && data.message.content) || '';
    return { text: text, raw: data };
  }

  async function ask(messages, opts) {
    var cfg = readCfg();
    var provider = cfg.provider || 'anthropic';
    if (provider === 'anthropic') return askAnthropic(cfg, messages, opts);
    if (provider === 'openai') return askOpenAICompatible(cfg, messages, opts, 'OpenAI');
    if (provider === 'byo')    return askOpenAICompatible(cfg, messages, opts, 'BYO');
    if (provider === 'ollama') return askOllama(cfg, messages, opts);
    throw new Error('Unknown provider: ' + provider);
  }

  // ---- context builders ----------------------------------------------

  function aliveOf(rows) { return (rows || []).filter(function (r) { return !r._deleted; }); }

  // Compact a section's rows into a textual block the model can read.
  // Truncates aggressively to keep tokens down.
  function rowsToText(headers, rows, maxRows) {
    var skipCols = ['_updated', '_rowIndex', '_dirty', '_deleted', '_localOnly'];
    var visible = (headers || []).filter(function (h) {
      return h.charAt(0) !== '_' && skipCols.indexOf(h) < 0;
    });
    var subset = rows.slice(0, maxRows || 50);
    return subset.map(function (r) {
      return visible.map(function (h) {
        var v = r[h];
        if (v == null || v === '') return '';
        return h + ': ' + String(v).replace(/\s+/g, ' ').slice(0, 240);
      }).filter(Boolean).join(' · ');
    }).join('\n');
  }

  async function buildContext(opts) {
    opts = opts || {};
    if (!Minerva.db) return '';
    var parts = [];
    var addSection = async function (tab, label, max) {
      try {
        var meta = await Minerva.db.getMeta(tab);
        if (!meta || !meta.headers) return;
        var rows = aliveOf(await Minerva.db.getAllRows(tab));
        if (!rows.length) return;
        parts.push('### ' + (label || tab) + ' (' + rows.length + ')');
        parts.push(rowsToText(meta.headers, rows, max));
      } catch (e) { /* ignore */ }
    };
    await addSection('tasks', 'Tasks', 80);
    await addSection('goals', 'Goals', 30);
    await addSection('projects', 'Projects', 30);
    if (opts.includeNotes) await addSection('notes', 'Notes', 40);
    return parts.join('\n\n');
  }

  window.Minerva = window.Minerva || {};
  window.Minerva.ai = {
    readCfg: readCfg,
    writeCfg: writeCfg,
    clearCfg: clearCfg,
    defaultEndpoint: defaultEndpoint,
    defaultModel: defaultModel,
    ask: ask,
    buildContext: buildContext
  };
})();
