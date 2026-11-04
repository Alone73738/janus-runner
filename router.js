// JANUS model router v3 (portable: Cloudflare Worker, Durable Object, GitHub runner, Node tests).
// CONFIG-DRIVEN: every free provider is one entry in PROVIDERS (base URL, models per role, limits). A new
// OpenAI-compatible provider needs no code: the phone's "Any AI provider" connector sends {id, base, models, rpm}
// and it is appended as a custom provider. Seeded from the 2026-11-04 free-provider research
// (GitHub Models retired, Cerebras no longer free → last, never hardcode gemini-2.5-*).
// Per-provider rate limiting (requests/min, tokens/min, min gap, in-flight cap) is shared by every caller of one
// router instance, so 10 parallel sub-agents spread across providers instead of hitting 429s.
// Contents use the Gemini shape: [{role:'user'|'model', parts:[{text}|{functionCall}|{functionResponse}|{inlineData}]}].

export const GEMINI = {
  main: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
  agent: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
  research: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
  long: ['gemini-3.8-flash', 'gemini-3.6-flash'],
  code: ['gemini-3.8-flash', 'gemini-3.6-flash'],
  vision: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
  fast: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-lite-latest'],
};
export const GEMINI_MODELS = [...new Set([...GEMINI.main, ...GEMINI.fast, 'gemma-4-26b-a4b-it'])];

/** v5.1 roles: fast (chat/quick), main, code, agent (browser/tool use), vision, research, long (long context).
 *  Strongest first; ids checked live 2026-11-04 (NVIDIA: Kimi K2.6 + Nemotron 3 Super 404 on this key, DeepSeek V4.1 /
 *  GLM-5.3 hung → kept late; Step-5 preview + Mistral Large 4 answer tool calls in ~1 s).
 *  id, base, key ('none' = keyless), rpm / tpm / gapMs / inflight limits, maxIn = max request size in tokens,
 *  models[role] = ordered model ids (verified against the provider's live /models when a key exists). */
const NV_TOP = ['nvidia/nemotron-3-ultra-550b-a55b', 'stepfun-ai/step-5-preview', 'mistralai/mistral-large-4-1t-a52b', 'deepseek-ai/deepseek-v4.1-flash'];
export const PROVIDERS = [
  { id: 'gemini', kind: 'gemini', rpm: 10, inflight: 4 },
  { id: 'nvidia', base: 'https://integrate.api.nvidia.com/v1', rpm: 38, inflight: 8, models: {
    main: NV_TOP, agent: NV_TOP,
    research: ['nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-ai/deepseek-v4.1-flash', 'mistralai/mistral-large-4-1t-a52b', 'stepfun-ai/step-5-preview'],
    long: ['nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-ai/deepseek-v4.1-flash'],
    code: ['nvidia/nemotron-3-ultra-550b-a55b', 'deepseek-ai/deepseek-v4.1-flash', 'mistralai/mistral-large-4-1t-a52b', 'stepfun-ai/step-5-preview'],
    vision: ['stepfun-ai/step-5-preview', 'nvidia/nemotron-3.5-super-vl-120b-a12b', 'google/gemma-4-31b-it'],
    fast: ['nvidia/nemotron-3.5-lightning-30b-a3b', 'minimaxai/minimax-m3.1-flash'] } },
  { id: 'groq', base: 'https://api.groq.com/openai/v1', rpm: 28, tpm: 7600, maxIn: 5500, inflight: 4, models: { // 8K TPM: short jobs only
    fast: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'], code: ['openai/gpt-oss-120b'], main: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'], agent: ['openai/gpt-oss-120b'], research: ['openai/gpt-oss-120b'] } },
  { id: 'openrouter', base: 'https://openrouter.ai/api/v1', rpm: 18, inflight: 3, models: {
    main: ['nvidia/nemotron-3-ultra-550b-a55b:free'], code: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere/north-mini-code:free'],
    vision: ['nvidia/nemotron-3.5-super-vl:free', 'google/gemma-4-31b-it:free'], fast: ['nvidia/nemotron-3.5-lightning:free'] } },
  { id: 'mistral', base: 'https://api.mistral.ai/v1', rpm: 50, gapMs: 1100, inflight: 1, models: {
    code: ['codestral-latest', 'mistral-large-4'], main: ['mistral-large-4', 'mistral-medium-latest'], fast: ['mistral-small-latest'], vision: ['mistral-medium-latest'], long: ['mistral-large-4'] } },
  { id: 'zai', base: 'https://api.z.ai/api/paas/v4', rpm: 20, inflight: 2, models: { vision: ['glm-4.6v-flash'], fast: ['glm-4.7-flash', 'glm-4.5-flash'], main: ['glm-4.7-flash'] } },
  { id: 'cfai', base: 'https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1', rpm: 60, inflight: 3, models: { // 10k neurons/day
    main: ['@cf/openai/gpt-oss-120b'], code: ['@cf/qwen/qwen3.8-27b', '@cf/openai/gpt-oss-120b'], fast: ['@cf/zai-org/glm-4.7-flash', '@cf/openai/gpt-oss-20b'], vision: ['@cf/meta/llama-4-scout-17b-16e-instruct'] } },
  { id: 'hetzner', base: 'https://inference.hetzner.com/api/v1', rpm: 10, inflight: 2, models: { main: ['Qwen/Qwen3.8-27B'], vision: ['Qwen/Qwen3.8-27B'], fast: ['Qwen/Qwen3.6-35B-A3B-FP8'], code: ['Qwen/Qwen3.8-27B'] } },
  { id: 'llm7', base: 'https://api.llm7.io/v1', rpm: 55, gapMs: 1050, inflight: 1, models: { code: ['codestral-latest'], fast: ['mistral-Nemo-Instruct-2407'] } },
  { id: 'sambanova', base: 'https://api.sambanova.ai/v1', rpm: 18, inflight: 2, models: { main: ['DeepSeek-V3.1'], code: ['gpt-oss-120b'] } }, // 20 req/day: last resort
  { id: 'kilo', base: 'https://api.kilo.ai/api/gateway', key: 'none', rpm: 3, inflight: 2, models: { // keyless, ~200 req/hour per IP
    main: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'kilo-auto/free'], code: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'cohere/north-mini-code:free'],
    vision: ['nvidia/nemotron-3.5-super-vl:free'], fast: ['nvidia/nemotron-3.5-lightning:free', 'kilo-auto/free'] } },
  { id: 'cerebras', base: 'https://api.cerebras.ai/v1', rpm: 5, inflight: 1, models: { main: ['gpt-oss-120b'], code: ['gpt-oss-120b'], fast: ['gpt-oss-120b'] } }, // trial credit only now
];
// roles a provider does not list use its main models (Groq never gets long-context work: 8K TPM)
PROVIDERS.forEach(p => { if (!p.models) return; for (const r of ['agent', 'research', 'long']) if (!p.models[r] && p.models.main && !(r === 'long' && p.maxIn)) p.models[r] = p.models.main; });
/** Provider order per role (custom providers are inserted before the keyless/trial tail). */
export const ROLE_ORDER = {
  fast: ['groq', 'gemini', 'nvidia', 'zai', 'cfai', 'mistral', 'openrouter', 'llm7', '*custom', 'kilo', 'cerebras'],
  main: ['gemini', 'nvidia', 'mistral', 'groq', 'openrouter', 'zai', 'hetzner', 'cfai', '*custom', 'kilo', 'sambanova', 'cerebras'],
  code: ['nvidia', 'mistral', 'gemini', 'groq', 'openrouter', 'llm7', 'hetzner', 'cfai', '*custom', 'kilo', 'sambanova', 'cerebras'],
  agent: ['gemini', 'nvidia', 'mistral', 'groq', 'openrouter', 'zai', 'cfai', '*custom', 'kilo'],
  vision: ['gemini', 'nvidia', 'zai', 'openrouter', 'mistral', 'hetzner', 'cfai', '*custom', 'kilo'],
  research: ['gemini', 'nvidia', 'mistral', 'openrouter', 'groq', 'zai', 'hetzner', 'cfai', '*custom', 'kilo', 'sambanova'],
  long: ['gemini', 'nvidia', 'openrouter', 'mistral', '*custom', 'kilo'],
};
export const ROLES = Object.keys(ROLE_ORDER);
/** Task → role (same rules as the phone's classifyTask). */
export function classifyTask(text, { images = false, tokens = 0, build = false } = {}) {
  const t = String(text || '').toLowerCase();
  if (images) return 'vision';
  if (tokens > 60000) return 'long';
  if (build || /\b(code|coding|program|script|function|debug|bug|refactor|html|css|javascript|python|java|kotlin|sql|regex|api|algorithm|apk|app banao|game banao|build (an?|the|me)|android app)\b/.test(t)) return 'code';
  if (/\b(deep research|research|in[- ]depth|report on|compare|comparison|versus|vs\.?|pros and cons|analy[sz]e|analysis|tulna|review of)\b/.test(t)) return 'research';
  if (/https?:\/\/|www\.|\b[\w-]+\.(com|in|org|net|io|co|ai|app|dev)\b|\b(website|browser|log ?in|sign ?in|kholo|khol ?ke|add to cart|checkout|book|fill|download|open)\b/.test(t)) return 'agent';
  if (t.length < 80 && !/\?|kya|what|how|why|kaise|kyun/.test(t)) return 'fast';
  return 'main';
}
export const PROVIDER_IDS = PROVIDERS.map(p => p.id);
const VISION_OK = /gemma-4|vl|vision|kimi-k2\.6|glm-4\.6v|llama-4-scout|qwen3\.8|mistral-medium|step-5/i;

const S = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (x) => Array.isArray(x) ? x.map(lc) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : lc(v)])) : x;
const hasImages = (contents) => contents.some(c => (c.parts || []).some(p => p.inlineData));
export const estTokens = (contents, system, tools) => Math.ceil((S(contents).replace(/"data":"[^"]{200,}"/g, '"data":"img"').length + String(system || '').length + S(tools || []).length) / 3.6);

/** Sliding-window limiter per provider: requests/min, tokens/min, min gap between calls, max in flight. */
export function makeLimiter(now = () => Date.now()) {
  const st = new Map();
  const get = (id) => { let s = st.get(id); if (!s) { s = { hits: [], inflight: 0, last: 0, until: 0 }; st.set(id, s); } return s; };
  return {
    /** ms to wait before this provider can take a request of ~tok tokens (0 = go now). */
    wait(P, tok = 0) {
      const s = get(P.id); const t = now(); s.hits = s.hits.filter(h => t - h.t < 60000);
      let w = Math.max(0, s.until - t);
      if (P.inflight && s.inflight >= P.inflight) w = Math.max(w, 1500);
      if (P.gapMs) w = Math.max(w, s.last + P.gapMs - t);
      if (P.rpm && s.hits.length >= P.rpm) w = Math.max(w, s.hits[s.hits.length - P.rpm].t + 60000 - t);
      if (P.tpm && tok) { let sum = tok; for (let i = s.hits.length - 1; i >= 0; i--) { sum += s.hits[i].tok; if (sum > P.tpm) { w = Math.max(w, s.hits[i].t + 60000 - t); break; } } }
      return w;
    },
    take(P, tok = 0) { const s = get(P.id); s.hits.push({ t: now(), tok }); s.last = now(); s.inflight++; },
    done(P, realTok) { const s = get(P.id); s.inflight = Math.max(0, s.inflight - 1); if (realTok && s.hits.length) s.hits[s.hits.length - 1].tok = realTok; },
    block(P, ms) { const s = get(P.id); s.until = Math.max(s.until, now() + ms); },
    stats() { const o = {}; for (const [k, s] of st) o[k] = { lastMin: s.hits.length, inflight: s.inflight, blockedMs: Math.max(0, s.until - now()) }; return o; },
  };
}

/** Gemini-shaped contents → OpenAI messages. Images become image_url only for vision models. */
export function toOpenAI(contents, system, vision) {
  const msgs = []; if (system) msgs.push({ role: 'system', content: system });
  let pend = [];
  contents.forEach((c, ci) => {
    const parts = c.parts || [];
    if (c.role === 'model') {
      const calls = parts.filter(p => p.functionCall).map((p, k) => ({ id: 'c' + ci + '_' + k, type: 'function', function: { name: p.functionCall.name, arguments: S(p.functionCall.args || {}) } }));
      pend = calls.slice(); const t = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
      msgs.push(calls.length ? { role: 'assistant', content: t || null, tool_calls: calls } : { role: 'assistant', content: t || '…' });
    } else {
      const txt = [], imgs = [];
      parts.forEach(p => {
        if (p.functionResponse) {
          const i = pend.findIndex(t => t.function.name === p.functionResponse.name); const t = i >= 0 ? pend.splice(i, 1)[0] : null;
          const r = p.functionResponse.response; const body = typeof (r && r.result) === 'string' ? r.result : S(r || {});
          if (t) msgs.push({ role: 'tool', tool_call_id: t.id, content: String(body).slice(0, 16000) }); else txt.push('Result of ' + p.functionResponse.name + ': ' + String(body).slice(0, 4000));
        } else if (p.text) txt.push(p.text);
        else if (p.inlineData) { if (vision) imgs.push({ type: 'image_url', image_url: { url: 'data:' + (p.inlineData.mimeType || 'image/jpeg') + ';base64,' + p.inlineData.data } }); else txt.push('[image omitted]'); }
      });
      pend.forEach(t => msgs.push({ role: 'tool', tool_call_id: t.id, content: '(no result)' })); pend = [];
      if (imgs.length) msgs.push({ role: 'user', content: [{ type: 'text', text: txt.join('\n') || 'See the image.' }, ...imgs] });
      else if (txt.length) msgs.push({ role: 'user', content: txt.join('\n') });
    }
  });
  if (msgs.length && msgs[0].role === 'assistant') msgs.unshift({ role: 'user', content: '…' });
  return msgs;
}

/** Read an OpenAI SSE stream: content + tool_calls. Aborts when nothing arrives for firstMs (hung model). */
async function readSSE(r, ac, firstMs, idleMs) {
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '', content = '', got = false, usage = 0; const calls = [];
  let timer = setTimeout(() => ac.abort('first'), firstMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort('idle'), idleMs); };
  try {
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue; const d = line.slice(5).trim(); if (!d || d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        if (j.error) throw Object.assign(new Error(String(j.error.message || 'stream error').slice(0, 160)), { status: j.error.code || 500 });
        got = true; bump(); if (j.usage && j.usage.total_tokens) usage = j.usage.total_tokens;
        const dl = j.choices && j.choices[0] && j.choices[0].delta || {};
        if (dl.content) content += dl.content;
        for (const tc of dl.tool_calls || []) {
          const k = tc.index != null ? tc.index : calls.length; calls[k] = calls[k] || { id: '', name: '', args: '' };
          if (tc.id) calls[k].id = tc.id; if (tc.function && tc.function.name) calls[k].name += tc.function.name; if (tc.function && tc.function.arguments) calls[k].args += tc.function.arguments;
        }
      }
    }
  } finally { clearTimeout(timer); }
  return { got, content, usage, calls: calls.filter(Boolean) };
}

/** keys: { gemini, nvidia, groq, …, cfai_account, custom: [{id, base, key, models:[…] | {role:[…]}, rpm, tpm, roles}] } */
export function makeRouter({ keys = {}, ai = null, fetchImpl = fetch, geminiBase = 'https://generativelanguage.googleapis.com', geminiKeyInHeader = true, stream = true, log = null, limiter = null, providers = PROVIDERS, keyless = true } = {}) {
  const cool = new Map(); // provider:model → until(ms)
  const lim = limiter || makeLimiter();
  const live = {};        // provider → Set(live model ids) | null (unknown)
  let last = null, cutSeen = false;
  const custom = (Array.isArray(keys.custom) ? keys.custom : []).filter(c => c && /^https:\/\//.test(c.base || '') && /^[a-z0-9_-]{2,30}$/.test(c.id || '')).map(c => {
    const ms = Array.isArray(c.models) ? c.models.filter(Boolean) : null; const roles = c.roles && c.roles.length ? c.roles : ['main', 'code', 'fast', 'agent', 'research', 'long'];
    return { id: 'x_' + c.id, base: c.base.replace(/\/+$/, ''), key: c.key || 'none', rpm: +c.rpm || 20, tpm: +c.tpm || 0, inflight: +c.inflight || 2, custom: true, models: ms ? Object.fromEntries(roles.map(r => [r, ms])) : (c.models || {}) };
  });
  const all = [...providers, ...custom];
  const P = (id) => all.find(p => p.id === id);
  const keyOf = (p) => p.key === 'none' ? '' : (p.custom ? p.key : keys[p.id]);
  const has = (p) => {
    if (p.kind === 'gemini') return keys.gemini !== undefined && keys.gemini !== null && (keys.gemini !== '' || !geminiKeyInHeader);
    if (p.key === 'none') return p.custom || keyless;
    if (p.id === 'cfai' && !keys.cfai_account) return false;
    return !!keyOf(p);
  };
  const baseOf = (p) => p.base.replace('{account}', encodeURIComponent(keys.cfai_account || ''));
  const expand = (role) => {
    const out = [];
    for (const id of ROLE_ORDER[role] || ROLE_ORDER.main) {
      const list = id === '*custom' ? custom : [P(id)].filter(Boolean);
      for (const p of list) {
        if (!has(p)) continue;
        const ms = p.kind === 'gemini' ? (GEMINI[role] || GEMINI.main) : ((p.models || {})[role] || []);
        for (const m of ms) out.push({ p, m });
      }
    }
    return out;
  };
  async function verifyLive(p) { // model ids change often: check the provider's live list once (keyed providers only)
    if (p.kind === 'gemini' || p.key === 'none' || p.id in live) return;
    live[p.id] = null;
    try {
      const r = await fetchImpl(baseOf(p) + '/models', { headers: { authorization: 'Bearer ' + keyOf(p) }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) return; const j = await r.json(); const ids = (j.data || j.models || []).map(m => m.id || m.name).filter(Boolean);
      if (ids.length) live[p.id] = new Set(ids);
    } catch { }
  }
  async function callOAI(p, m, contents, tools, o) {
    const vision = o.route === 'vision' || VISION_OK.test(m);
    const body = { model: m, messages: toOpenAI(contents, o.system, vision && hasImages(contents)), max_tokens: Math.min(o.maxTokens || 8192, p.maxOut || 32768), temperature: o.temperature ?? 0.3 };
    if (tools && tools.length) { body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: String(t.description || '').slice(0, 1000), parameters: lc(t.parameters || { type: 'object', properties: {} }) } })); body.tool_choice = 'auto'; }
    const ac = new AbortController(); const hard = setTimeout(() => ac.abort('total'), o.timeoutMs || 300000);
    try {
      if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
      const h = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' }; const k = keyOf(p); if (k) h.authorization = 'Bearer ' + k;
      if (p.id === 'openrouter') { h['HTTP-Referer'] = 'https://janus.app'; h['X-Title'] = 'JANUS'; }
      const r = await fetchImpl(baseOf(p) + '/chat/completions', { method: 'POST', signal: ac.signal, headers: h, body: S(body) });
      if (!r.ok) { const t = await r.text().catch(() => ''); const ra = +(r.headers.get('retry-after') || 0); throw Object.assign(new Error(p.id + ' ' + r.status + ' ' + t.slice(0, 120)), { status: r.status, retryAfter: ra, daily: /per ?day|daily|RPD/i.test(t) }); }
      let content = '', calls = [], usage = 0;
      if (stream && /event-stream/.test(r.headers.get('content-type') || '')) { const s = await readSSE(r, ac, o.firstMs || 40000, o.idleMs || 300000); content = s.content; calls = s.calls; usage = s.usage; }
      else { const j = await r.json(); const msg = j.choices && j.choices[0] && j.choices[0].message || {}; content = msg.content || ''; usage = j.usage && j.usage.total_tokens || 0; calls = (msg.tool_calls || []).map(t => ({ id: t.id, name: t.function.name, args: t.function.arguments })); }
      const parts = [];
      const txt = String(content || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
      if (txt) parts.push({ text: txt });
      for (const c of calls) { let a = {}; try { a = JSON.parse(c.args || '{}'); } catch { a = {}; } if (c.name) parts.push({ functionCall: { name: c.name, args: a } }); }
      if (!parts.length) throw Object.assign(new Error(p.id + ' empty'), { status: 'empty' });
      parts.usage = usage; return parts;
    } catch (e) {
      if (e.name === 'AbortError' || /abort/i.test(e.message || '')) throw Object.assign(new Error(p.id + ' timeout'), { status: 'timeout' });
      if (/terminated|socket|ECONNRESET|other side closed/i.test(e.message || '')) throw Object.assign(new Error(p.id + ' connection cut'), { status: 'cut' });
      throw e;
    } finally { clearTimeout(hard); }
  }
  async function callGemini(m, contents, tools, o) {
    const gemma = m.startsWith('gemma');
    const cts = contents.map(c => ({ role: c.role, parts: (c.parts || []).filter(p => !(gemma && p.inlineData)).map(p => p.thoughtSignature && last !== 'gemini:' + m ? { ...p, thoughtSignature: 'skip_thought_signature_validator' } : p) })).map(c => c.parts.length ? c : { role: c.role, parts: [{ text: '…' }] });
    const body = { contents: cts, generationConfig: { temperature: o.temperature ?? 0.3, maxOutputTokens: gemma ? 8192 : (o.maxTokens || 16384) } };
    if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
    if (tools && tools.length) body.tools = [{ functionDeclarations: tools }];
    const headers = { 'content-type': 'application/json' }; if (geminiKeyInHeader && keys.gemini) headers['x-goog-api-key'] = keys.gemini;
    const r = await fetchImpl(`${geminiBase}/v1beta/models/${m}:generateContent`, { method: 'POST', headers, body: S(body), signal: AbortSignal.timeout(o.timeoutMs || 180000) }).catch(() => { throw Object.assign(new Error('gemini timeout'), { status: 'timeout' }); });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw Object.assign(new Error('gemini ' + r.status + ' ' + t.slice(0, 120)), { status: r.status, daily: /per ?day/i.test(t) }); }
    const j = await r.json(); const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    if (!parts || !parts.length) throw Object.assign(new Error('gemini empty'), { status: 'empty' });
    return parts;
  }
  async function once(contents, tools, o) {
    const errs = []; const tok = estTokens(contents, o.system, tools);
    if (tok > 100000 && o.route !== 'vision' && o.route !== 'long') o = { ...o, route: 'long' }; // very long context → 1M-context models first
    let list = expand(o.route || 'main');
    if (o.spread && list.length > 1) { const provs = [...new Set(list.map(x => x.p.id))]; const lead = provs[o.spread % Math.min(provs.length, 3)]; list = [...list.filter(x => x.p.id === lead), ...list.filter(x => x.p.id !== lead)]; }
    for (let pass = 0; pass < 2; pass++) {
      let minWait = Infinity, deferred = 0;
      for (let i = 0; i < list.length; i++) {
        const { p, m } = list[i]; const k2 = p.id + ':' + m;
        if ((cool.get(k2) || 0) > Date.now()) continue;
        if (p.maxIn && tok > p.maxIn) continue; // e.g. Groq 8K TPM: keep its requests short
        await verifyLive(p); if (live[p.id] && !live[p.id].has(m)) { cool.set(k2, Date.now() + 6 * 3600e3); continue; }
        const w = lim.wait(p, tok);
        if (w > 0 && (pass === 0 || w > 65000)) { if (w < minWait) minWait = w; deferred++; continue; } // busy: try the next provider
        if (w > 0) await sleep(w);
        for (let attempt = 0; attempt < 2; attempt++) {
          lim.take(p, tok); let ok = false, used = 0;
          try {
            const parts = p.kind === 'gemini' ? await callGemini(m, contents, tools, o) : await callOAI(p, m, contents, tools, o);
            ok = true; used = parts.usage || 0; last = k2; log && log('model', k2); return { parts, model: k2 };
          } catch (e) {
            const s = e.status; errs.push(k2 + ':' + s); if (s === 'cut' || s === 504) cutSeen = true; log && log('fail', k2 + ' ' + s + ' ' + String(e.message || '').slice(0, 80));
            if (s === 401 && p.kind !== 'gemini') { lim.block(p, 6 * 3600e3); break; } // bad key: skip the whole provider
            if (s === 429) { lim.block(p, e.retryAfter ? e.retryAfter * 1000 : e.daily ? 3 * 3600e3 : 20000); break; } // switch provider on 429
            if ((s >= 500 || s === 'empty') && attempt < 1 && list.length < 3) { await sleep(1500); continue; }
            cool.set(k2, Date.now() + (s === 404 || s === 403 || s === 401 ? 6 * 3600e3 : s === 'timeout' ? 10 * 60e3 : s === 'cut' ? 20e3 : s === 400 ? 0 : 2 * 60e3));
            break;
          } finally { lim.done(p, ok ? used : 0); }
        }
      }
      if (!deferred) break;
      if (pass === 0) await sleep(Math.min(minWait, 20000));
    }
    if (ai && o.route !== 'vision') { try { const r = await workersAI(ai, contents, tools, o.system); last = 'workers-ai'; return { parts: r.parts, model: 'workers-ai' }; } catch (e) { errs.push('workers-ai:' + String(e.message || e).slice(0, 40)); } }
    throw new Error('All models failed: ' + errs.slice(-8).join(', '));
  }
  const llm = async (contents, tools, opts = {}) => {
    const o = typeof opts === 'string' ? { route: opts } : { ...opts };
    if (!o.route) o.route = 'main';
    let lastErr;
    const waits = o.route === 'fast' ? [3000, 8000] : [10000, 25000, 45000];
    for (let round = 0; round <= waits.length; round++) {
      try { return await once(contents, tools, o); } catch (e) { lastErr = e; if (round < waits.length) { await sleep(waits[round]); cool.clear(); } }
    }
    throw lastErr;
  };
  llm.lastModel = () => last;
  llm.takeCut = () => { const c = cutSeen; cutSeen = false; return c; };
  llm.available = (route) => expand(route || 'main').map(x => x.p.id + ':' + x.m);
  llm.limiter = lim;
  return llm;
}

const WAI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
async function workersAI(ai, contents, tools, system) {
  const messages = []; if (system) messages.push({ role: 'system', content: system });
  for (const c of contents) for (const p of c.parts || []) {
    if (p.text) messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: p.text });
    else if (p.functionCall) messages.push({ role: 'assistant', content: 'CALL ' + S(p.functionCall) });
    else if (p.functionResponse) messages.push({ role: 'user', content: 'RESULT of ' + p.functionResponse.name + ': ' + String(p.functionResponse.response && p.functionResponse.response.result || '').slice(0, 6000) });
  }
  const r = await ai.run(WAI_MODEL, { messages, ...(tools && tools.length ? { tools: tools.map(t => ({ type: 'function', function: t })) } : {}), max_tokens: 2000 });
  const tc = r.tool_calls || (r.response && r.response.tool_calls) || [];
  if (tc.length) return { parts: tc.slice(0, 1).map(t => ({ functionCall: { name: t.name || (t.function && t.function.name), args: typeof (t.arguments || (t.function && t.function.arguments)) === 'string' ? JSON.parse(t.arguments || t.function.arguments) : (t.arguments || {}) } })) };
  const txt = typeof r.response === 'string' ? r.response : S(r.response || r);
  const call = firstJsonCall(txt, tools); if (call) return { parts: [{ functionCall: call }] };
  return { parts: [{ text: txt }] };
}
export function firstJsonCall(txt, tools) {
  for (let i = txt.indexOf('{'); i >= 0; i = txt.indexOf('{', i + 1)) {
    let d = 0, inS = false, esc = false;
    for (let k = i; k < txt.length; k++) {
      const ch = txt[k];
      if (inS) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inS = false; continue; }
      if (ch === '"') inS = true; else if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) { try { const x = JSON.parse(txt.slice(i, k + 1)); if (x && x.name && (!tools || tools.some(t => t.name === x.name))) return { name: x.name, args: x.args || x.arguments || x.parameters || {} }; } catch { } break; } }
    }
  }
  return null;
}
