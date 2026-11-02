// JANUS model router (portable: Cloudflare Worker, Durable Object, GitHub runner, Node tests).
// Free providers only. Contents use the Gemini shape: [{role:'user'|'model', parts:[{text}|{functionCall}|{functionResponse}|{inlineData}]}].
// Order per route (from the owner's plan, 2026-11-02). A model that is missing for this account (404), hangs or
// rate-limits is retried with back-off, then skipped silently for a while. Model names never reach the user.

export const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemma-4-26b-a4b-it'];
const GEMINI_LITE = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite'];

export const PROVIDERS = {
  nvidia: { base: 'https://integrate.api.nvidia.com/v1' },
  mistral: { base: 'https://api.mistral.ai/v1', gap: 1150 }, // free tier ≈ 1 request / second
  groq: { base: 'https://api.groq.com/openai/v1', pick: [/kimi-k2/i, /gpt-oss-120b/i, /qwen3/i, /llama-3\.3-70b/i, /llama-4/i] },
  cerebras: { base: 'https://api.cerebras.ai/v1', pick: [/qwen-3-coder|qwen-3-235b/i, /gpt-oss/i, /qwen/i, /llama/i] },
  openrouter: { base: 'https://openrouter.ai/api/v1', free: true, pick: [/qwen3-coder/i, /kimi/i, /deepseek/i, /glm/i, /gpt-oss/i, /qwen/i, /llama/i] },
};

const KIMI = 'nvidia:moonshotai/kimi-k2.6', NEMO = 'nvidia:nvidia/nemotron-3-ultra-550b-a55b', DSEEK = 'nvidia:deepseek-ai/deepseek-v4.1-flash', MINIMAX = 'nvidia:minimaxai/minimax-m3.1-flash';
export const ROUTES = {
  main: [KIMI, NEMO, DSEEK, 'gemini:flash', MINIMAX, 'groq:*', 'cerebras:*', 'openrouter:*', 'mistral:mistral-medium-latest'],
  code: ['mistral:codestral-latest', KIMI, NEMO, DSEEK, 'gemini:flash', MINIMAX, 'groq:*', 'cerebras:*', 'openrouter:*'],
  vision: ['gemini:flash', 'nvidia:google/gemma-4-31b-it', 'nvidia:nvidia/nemotron-3.5-super-vl-120b-a12b', 'nvidia:meta/llama-3.2-90b-vision-instruct'],
  fast: ['groq:*', 'cerebras:*', NEMO, MINIMAX, 'gemini:lite', 'mistral:mistral-small-latest', KIMI],
};
const VISION_OK = /gemma-4|vl-|vision|kimi-k2\.6/i; // OpenAI-compatible models we send images to

const S = (o) => JSON.stringify(o);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const lc = (x) => Array.isArray(x) ? x.map(lc) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : lc(v)])) : x;
const hasImages = (contents) => contents.some(c => (c.parts || []).some(p => p.inlineData));

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
  // providers reject two user turns in a row less often than an assistant turn first; make sure we start with user
  if (msgs.length && msgs[0].role === 'assistant') msgs.unshift({ role: 'user', content: '…' });
  return msgs;
}

/** Read an OpenAI SSE stream: content + tool_calls. Aborts when nothing arrives for firstMs (hung model). */
async function readSSE(r, ac, firstMs, idleMs) {
  const rd = r.body.getReader(); const dec = new TextDecoder(); let buf = '', content = '', got = false; const calls = [];
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
        got = true; bump();
        const dl = j.choices && j.choices[0] && j.choices[0].delta || {};
        if (dl.content) content += dl.content;
        for (const tc of dl.tool_calls || []) {
          const k = tc.index != null ? tc.index : calls.length; calls[k] = calls[k] || { id: '', name: '', args: '' };
          if (tc.id) calls[k].id = tc.id; if (tc.function && tc.function.name) calls[k].name += tc.function.name; if (tc.function && tc.function.arguments) calls[k].args += tc.function.arguments;
        }
      }
    }
  } finally { clearTimeout(timer); }
  return { got, content, calls: calls.filter(Boolean) };
}

export function makeRouter({ keys = {}, ai = null, fetchImpl = fetch, geminiBase = 'https://generativelanguage.googleapis.com', geminiKeyInHeader = true, stream = true, log = null } = {}) {
  const cool = new Map(); // model → until(ms)
  const lastHit = {};     // provider → ts (spacing for Mistral)
  let last = null;
  const has = (p) => p === 'gemini' ? (keys.gemini !== undefined && keys.gemini !== null && (keys.gemini !== '' || !geminiKeyInHeader)) : !!keys[p];
  const expand = (route) => {
    const out = [];
    for (const spec of ROUTES[route] || ROUTES.main) {
      const [p, m] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];
      if (!has(p)) continue;
      if (p === 'gemini') (m === 'lite' ? GEMINI_LITE : GEMINI_MODELS).forEach(x => out.push({ p, m: x }));
      else out.push({ p, m });
    }
    return out;
  };
  async function pickModels(p) { // "groq:*" → that provider's best live models
    const P = PROVIDERS[p]; if (P._m) return P._m;
    P._m = [];
    try {
      const r = await fetchImpl(P.base + '/models', { headers: { authorization: 'Bearer ' + keys[p] }, signal: AbortSignal.timeout(15000) });
      const j = await r.json(); const ids = (j.data || []).filter(m => !/whisper|tts|guard|embed|audio|image/i.test(m.id) && (!P.free || (/:free$/.test(m.id) && (!m.supported_parameters || m.supported_parameters.includes('tools'))))).map(m => m.id);
      for (const re of P.pick || [/./]) for (const id of ids) if (re.test(id) && !P._m.includes(id)) P._m.push(id);
      P._m = P._m.slice(0, 3);
    } catch { }
    return P._m;
  }
  async function callOAI(p, m, contents, tools, o) {
    const P = PROVIDERS[p]; const vision = o.route === 'vision' || VISION_OK.test(m);
    if (P.gap) { const w = (lastHit[p] || 0) + P.gap - Date.now(); if (w > 0) await sleep(w); lastHit[p] = Date.now(); }
    const body = { model: m, messages: toOpenAI(contents, o.system, vision && hasImages(contents)), max_tokens: o.maxTokens || 8192, temperature: o.temperature ?? 0.3 };
    if (tools && tools.length) { body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: String(t.description || '').slice(0, 1000), parameters: lc(t.parameters || { type: 'object', properties: {} }) } })); body.tool_choice = 'auto'; }
    const ac = new AbortController(); const hard = setTimeout(() => ac.abort('total'), o.timeoutMs || 300000);
    try {
      if (stream) body.stream = true;
      const r = await fetchImpl(P.base + '/chat/completions', { method: 'POST', signal: ac.signal, headers: { authorization: 'Bearer ' + keys[p], 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json' }, body: S(body) });
      if (!r.ok) { const t = await r.text().catch(() => ''); throw Object.assign(new Error(p + ' ' + r.status + ' ' + t.slice(0, 120)), { status: r.status }); }
      let content = '', calls = [];
      if (stream && /event-stream/.test(r.headers.get('content-type') || '')) { const s = await readSSE(r, ac, o.firstMs || 40000, o.idleMs || 60000); content = s.content; calls = s.calls; }
      else { const j = await r.json(); const msg = j.choices && j.choices[0] && j.choices[0].message || {}; content = msg.content || ''; calls = (msg.tool_calls || []).map(t => ({ id: t.id, name: t.function.name, args: t.function.arguments })); }
      const parts = [];
      const txt = String(content || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*?<\/think>/, '').trim();
      if (txt) parts.push({ text: txt });
      for (const c of calls) { let a = {}; try { a = JSON.parse(c.args || '{}'); } catch { a = {}; } if (c.name) parts.push({ functionCall: { name: c.name, args: a } }); }
      if (!parts.length) throw Object.assign(new Error(p + ' empty'), { status: 'empty' });
      return parts;
    } catch (e) {
      if (e.name === 'AbortError' || /abort/i.test(e.message || '')) throw Object.assign(new Error(p + ' timeout'), { status: 'timeout' });
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
    const r = await fetchImpl(`${geminiBase}/v1beta/models/${m}:generateContent`, { method: 'POST', headers, body: S(body), signal: AbortSignal.timeout(o.timeoutMs || 180000) }).catch(e => { throw Object.assign(new Error('gemini timeout'), { status: 'timeout' }); });
    if (!r.ok) { const t = await r.text().catch(() => ''); throw Object.assign(new Error('gemini ' + r.status + ' ' + t.slice(0, 120)), { status: r.status, daily: /per ?day/i.test(t) }); }
    const j = await r.json(); const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    if (!parts || !parts.length) throw Object.assign(new Error('gemini empty'), { status: 'empty' });
    return parts;
  }
  async function once(contents, tools, o) {
    const errs = [];
    const list = expand(o.route || 'main');
    for (const { p, m } of list) {
      const key = p + ':' + m; if ((cool.get(key) || 0) > Date.now()) continue;
      const models = m === '*' ? await pickModels(p) : [m];
      for (const mm of models) {
        const k2 = p + ':' + mm; if ((cool.get(k2) || 0) > Date.now()) continue;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const parts = p === 'gemini' ? await callGemini(mm, contents, tools, o) : await callOAI(p, mm, contents, tools, o);
            last = k2; log && log('model', k2); return { parts, model: k2 };
          } catch (e) {
            const s = e.status; errs.push(k2 + ':' + s);
            if (s === 429 && !e.daily && attempt < 2) { await sleep(attempt ? 4000 : 1500); continue; } // back-off, then fall back
            if ((s >= 500 || s === 'empty') && attempt < 1) { await sleep(2000); continue; }
            cool.set(k2, Date.now() + (s === 404 || s === 403 || s === 401 ? 6 * 3600e3 : s === 'timeout' ? 10 * 60e3 : e.daily ? 3 * 3600e3 : s === 429 ? 60e3 : s === 400 ? 0 : 3 * 60e3));
            break;
          }
        }
      }
    }
    if (ai && o.route !== 'vision') { const r = await workersAI(ai, contents, tools, o.system); last = 'workers-ai'; return { parts: r.parts, model: 'workers-ai' }; }
    throw new Error('All models failed: ' + errs.slice(-8).join(', '));
  }
  const llm = async (contents, tools, opts = {}) => {
    const o = typeof opts === 'string' ? { route: opts } : opts;
    if (!o.route) o.route = 'main';
    let lastErr;
    for (let round = 0; round < 3; round++) {
      try { return await once(contents, tools, o); } catch (e) { lastErr = e; await sleep(6000 * (round + 1)); cool.clear(); }
    }
    throw lastErr;
  };
  llm.lastModel = () => last;
  llm.available = (route) => expand(route).map(x => x.p + ':' + x.m);
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
