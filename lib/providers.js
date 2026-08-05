'use strict';
/*
 * Which kind of model endpoint this is, and how to speak to it.
 *
 * The assistant started life speaking only Ollama's native API, because that is what runs on
 * the machine this was written on. That turned out to be the wrong shape for the question
 * people actually ask, which is not "is it Ollama" but "is it reachable": llama.cpp's server,
 * LM Studio, vLLM, text-generation-webui, LocalAI, OpenRouter, Groq, Together and OpenAI
 * itself all speak the SAME OpenAI-compatible dialect, and Anthropic speaks a third one.
 *
 * So this module owns the wire, and lib/llm.js owns the prompting. Three things vary between
 * providers and nothing else does:
 *
 *   1. URLS AND AUTH. Ollama needs no key and uses /api/*; the OpenAI dialect uses /v1/* with
 *      a bearer token; Anthropic uses /v1/messages with x-api-key and a version header.
 *
 *   2. HOW YOU FORCE JSON. Ollama takes the JSON Schema as `format`. The OpenAI dialect has
 *      response_format, which about half of the servers claiming compatibility actually
 *      implement — so there are two documented fallbacks below rather than one code path that
 *      works on the author's machine. Anthropic has no JSON mode at all, so a forced tool call
 *      with the schema as its input_schema stands in, which is the shape Anthropic itself
 *      recommends and is strictly enforced.
 *
 *   3. HOW A TOOL CALL IS SPELLED. All three can call tools and all three spell it
 *      differently. One canonical transcript shape is translated on the way out, so
 *      lib/assistant.js never learns that more than one dialect exists.
 *
 * NO CREDENTIALS ON THE WIRE BACK. A key is read here and never returned to the browser;
 * see redact(). A key may also be written as ${VAR} to keep it in the environment and out of
 * the config file entirely.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { CancelError, isCancel } = require('./jobs');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

/* Every provider id the config may hold. 'auto' is resolved by probing, never stored as the
 * answer — an endpoint that changes from Ollama to llama.cpp on the same port should just
 * work rather than need the setting corrected. */
const PROVIDER_IDS = ['auto', 'ollama', 'openai', 'anthropic'];

/* ── transport ───────────────────────────────────────────────────── */

function requestJson(method, url, { payload = null, headers = {}, timeoutMs = 60000, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.cancelled) return reject(new CancelError());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error('AI endpoint must be http or https'));
    }
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload));
    const lib = url.protocol === 'https:' ? https : http;
    const head = Object.assign({ Accept: 'application/json' }, headers);
    if (body) {
      head['Content-Type'] = 'application/json';
      head['Content-Length'] = body.length;
    }
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method, headers: head,
    }, (res) => {
      const chunks = [];
      let n = 0;
      res.on('data', c => { n += c.length; if (n < 32 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        if (signal && signal.cancelled) return reject(new CancelError());
        const textOut = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          const err = new Error(`AI endpoint ${res.statusCode}: ${explain(res.statusCode, textOut)}`);
          err.statusCode = res.statusCode;
          err.responseText = textOut;
          return reject(err);
        }
        try { resolve(JSON.parse(textOut)); }
        catch { reject(new Error('AI endpoint returned non-JSON: ' + textOut.slice(0, 200))); }
      });
    });
    if (signal) {
      signal.reqs.add(req);
      req.on('close', () => signal.reqs.delete(req));
    }
    req.setTimeout(timeoutMs || 300000, () => req.destroy(new Error(
      'AI request timed out — a large model on CPU can exceed this; raise the timeout or use a smaller model')));
    req.on('error', (e) => reject(
      (signal && signal.cancelled) || isCancel(e) ? new CancelError() : new Error('Cannot reach the AI endpoint: ' + e.message)));
    req.end(body || undefined);
  });
}

/*
 * A hosted provider's 401 is the single most common failure once keys enter the picture, and
 * its raw JSON body says "incorrect api key provided: sk-abc...xyz" — which is both unhelpful
 * and a partial credential in a log line. Say what to do instead.
 */
function explain(status, raw) {
  const short = String(raw || '').slice(0, 300);
  let detail = short;
  try {
    const parsed = JSON.parse(raw);
    detail = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || short;
    if (typeof detail !== 'string') detail = short;
  } catch { /* not JSON; the raw text is the best we have */ }
  detail = detail.replace(/\b(sk|xai|gsk)-[A-Za-z0-9_-]{8,}/g, '$1-***');
  if (status === 401 || status === 403) {
    return 'not authorized — check the API key for this endpoint. ' + detail.slice(0, 160);
  }
  if (status === 404) {
    return 'no such route or model — check the endpoint URL and the selected model. ' + detail.slice(0, 160);
  }
  if (status === 429) return 'rate limited by the provider. ' + detail.slice(0, 160);
  return detail.slice(0, 200);
}

/*
 * Endpoint + route → URL, honouring a base path so an endpoint behind a reverse proxy
 * (https://box/llm) works. `versioned` routes get /v1 inserted only when the endpoint has not
 * already supplied it, because both "https://api.openai.com" and "https://api.openai.com/v1"
 * are what people paste and neither should produce /v1/v1.
 */
function apiUrl(endpoint, route, { versioned = false } = {}) {
  let u;
  try { u = new URL(endpoint || DEFAULT_ENDPOINT); }
  catch { throw new Error('Bad AI endpoint: ' + endpoint); }
  let base = u.pathname.replace(/\/+$/, '');
  if (versioned && !/\/v\d+$/.test(base)) base += '/v1';
  u.pathname = base + '/' + String(route).replace(/^\/+/, '');
  return u;
}

/*
 * A key may be the literal secret or ${SOME_VAR}. The indirection exists so the config file
 * on disk can carry the *name* of a variable rather than the credential itself, which is the
 * difference between a file worth 0600 and a file worth never syncing anywhere.
 */
function resolveKey(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
  if (env) {
    const found = process.env[env[1]];
    if (!found) throw new Error(`The API key is set to ${raw} but ${env[1]} is not set in this environment`);
    return found;
  }
  return raw;
}

/* What the browser is allowed to know about the key: whether there is one, never what it is. */
function redact(cfg) {
  const out = Object.assign({}, cfg || {});
  for (const field of ['apiKey', 'embedApiKey']) {
    if (out[field] == null || out[field] === '') { out[field] = null; continue; }
    const raw = String(out[field]).trim();
    // The ${VAR} form is not a secret and is worth showing — it is the only way to tell that
    // a key is coming from the environment rather than being absent.
    out[field] = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(raw) ? raw : '••••••••';
  }
  return out;
}

const hasKey = (value) => !!String(value == null ? '' : value).trim();

/* ── canonical transcript ────────────────────────────────────────────
 *
 * lib/assistant.js builds one shape and only one:
 *   {role:'system'|'user'|'assistant', content}
 *   {role:'assistant', content, tool_calls:[{function:{name, arguments:<object>}}]}
 *   {role:'tool', name, content:<string>}
 *
 * Tool-call IDs are not in it, because Ollama does not use them. Both other dialects require
 * them, so they are assigned deterministically by position on the way out and matched to
 * results in the order the results appear — which is the order assistant.js appends them.
 */
function withCallIds(messages) {
  const out = [];
  let pending = [];
  messages.forEach((m, idx) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((c, k) => ({
        id: `call_${idx}_${k}`,
        name: String((c.function && c.function.name) || ''),
        args: (c.function && c.function.arguments) || {},
      }));
      pending = calls.slice();
      out.push({ role: 'assistant', content: m.content || '', calls });
      return;
    }
    if (m.role === 'tool') {
      const match = pending.shift();
      out.push({
        role: 'tool',
        id: match ? match.id : `call_orphan_${idx}`,
        name: m.name || (match && match.name) || 'tool',
        content: String(m.content == null ? '' : m.content),
      });
      return;
    }
    out.push({ role: m.role, content: String(m.content == null ? '' : m.content) });
  });
  return out;
}

const argObject = (v) => {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v && typeof v === 'object' ? v : {};
};

/* ── ollama ──────────────────────────────────────────────────────── */

const ollama = {
  id: 'ollama',
  label: 'Ollama',
  needsKey: false,
  can: { unload: true, listLoaded: true, embed: true },

  headers: () => ({}),

  async listModels(cfg) {
    const tags = await requestJson('GET', apiUrl(cfg.endpoint, 'api/tags'), { timeoutMs: 10000 });
    return (tags.models || []).map(m => ({
      name: m.name,
      sizeGb: m.size ? +(m.size / 1e9).toFixed(1) : null,
      family: (m.details && m.details.family) || null,
    }));
  },

  async listLoaded(cfg) {
    const ps = await requestJson('GET', apiUrl(cfg.endpoint, 'api/ps'), { timeoutMs: 6000 });
    return (ps.models || []).map(m => ({
      name: m.name,
      // Ollama reports size vs size_vram; if they match, it's fully on the GPU.
      gpu: m.size_vram ? Math.round((m.size_vram / (m.size || m.size_vram)) * 100) : 0,
    }));
  },

  async unload(cfg, model) {
    await requestJson('POST', apiUrl(cfg.endpoint, 'api/generate'),
      { payload: { model, prompt: '', keep_alive: 0 }, timeoutMs: 20000 });
  },

  async chat(cfg, messages, { schema = null, tools = null, numCtx = null, signal = null } = {}) {
    const payload = {
      model: cfg.model,
      messages: messages.map(m => {
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) return m;
        if (m.role === 'tool') {
          // Ollama has used both spellings across versions; sending both is harmless.
          return { role: 'tool', name: m.name, tool_name: m.name, content: m.content };
        }
        return { role: m.role, content: m.content };
      }),
      stream: false,
      options: {
        temperature: cfg.temperature == null ? 0 : cfg.temperature,
        num_ctx: numCtx || cfg.numCtx || 8192,
      },
    };
    if (schema) payload.format = schema;
    if (tools && tools.length) payload.tools = tools;
    const res = await requestJson('POST', apiUrl(cfg.endpoint, 'api/chat'),
      { payload, timeoutMs: cfg.timeoutMs, signal });
    const m = (res && res.message) || {};
    return {
      content: String(m.content || ''),
      calls: (Array.isArray(m.tool_calls) ? m.tool_calls : []).map(c => {
        const f = (c && c.function) || {};
        return { name: String(f.name || ''), args: argObject(f.arguments) };
      }).filter(c => c.name),
    };
  },

  async embed(cfg, input, signal) {
    // /api/embed is the current endpoint; /api/embeddings is the older single-input one.
    try {
      const r = await requestJson('POST', apiUrl(cfg.endpoint, 'api/embed'),
        { payload: { model: cfg.embedModel, input }, timeoutMs: cfg.timeoutMs || 300000, signal });
      if (r && Array.isArray(r.embeddings)) return r.embeddings;
      if (r && Array.isArray(r.embedding)) return [r.embedding];
    } catch (e) {
      if (isCancel(e) || !/404|not found/i.test(e.message)) throw e;
    }
    const out = [];
    for (const t of input) {
      const r = await requestJson('POST', apiUrl(cfg.endpoint, 'api/embeddings'),
        { payload: { model: cfg.embedModel, prompt: t }, timeoutMs: cfg.timeoutMs || 300000, signal });
      if (!r || !Array.isArray(r.embedding)) throw new Error('Embedding model returned no vector');
      out.push(r.embedding);
    }
    return out;
  },
};

/* ── openai-compatible ───────────────────────────────────────────────
 *
 * The dialect llama.cpp --server, LM Studio, vLLM, LocalAI, Ollama's own /v1 shim, OpenRouter,
 * Groq, Together, DeepSeek, xAI and OpenAI all answer. Assume nothing beyond
 * /v1/chat/completions: everything optional is attempted and degraded from.
 */

const openai = {
  id: 'openai',
  label: 'OpenAI-compatible',
  needsKey: false,                // true for hosted ones, but a local llama.cpp needs none
  can: { unload: false, listLoaded: false, embed: true },

  headers(cfg, which) {
    const key = resolveKey(which === 'embed' && hasKey(cfg.embedApiKey) ? cfg.embedApiKey : cfg.apiKey);
    return key ? { Authorization: 'Bearer ' + key } : {};
  },

  async listModels(cfg) {
    const r = await requestJson('GET', apiUrl(cfg.endpoint, 'models', { versioned: true }),
      { headers: openai.headers(cfg), timeoutMs: 15000 });
    const rows = Array.isArray(r.data) ? r.data : (Array.isArray(r.models) ? r.models : []);
    return rows
      .map(m => ({
        name: String(m.id || m.name || ''),
        // LM Studio and llama.cpp report neither; a hosted provider never does.
        sizeGb: null,
        family: m.owned_by || m.owner || null,
      }))
      .filter(m => m.name);
  },

  async listLoaded() { return []; },

  async unload() { throw new Error('This endpoint cannot unload models'); },

  async chat(cfg, messages, { schema = null, tools = null, numCtx = null, signal = null } = {}) {
    const wire = withCallIds(messages).map(m => {
      if (m.role === 'assistant' && m.calls) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.calls.map(c => ({
            id: c.id, type: 'function',
            function: { name: c.name, arguments: JSON.stringify(argObject(c.args)) },
          })),
        };
      }
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.id, name: m.name, content: m.content };
      return { role: m.role, content: m.content };
    });

    const base = {
      model: cfg.model,
      messages: wire,
      stream: false,
      temperature: cfg.temperature == null ? 0 : cfg.temperature,
    };
    if (tools && tools.length) { base.tools = tools; base.tool_choice = 'auto'; }
    // Some servers cap generation at a small default; ask for room proportional to the
    // context the user configured rather than leaving a plan truncated mid-JSON.
    base.max_tokens = Math.max(1024, Math.min(Math.round((numCtx || cfg.numCtx || 8192) / 2), 16384));

    const call = (extra) => requestJson('POST', apiUrl(cfg.endpoint, 'chat/completions', { versioned: true }),
      { payload: Object.assign({}, base, extra), headers: openai.headers(cfg), timeoutMs: cfg.timeoutMs, signal });

    let res;
    if (schema) {
      /*
       * Three attempts, most reliable first. response_format with a schema is what OpenAI,
       * vLLM and recent llama.cpp implement; plain json_object is what most of the rest
       * implement; and a server that rejects both still answers a system instruction, which
       * is what the pre-JSON-mode world ran on. Each fallback is only taken on a 4xx, so a
       * genuine outage is not retried three times.
       */
      const schemaTurn = Object.assign({}, base, {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', schema, strict: false },
        },
      });
      try {
        res = await call({ response_format: schemaTurn.response_format });
      } catch (e) {
        if (isCancel(e) || !(e.statusCode >= 400 && e.statusCode < 500)) throw e;
        const instructed = wire.slice();
        instructed.unshift({
          role: 'system',
          content: 'Reply with a single JSON object and nothing else. It must match this JSON Schema:\n' +
            JSON.stringify(schema),
        });
        try {
          res = await call({ messages: instructed, response_format: { type: 'json_object' } });
        } catch (e2) {
          if (isCancel(e2) || !(e2.statusCode >= 400 && e2.statusCode < 500)) throw e2;
          res = await call({ messages: instructed });
        }
      }
    } else {
      res = await call({});
    }

    const choice = (res && res.choices && res.choices[0]) || {};
    const m = choice.message || {};
    return {
      content: String(m.content || ''),
      calls: (Array.isArray(m.tool_calls) ? m.tool_calls : []).map(c => {
        const f = (c && c.function) || {};
        return { name: String(f.name || ''), args: argObject(f.arguments) };
      }).filter(c => c.name),
    };
  },

  async embed(cfg, input, signal) {
    const r = await requestJson('POST', apiUrl(embedEndpoint(cfg), 'embeddings', { versioned: true }), {
      payload: { model: cfg.embedModel, input },
      headers: openai.headers(cfg, 'embed'),
      timeoutMs: cfg.timeoutMs || 300000, signal,
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    if (!rows.length) throw new Error('Embedding model returned no vector');
    // index is optional in practice, but when present it is authoritative about the order.
    return rows
      .slice()
      .sort((a, b) => (a.index == null ? 0 : a.index) - (b.index == null ? 0 : b.index))
      .map(row => row.embedding);
  },
};

/* ── anthropic ───────────────────────────────────────────────────── */

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic',
  needsKey: true,
  can: { unload: false, listLoaded: false, embed: false },

  headers(cfg) {
    const key = resolveKey(cfg.apiKey);
    if (!key) throw new Error('Anthropic needs an API key — set one in assistant settings');
    return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION };
  },

  async listModels(cfg) {
    const r = await requestJson('GET', apiUrl(cfg.endpoint || ANTHROPIC_ENDPOINT, 'models', { versioned: true }),
      { headers: anthropic.headers(cfg), timeoutMs: 15000 });
    return (r.data || []).map(m => ({
      name: String(m.id || ''), sizeGb: null, family: m.display_name || null,
    })).filter(m => m.name);
  },

  async listLoaded() { return []; },

  async unload() { throw new Error('This endpoint cannot unload models'); },

  async chat(cfg, messages, { schema = null, tools = null, numCtx = null, signal = null } = {}) {
    const tagged = withCallIds(messages);
    // Anthropic takes the system prompt as its own field, not as a message.
    const system = tagged.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const wire = [];
    for (const m of tagged) {
      if (m.role === 'system') continue;
      if (m.role === 'assistant' && m.calls) {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const c of m.calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: argObject(c.args) });
        wire.push({ role: 'assistant', content: blocks });
        continue;
      }
      if (m.role === 'tool') {
        // Results are USER turns here. Consecutive results merge into one turn, because the
        // API rejects two user messages in a row.
        const block = { type: 'tool_result', tool_use_id: m.id, content: m.content };
        const last = wire[wire.length - 1];
        if (last && last.role === 'user' && Array.isArray(last.content) &&
            last.content.every(b => b.type === 'tool_result')) {
          last.content.push(block);
        } else {
          wire.push({ role: 'user', content: [block] });
        }
        continue;
      }
      wire.push({ role: m.role, content: m.content });
    }

    const payload = {
      model: cfg.model,
      max_tokens: Math.max(1024, Math.min(Math.round((numCtx || cfg.numCtx || 8192) / 2), 16384)),
      messages: wire,
      temperature: cfg.temperature == null ? 0 : cfg.temperature,
    };
    if (system) payload.system = system;

    /*
     * There is no JSON mode. A tool the model is REQUIRED to call, whose input_schema is the
     * schema we want, gets the same guarantee by a different route — and unlike a response
     * format it is validated by the API rather than hoped for.
     */
    if (schema) {
      payload.tools = [{ name: 'emit_result', description: 'Return the result.', input_schema: schema }];
      payload.tool_choice = { type: 'tool', name: 'emit_result' };
    } else if (tools && tools.length) {
      payload.tools = tools.map(t => {
        const f = (t && t.function) || t || {};
        return {
          name: f.name,
          description: f.description || '',
          input_schema: f.parameters || { type: 'object', properties: {} },
        };
      });
    }

    const res = await requestJson('POST', apiUrl(cfg.endpoint || ANTHROPIC_ENDPOINT, 'messages', { versioned: true }),
      { payload, headers: anthropic.headers(cfg), timeoutMs: cfg.timeoutMs, signal });

    const blocks = Array.isArray(res && res.content) ? res.content : [];
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
    const uses = blocks.filter(b => b.type === 'tool_use');
    if (schema) {
      const hit = uses.find(b => b.name === 'emit_result') || uses[0];
      // Round-tripped through the same JSON.parse path every other provider uses, so the
      // caller has exactly one thing to handle.
      return { content: hit ? JSON.stringify(hit.input) : text, calls: [] };
    }
    return {
      content: text,
      calls: uses.map(b => ({ name: String(b.name || ''), args: argObject(b.input) })).filter(c => c.name),
    };
  },

  async embed() {
    throw new Error('Anthropic has no embedding API — point the embedding endpoint at Ollama ' +
      'or an OpenAI-compatible server in assistant settings');
  },
};

const BY_ID = { ollama, openai, anthropic };

/* ── selection ───────────────────────────────────────────────────── */

/*
 * Probing beats asking. Someone who swaps `ollama serve` for `llama-server` on the same port
 * should not have to remember that a dropdown exists, and someone pasting an OpenAI URL should
 * not have to know which of four names their provider trades under. /api/tags answers only on
 * Ollama, so trying it first identifies the local case in one round trip.
 */
async function detect(cfg) {
  const endpoint = cfg.endpoint || DEFAULT_ENDPOINT;
  let host = '';
  try { host = new URL(endpoint).hostname; } catch { /* apiUrl will report it properly */ }
  if (/(^|\.)anthropic\.com$/i.test(host)) return anthropic;
  try {
    await requestJson('GET', apiUrl(endpoint, 'api/tags'), { timeoutMs: 4000 });
    return ollama;
  } catch (e) {
    if (isCancel(e)) throw e;
  }
  return openai;
}

/*
 * Detection costs a round trip, and classifying forty issues resolves the provider forty
 * times. So a successful answer is remembered per endpoint until the settings change — which
 * is the only moment the answer can become wrong, and the moment forget() is called.
 */
const DETECTED = new Map();

async function detectCached(cfg) {
  const endpoint = (cfg && cfg.endpoint) || DEFAULT_ENDPOINT;
  if (DETECTED.has(endpoint)) return DETECTED.get(endpoint);
  const spec = await detect(cfg || {});
  DETECTED.set(endpoint, spec);
  return spec;
}

/* Called whenever the AI settings are written, so a swapped server is noticed at once. */
const forget = () => DETECTED.clear();

/* The resolved provider, without probing when the user has said which one it is. */
async function resolve(cfg) {
  const want = String((cfg && cfg.provider) || 'auto');
  if (BY_ID[want]) return BY_ID[want];
  return detectCached(cfg || {});
}

/*
 * Chat and embeddings do not have to live in the same place, and increasingly should not:
 * Anthropic has no embedding API at all, and a hosted chat model with a local nomic-embed is
 * both cheaper and more private than sending every issue body to a vendor. An unset embed
 * endpoint means "same as chat", so the common case stays a single field.
 */
const embedEndpoint = (cfg) => (cfg && cfg.embedEndpoint) || (cfg && cfg.endpoint) || DEFAULT_ENDPOINT;

async function embedProvider(cfg) {
  const want = String((cfg && cfg.embedProvider) || 'auto');
  if (BY_ID[want]) return BY_ID[want];
  if (!cfg || !cfg.embedEndpoint) {
    /*
     * No separate endpoint means whatever answers for chat answers for embeddings — including
     * when it cannot. Returning the chat provider anyway is deliberate: Anthropic's embed()
     * throws "no embedding API — point the embedding endpoint somewhere else", which is the
     * sentence that fixes the problem. Quietly switching to the OpenAI dialect against
     * api.anthropic.com instead produces a 404 from a route that was never going to exist.
     */
    return resolve(cfg);
  }
  return detectCached({ endpoint: cfg.embedEndpoint });
}

/*
 * Reachability, the model list, and what this endpoint can actually do — the three things the
 * settings panel needs before it can render honestly. Never throws: an unreachable endpoint is
 * a state to display, not an error to handle.
 */
async function status(cfg) {
  const conf = cfg || {};
  const endpoint = conf.endpoint || DEFAULT_ENDPOINT;
  let spec;
  try { spec = await resolve(conf); }
  catch (e) { return failed(endpoint, null, e.message); }
  try {
    const models = (await spec.listModels(conf)).sort((a, b) => a.name.localeCompare(b.name));
    let loaded = [];
    if (spec.can.listLoaded) {
      try { loaded = await spec.listLoaded(conf); } catch { /* newer route; not fatal */ }
    }
    let embed = null;
    if (conf.embedEndpoint && conf.embedEndpoint !== endpoint) {
      const espec = await embedProvider(conf).catch(() => null);
      embed = { endpoint: conf.embedEndpoint, provider: espec ? espec.id : null, ok: false, models: [] };
      if (espec) {
        try {
          embed.models = (await espec.listModels(Object.assign({}, conf, {
            endpoint: conf.embedEndpoint,
            apiKey: hasKey(conf.embedApiKey) ? conf.embedApiKey : conf.apiKey,
          }))).sort((a, b) => a.name.localeCompare(b.name));
          embed.ok = true;
        } catch (e) { embed.error = e.message; }
      }
    }
    return {
      ok: true, endpoint, provider: spec.id, providerLabel: spec.label,
      can: spec.can, models, loaded, embed,
    };
  } catch (e) {
    return failed(endpoint, spec, e.message);
  }
}

function failed(endpoint, spec, message) {
  return {
    ok: false, endpoint,
    provider: spec ? spec.id : null,
    providerLabel: spec ? spec.label : null,
    can: spec ? spec.can : { unload: false, listLoaded: false, embed: true },
    error: message, models: [], loaded: [], embed: null,
  };
}

module.exports = {
  DEFAULT_ENDPOINT, ANTHROPIC_ENDPOINT, PROVIDER_IDS,
  resolve, embedProvider, embedEndpoint, detect, status, forget,
  redact, resolveKey, hasKey, apiUrl, requestJson, withCallIds,
  providers: BY_ID,
};
