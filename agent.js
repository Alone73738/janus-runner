// JANUS Cloud agent core: portable (Cloudflare Worker + Node test harness).
// ctx = { gemini(key-less fetch wrapper), ai (Workers AI binding, optional), browser() -> puppeteer Browser,
//         logins: {get(site)}, images: {put(bytes,mime)->id, get(id)}, log(fn), now() }

export const GEMINI_MODELS = [
  'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest', 'gemma-4-26b-a4b-it',
];

const S = (o) => JSON.stringify(o);
const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + '…' : t || '');

export const TOOLS = [
  { name: 'web_search', description: 'Search the web. Returns top results with snippets.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'read_url', description: 'Read a web page as plain text (fast, no browser).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'generate_image', description: 'Create an image from a prompt. Returns image_id to use with upload_image.', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'open_url', description: 'Open a URL in the cloud browser. Returns title + numbered elements.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'list_elements', description: 'List numbered interactive elements of the current page.', parameters: { type: 'object', properties: {} } },
  { name: 'click_element', description: 'Click element by number.', parameters: { type: 'object', properties: { element_id: { type: 'integer' } }, required: ['element_id'] } },
  { name: 'type_into', description: 'Type normal text into element (never passwords/OTP).', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, text: { type: 'string' }, press_enter: { type: 'boolean' } }, required: ['element_id', 'text'] } },
  { name: 'select_option', description: 'Choose an option in a dropdown element.', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, option: { type: 'string' } }, required: ['element_id', 'option'] } },
  { name: 'scroll_page', description: 'Scroll down or up.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } } } },
  { name: 'read_page', description: 'Read visible text of the current page.', parameters: { type: 'object', properties: {} } },
  { name: 'look_at_screen', description: 'Take a screenshot of the current page and look at it.', parameters: { type: 'object', properties: {} } },
  { name: 'sign_in', description: 'Sign in on the current page with the saved login for this site: fills email/username + password and presses the sign-in button. You never see the password. Call when a login form is visible (call again on a second password page).', parameters: { type: 'object', properties: {} } },
  { name: 'upload_image', description: 'Put a generated image (image_id) into a file-upload element.', parameters: { type: 'object', properties: { element_id: { type: 'integer' }, image_id: { type: 'string' } }, required: ['element_id', 'image_id'] } },
  { name: 'finish', description: 'Task done (or impossible). Give the final short result for the user.', parameters: { type: 'object', properties: { result: { type: 'string' }, success: { type: 'boolean' } }, required: ['result', 'success'] } },
];

const MARK_JS = `(() => {
  document.querySelectorAll('[data-jn]').forEach(e => e.removeAttribute('data-jn'));
  const sel = 'a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=option],[contenteditable=true],label[for]';
  const out = []; let i = 0;
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect(); const st = getComputedStyle(e);
    const fileIn = e.tagName === 'INPUT' && e.type === 'file';
    if (!fileIn && (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none')) continue;
    if (!fileIn && (r.bottom < 0 || r.top > innerHeight * 2.5)) continue;
    e.setAttribute('data-jn', ++i);
    const t = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.name || '').trim().replace(/\\s+/g, ' ').slice(0, 70);
    const tag = e.tagName.toLowerCase() + (e.type ? ':' + e.type : '');
    out.push(i + ' ' + tag + ' "' + t + '"');
    if (i >= 120) break;
  }
  return out.join('\\n');
})()`;

export function siteKey(u) {
  const s = String(u || '').trim(); if (!s) return '';
  let h; try { h = new URL(/^[a-z]+:\/\//i.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  const p = h.split('.');
  if (p.length <= 2 || /^\d+$/.test(p[p.length - 1])) return h;
  const sl = p[p.length - 2];
  return (p[p.length - 1].length === 2 && /^(co|com|org|net|gov|ac|edu|gen|firm|ind)$/.test(sl)) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}

export async function webSearch(q) {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36' } });
  const h = await r.text(); const out = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m; while ((m = re.exec(h)) && out.length < 6) {
    let u = m[1]; const g = /uddg=([^&]+)/.exec(u); if (g) u = decodeURIComponent(g[1]);
    out.push({ title: m[2].replace(/<[^>]+>/g, ''), url: u, snippet: m[3].replace(/<[^>]+>/g, '') });
  }
  return out;
}

export async function readUrl(u) {
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36' }, redirect: 'follow' });
  const h = await r.text();
  return clip(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(), 6000);
}

function sysPrompt(task, nowIso) {
  return `You are JANUS Cloud, the background worker of the JANUS app. You run a scheduled task by yourself while the user's phone may be off, so nobody can answer questions: decide sensibly and finish.
Now: ${nowIso} (user timezone Asia/Kolkata).
Rules: use tools; be efficient (few steps, browser time is limited); in the browser use open_url, list_elements, click/type by element number; for login forms call sign_in (you never see passwords); if a site needs an OTP/captcha/approval you cannot do, call finish with success=false and say what is needed. Never invent results. Always end with finish(result) in the user's language (short Hinglish if the task is Hinglish).
TASK: ${task}`;
}

export async function runAgent(ctx, task, opts = {}) {
  const maxSteps = opts.maxSteps || 25;
  const steps = []; const images = [];
  let browser = null, page = null;
  const getPage = async () => {
    if (page) return page;
    browser = await ctx.browser();
    page = await browser.newPage();
    await page.setViewport({ width: 412, height: 860, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
    return page;
  };
  const el = async (id) => { const p = await getPage(); const h = await p.$(`[data-jn="${id}"]`); if (!h) throw new Error('element ' + id + ' not found; call list_elements'); return h; };
  const settle = async (p) => { try { await p.waitForNetworkIdle({ idleTime: 500, timeout: 6000 }); } catch { } };

  const impl = {
    web_search: async ({ query }) => S(await webSearch(query)),
    read_url: async ({ url }) => await readUrl(url),
    generate_image: async ({ prompt }) => {
      let b = null, mime = 'image/jpeg';
      if (ctx.genImage) { try { const g = await ctx.genImage(prompt); if (g) { b = g.bytes; mime = g.mime; } } catch (e) { } }
      if (!b) {
        const r = await fetch('https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=1024&height=1024&nologo=true&seed=' + Math.floor(Math.random() * 1e6));
        if (!r.ok) throw new Error('image service ' + r.status);
        b = new Uint8Array(await r.arrayBuffer()); mime = r.headers.get('content-type') || 'image/jpeg';
      }
      const id = await ctx.images.put(b, mime); images.push(id); return S({ image_id: id, bytes: b.length });
    },
    open_url: async ({ url }) => { const p = await getPage(); await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); await settle(p); return 'Title: ' + (await p.title()) + '\nURL: ' + p.url() + '\n' + (await p.evaluate(MARK_JS)); },
    list_elements: async () => { const p = await getPage(); return 'URL: ' + p.url() + '\n' + (await p.evaluate(MARK_JS)); },
    click_element: async ({ element_id }) => { const h = await el(element_id); const p = await getPage(); await h.evaluate(e => e.scrollIntoView({ block: 'center' })); await h.click(); await settle(p); return 'clicked. URL: ' + p.url() + '\n' + (await p.evaluate(MARK_JS)); },
    type_into: async ({ element_id, text, press_enter }) => {
      const h = await el(element_id); const typ = await h.evaluate(e => (e.type || '').toLowerCase());
      if (typ === 'password') return 'refused: use sign_in for passwords';
      await h.click({ clickCount: 3 }); await h.type(String(text), { delay: 10 });
      if (press_enter) { const p = await getPage(); await p.keyboard.press('Enter'); await settle(p); }
      return 'typed';
    },
    select_option: async ({ element_id, option }) => { const h = await el(element_id); const ok = await h.evaluate((e, o) => { const op = [...(e.options || [])].find(x => x.text.trim().toLowerCase() === o.toLowerCase() || x.value === o) || [...(e.options || [])].find(x => x.text.toLowerCase().includes(o.toLowerCase())); if (!op) return false; e.value = op.value; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; }, String(option)); return ok ? 'selected' : 'option not found'; },
    scroll_page: async ({ direction }) => { const p = await getPage(); await p.evaluate(d => scrollBy(0, (d === 'up' ? -1 : 1) * innerHeight * 0.85), direction || 'down'); return await p.evaluate(MARK_JS); },
    read_page: async () => { const p = await getPage(); return clip(await p.evaluate(() => document.body.innerText), 6000); },
    look_at_screen: async () => { const p = await getPage(); const b64 = await p.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64' }); return { text: 'screenshot attached', image: b64 }; },
    sign_in: async () => {
      const p = await getPage(); const site = siteKey(p.url()); const cred = await ctx.logins.get(site);
      if (!cred) return 'No saved login for ' + site + '. Ask the user (in finish) to add it in JANUS → Cloud tasks → Logins.';
      const r = await p.evaluate((u, pw) => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
        const set = (e, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); e.focus(); d.set.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
        const pass = [...document.querySelectorAll('input[type=password]')].find(vis);
        const user = [...document.querySelectorAll('input[type=email],input[autocomplete=username],input[name*=user i],input[name*=email i],input[id*=email i],input[type=text],input[type=tel]')].find(vis);
        let did = [];
        if (user && !user.value) { set(user, u); did.push('username'); }
        if (pass) { set(pass, pw); did.push('password'); }
        return did.join('+');
      }, cred.username, cred.password);
      if (!r) return 'No login field found on this page (open the site\'s sign-in form first, e.g. click "Log in").';
      const how = await p.evaluate(() => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
        const f = [...document.querySelectorAll('input[type=password],input[type=email],input[type=text]')].find(vis);
        const form = f && f.form;
        const btn = (form ? [...form.querySelectorAll('button,input[type=submit],[role=button]')] : [...document.querySelectorAll('button,input[type=submit],[role=button]')]).filter(vis)
          .find(b => /log ?in|sign ?in|next|continue|submit|aage|लॉग/i.test(b.innerText || b.value || b.getAttribute('aria-label') || '') || b.type === 'submit');
        if (btn) { btn.click(); return 'clicked ' + ((btn.innerText || btn.value || '').trim().slice(0, 30) || 'submit'); }
        if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'submitted form'; }
        return '';
      });
      if (!how) await p.keyboard.press('Enter');
      await settle(p); try { await p.waitForNavigation({ timeout: 3000 }); } catch { }
      return 'Filled ' + r + ' for ' + site + ' and ' + (how || 'pressed Enter') + '. Now on: ' + p.url() + ' — check with read_page/list_elements (if a password page appears next, call sign_in again).';
    },
    upload_image: async ({ element_id, image_id }) => {
      const img = await ctx.images.get(image_id); if (!img) throw new Error('unknown image_id');
      const h = await el(element_id); const b64 = btoaBytes(img.bytes);
      const ok = await h.evaluate((e, b, mime) => {
        const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        const f = new File([u], 'janus.' + (mime.includes('png') ? 'png' : 'jpg'), { type: mime });
        const dt = new DataTransfer(); dt.items.add(f);
        let inp = e.tagName === 'INPUT' && e.type === 'file' ? e : (e.querySelector('input[type=file]') || document.querySelector('input[type=file]'));
        if (inp) { inp.files = dt.files; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); return 'input'; }
        e.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt })); return 'drop';
      }, b64, img.mime);
      const p = await getPage(); await settle(p); return 'uploaded via ' + ok;
    },
  };

  const contents = [{ role: 'user', parts: [{ text: sysPrompt(task, new Date(ctx.now()).toISOString()) }] }];
  let result = null;
  try {
    for (let i = 0; i < maxSteps && !result; i++) {
      ctx.log && ctx.log('llm', {step: i});
      const resp = await ctx.llm(contents, TOOLS);
      const parts = resp.parts || [];
      contents.push({ role: 'model', parts });
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length) { const t = parts.map(p => p.text || '').join('').trim(); result = { success: !!t, result: t || 'No answer.' }; break; }
      const outs = [];
      for (const c of calls) {
        const { name, args = {} } = c.functionCall;
        if (name === 'finish') { result = { success: args.success !== false, result: String(args.result || '') }; break; }
        let out, img = null;
        ctx.log && ctx.log('call:' + name, args);
        try { const f = impl[name]; if (!f) throw new Error('unknown tool'); out = await f(args); if (out && typeof out === 'object') { img = out.image; out = out.text; } }
        catch (e) { out = 'ERROR: ' + (e && e.message || e); }
        steps.push({ tool: name, args: redact(args), out: clip(String(out), 200) });
        ctx.log && ctx.log(name, args, out);
        outs.push({ functionResponse: { name, response: { result: clip(String(out), 7000) } } });
        if (img) outs.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
      }
      if (!result) contents.push({ role: 'user', parts: outs });
    }
  } finally { try { if (browser) await browser.close(); } catch { } }
  if (!result) result = { success: false, result: 'Step limit reached before finishing.' };
  return { ...result, steps, images, model: ctx.lastModel && ctx.lastModel() };
}

function redact(a) { const o = { ...a }; if (o.text && String(o.text).length > 80) o.text = String(o.text).slice(0, 80) + '…'; return o; }
export function btoaBytes(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }

// ---- LLM: Gemini (fallback chain) then Workers AI ----
export function makeLLM({ geminiKey, ai, fetchImpl = fetch, models = GEMINI_MODELS, keyInHeader = true }) {
  let last = null;
  const llm = async (contents, tools) => {
    const errs = [];
    if (geminiKey !== null) for (const m of models) {
      const gemma = m.startsWith('gemma');
      const cts = (last && last !== m) ? contents.map(c => ({ role: c.role, parts: c.parts.map(p => p.thoughtSignature ? { ...p, thoughtSignature: 'skip_thought_signature_validator' } : p) })) : contents;
      const body = { contents: gemma ? cts.map(stripImg) : cts, tools: [{ functionDeclarations: tools }], generationConfig: { temperature: 0.3 } };
      const headers = { 'content-type': 'application/json' }; if (keyInHeader && geminiKey) headers['x-goog-api-key'] = geminiKey;
      try {
        const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers, body: S(body) });
        if (!r.ok) { errs.push(m + ':' + r.status); continue; }
        const j = await r.json(); const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
        if (!parts) { errs.push(m + ':empty'); continue; }
        last = m; return { parts };
      } catch (e) { errs.push(m + ':' + e.message); }
    }
    if (ai) { const r = await workersAI(ai, contents, tools); last = 'workers-ai'; return r; }
    throw new Error('All models failed: ' + errs.join(', '));
  };
  llm.lastModel = () => last;
  return llm;
}
function stripImg(c) { return { role: c.role, parts: c.parts.filter(p => !p.inlineData) }; }

const WAI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
async function workersAI(ai, contents, tools) {
  const messages = [];
  for (const c of contents) for (const p of c.parts) {
    if (p.text) messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: p.text });
    else if (p.functionCall) messages.push({ role: 'assistant', content: 'CALL ' + S(p.functionCall) });
    else if (p.functionResponse) messages.push({ role: 'user', content: 'RESULT of ' + p.functionResponse.name + ': ' + p.functionResponse.response.result });
  }
  const r = await ai.run(WAI_MODEL, { messages, tools: tools.map(t => ({ type: 'function', function: t })), max_tokens: 1200 });
  const tc = r.tool_calls || (r.response && r.response.tool_calls) || [];
  if (tc.length) return { parts: tc.slice(0, 1).map(t => ({ functionCall: { name: t.name || (t.function && t.function.name), args: typeof (t.arguments || (t.function && t.function.arguments)) === 'string' ? JSON.parse(t.arguments || t.function.arguments) : (t.arguments || {}) } })) };
  let txt = typeof r.response === 'string' ? r.response : S(r.response || r);
  const call = firstJsonCall(txt); if (call) return { parts: [{ functionCall: call }] };
  return { parts: [{ text: txt }] };
}

export function firstJsonCall(txt) {
  for (let i = txt.indexOf('{'); i >= 0; i = txt.indexOf('{', i + 1)) {
    let d = 0, inS = false, esc = false;
    for (let k = i; k < txt.length; k++) {
      const ch = txt[k];
      if (inS) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inS = false; continue; }
      if (ch === '"') inS = true; else if (ch === '{') d++; else if (ch === '}') { d--; if (d === 0) { try { const x = JSON.parse(txt.slice(i, k + 1)); if (x && x.name && TOOLS.some(t => t.name === x.name)) return { name: x.name, args: x.args || x.arguments || x.parameters || {} }; } catch { } break; } }
    }
  }
  return null;
}
