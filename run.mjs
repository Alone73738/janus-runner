// JANUS Cloud runner (GitHub Actions). Job arrives AES-256-GCM encrypted; everything goes back encrypted.
// Prints nothing but ok/fail, because logs of a public repo are public.
// v5.2 (Cloud 3.2.0): WARM runner. Chrome starts at once, then the runner claims chat jobs from the Worker one after
// another and stays warm for a few minutes after each job (follow-ups start instantly). While a job runs, a LIVE loop
// streams the tab list + a screenshot of the tab the phone is looking at (~1 fps when watched, 4 fps while the user
// types), and applies the user's taps / typing / paste / scroll to the cloud browser. New messages + Stop are read by
// every request (nothing is dropped any more).
import puppeteer from 'puppeteer-core';
import { writeFileSync, statSync, readFileSync } from 'node:fs';
import { runAgent, makeRouter, closeAllTabs } from './agent.js';
import { CHROME, WD, images, sh, runCode, fs, testWebApp, setLLM, prepChromeExts, download, skills, installs, pipInstall, npmInstall, wsSummary, packHome, fsx } from './tools.mjs';
import { MCP, mcpText, cleanSchema, toolName } from './mcp.js';
import { mkdirSync as mkdirS, existsSync as existsS } from 'node:fs';
import { freemem } from 'node:os';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const quiet = () => {}; if (!process.env.JANUS_DEBUG) console.log = console.info = console.warn = console.debug = console.error = quiet; // nothing leaks to logs
const say = (s) => process.stdout.write(s + '\n');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rid = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');

async function key() { return crypto.subtle.importKey('raw', unb64(process.env.RUNNER_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), enc.encode(JSON.stringify(obj)))); return b64(iv) + '.' + b64(ct); }
async function open(s) { const [iv, ct] = s.split('.'); return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(), unb64(ct)))); }

// ---------------- main ----------------
let job;
try { job = await open(process.env.JOB || ''); } catch { say('fail: bad job'); process.exit(1); }
const base = process.env.JANUS_CB_BASE || job.cb.replace(/\/runner\/result$/, ''); // (env override = local tests only)
if (process.env.JANUS_CB_BASE) job.cb = base + '/runner/result';
const post = async (path, obj, raw) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: await seal(obj) }), signal: AbortSignal.timeout(60000) }); if (raw) return r; const j = await r.json(); if (!j.blob) throw new Error(path + ' ' + r.status); return open(j.blob); };
const WARM = job.kind === 'warm' || job.kind === 'chat';
const launch = (exe, args = []) => puppeteer.launch({ executablePath: exe || CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...args] });
let warmBrowser = WARM ? launch().catch(() => null) : null; // Chrome is ready before the first job arrives

const ED_JS = `(() => { const W = innerWidth, H = innerHeight, o = []; for (const e of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]),textarea,[contenteditable=""],[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]')) { const r = e.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) continue; const s = getComputedStyle(e); if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue; o.push([+(r.left / W).toFixed(4), +(r.top / H).toFixed(4), +(r.width / W).toFixed(4), +(r.height / H).toFixed(4)]); if (o.length >= 40) break; } return o; })()`;
const FOCUS_JS = `(() => { const e = document.activeElement; if (!e || e === document.body) return null; const ed = e.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.tagName) && !/^(button|submit|checkbox|radio|file|range|color)$/i.test(e.type || ''); return { editable: !!ed, pw: (e.type || '') === 'password' }; })()`;

async function runJob(pay, jobId, carry) {
  const started = Date.now();
  let res, outCookies = null;
  if (pay.ws) { // continuation: restore the work folder from the previous part
    try { const r = await post('/runner/ws', { run: job.run, id: pay.ws }, true); if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); writeFileSync('/tmp/ws.tgz', buf); await sh('tar', ['-xzf', '/tmp/ws.tgz', '-C', WD]); await sh('chmod', ['-R', 'a+rwX', WD]); } } catch { }
  }
  const chat = pay.kind === 'chat';
  // v5.3: the user's persistent workspace (files, skills, remembered installs) → into the work folder once per runner
  let replay = Promise.resolve();
  if (pay.home && pay.home.ts && globalThis.__homeTs !== pay.home.ts && !pay.ws) {
    try { const r = await post('/runner/blob', { run: job.run, id: 'home' }, true); if (r.ok) { writeFileSync('/tmp/home-in.tgz', Buffer.from(await r.arrayBuffer())); await sh('tar', ['-xzf', '/tmp/home-in.tgz', '-C', WD]); await sh('chmod', ['-R', 'a+rwX', WD]); globalThis.__homeTs = pay.home.ts; globalThis.__homeHash = pay.home.hash; } } catch { }
    const ins = installs.get(); // reinstall what this user installed before (fresh machine), in the background
    replay = (async () => { try { if ((ins.apt || []).length) await aptInstall(ins.apt); if ((ins.pip || []).length) await pipInstall(ins.pip); if ((ins.npm || []).length) await npmInstall(ins.npm); } catch { } })();
  }
  const attached = [];
  for (const f of (pay.files || []).slice(0, 6)) { // chat attachments (video/audio/zip…) → ./inputs/<name>
    try { const r = await post('/runner/blob', { run: job.run, id: f.id }, true); if (!r.ok) continue; mkdirS(WD + '/inputs', { recursive: true }); let nm = String(f.name || f.id).replace(/[^\w.\- ]/g, '_'); writeFileSync(WD + '/inputs/' + nm, Buffer.from(await r.arrayBuffer())); attached.push('inputs/' + nm + ' (' + (f.mime || '?') + ', ' + Math.round((f.size || 0) / 1024) + ' KB)'); } catch { }
  }
  let ctx = null, liveStop = false, liveP = null, cancelRes = null; const cancelWait = new Promise(r => { cancelRes = r; });
  try {
    const ai = { run: async (model, input) => { const o = await post('/runner/ai', { run: job.run, model, input }); if (!o.ok) throw new Error(o.err); return o.out; } };
    const keys = { gemini: pay.gemini || null, ...(pay.oai || {}), ...(pay.keys || {}) };
    const diag = []; const jt0 = Date.now(); const llm = makeRouter({ keys, ai, log: (k, v) => { const l = '+' + ((Date.now() - jt0) / 1000).toFixed(1) + 's ' + k + ' ' + String(v).slice(0, 120); diag.push(l); if (diag.length > 40) diag.shift(); say('llm ' + l); } }); setLLM(llm); globalThis.__diag = diag; // v5.4 timeline
    const sites = Object.keys(pay.logins || {});
    const keep = (c) => sites.some(s => { const d = String(c.domain || '').replace(/^\./, ''); return d === s || d.endsWith('.' + s); });
    let cookies = [];
    try { cookies = ((await post('/runner/state', { run: job.run })).cookies || []).filter(keep); } catch { }
    let lastP = 0;
    let chromeX = null; try { if ((pay.chromeExts || []).length) chromeX = await prepChromeExts(pay.chromeExts); } catch { }
    // every Worker answer goes through here: Stop, new messages, the tab the phone looks at, the user's taps/keys
    const handle = (o) => {
      if (!o || !ctx) return o;
      if (o.cancel && !ctx.cancelled) { ctx.cancelled = true; cancelRes(); closeAllTabs(ctx).catch(() => { }); }
      if (Array.isArray(o.inbox) && o.inbox.length) { ctx.inbox.push(...o.inbox); ctx.inboxAll.push(...o.inbox); }
      delete o.inbox;
      if ('view' in o) ctx.view = o.view || null;
      if (Array.isArray(o.inputs) && o.inputs.length) ctx.inputs.push(...o.inputs);
      if ('watching' in o) ctx.watching = !!o.watching;
      if ('interactive' in o) ctx.interactive = !!o.interactive;
      return o;
    };
    ctx = {
      extensions: pay.extensions || [],
      now: () => Date.now(), llm, inbox: [], inboxAll: [], inputs: [], tabs: carry ? carry.tabs : [], _tabN: carry ? carry.n : 0, activeTab: carry ? carry.active : null, cancelled: false, pausedUntil: 0, view: null, watching: true, interactive: false,
      browser: async () => { if (chromeX) return launch(chromeX.exe, chromeX.args); if (warmBrowser) { const b = await warmBrowser; if (b && b.connected !== false) return b; } warmBrowser = launch(); return warmBrowser; },
      logins: { get: async (site) => (pay.logins || {})[site] || null, list: async () => sites },
      cookies, saveCookies: async (all) => { outCookies = (all || []).filter(keep).map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, expires, httpOnly, secure, sameSite })); },
      genImage: keys.gemini ? async (prompt) => {
        for (const m of ['gemini-3.1-flash-image', 'gemini-2.5-flash-image']) {
          try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': keys.gemini }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }) });
            if (!r.ok) continue; const j = await r.json(); const im = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData); if (im) return { bytes: unb64(im.inlineData.data), mime: im.inlineData.mimeType || 'image/png' }; } catch { }
        }
        return null; } : undefined,
      genImage2: async (prompt) => { const o = await ai.run('@cf/black-forest-labs/flux-1-schnell', { prompt: prompt.slice(0, 2000), steps: 8 }); return o && o.image ? { bytes: unb64(o.image), mime: 'image/jpeg' } : null; },
      runCode: async (lang, code, secs, ids) => runCode(lang, code, secs, ids, images),
      maxCodeSecs: pay.long || chat ? 3000 : 600,
      fs, testWebApp, download, memFree: () => freemem(), subPages: 12,
      install: async (names, more = {}) => { // apt + pip + npm; remembered in the workspace and replayed on a fresh machine
        await replay; const out = [];
        if (names && names.length) { const r = await aptInstall(names); out.push(r.code === 0 ? 'apt: installed ' + names.join(', ') : 'apt exit ' + r.code + '\n' + r.out.slice(-2500)); if (r.code === 0) installs.add('apt', names); }
        if ((more.pip || []).length) { const r = await pipInstall(more.pip); out.push(r.code === 0 ? 'pip: installed ' + more.pip.join(', ') : 'pip exit ' + r.code + '\n' + r.out.slice(-2500)); if (r.code === 0) installs.add('pip', more.pip); }
        if ((more.npm || []).length) { const r = await npmInstall(more.npm); out.push(r.code === 0 ? 'npm: installed ' + more.npm.join(', ') : 'npm exit ' + r.code + '\n' + r.out.slice(-2500)); if (r.code === 0) installs.add('npm', more.npm); }
        return out.join('\n') || 'Nothing to install.';
      },
      ready: () => replay,
      shell: async (cmd, secs) => { await replay; return runCode('bash', cmd, secs, [], images); },
      fsx, skills, ws: wsSummary, attached,
      card: chat ? async (t, k) => { try { handle(await post('/runner/progress', { run: job.run, job: jobId, card: String(t).slice(0, 90), ck: k || 'ok' })); } catch { } } : null,
      mcpTools: [], mcpCall: null,
      images: { put: async (bytes, mime) => { const id = 'img_' + rid(); images.set(id, { bytes, mime }); return id; }, get: async (id) => images.get(id) || null },
      progress: chat ? async (info) => { // status line for the phone (+ Stop / new messages back)
        if (!info.shot && !info.agents && !info.intro && !info.ack && Date.now() - lastP < 700) return null; lastP = Date.now();
        return handle(await post('/runner/progress', { run: job.run, job: jobId, label: String(info.label || '').slice(0, 80), kind: info.kind || null, intro: info.intro || null, ack: info.ack || null, card: info.card || null, ck: info.ck || null, step: info.step | 0, shot: info.shot || null, agents: info.agents || null }));
      } : undefined,
    };
    // ---------- LIVE: tabs + screenshots out, taps/keys in ----------
    const snap = async (t, scale) => { // one tab → jpeg (viewport, scaled) + editable boxes
      if (!t || !t.page) return null;
      try { const p = t.page; const vp = p.viewport() || { width: 1280, height: 900 }; const c = await p.createCDPSession(); const { data } = await c.send('Page.captureScreenshot', { format: 'jpeg', quality: scale > 0.4 ? 55 : 42, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale } }); await c.detach().catch(() => { }); let ed = []; try { ed = await p.evaluate(ED_JS); } catch { } t.last = { b64: data, ed, w: vp.width, h: vp.height }; return t.last; } catch { return null; }
    };
    ctx.snapTab = async (t) => { await snap(t, 0.5); };
    const tabFor = (id) => (ctx.tabs || []).find(t => t.id === id) || null;
    let lastInputAt = 0, wantHandback = false, rr = 0, tick = 0, forceNow = false, sentAt = {};
    const applyInputs = async () => {
      const evs = ctx.inputs.splice(0); if (!evs.length) return null; let focus, clip;
      for (const e of evs) {
        const t = tabFor(e.tab) || tabFor(ctx.view) || tabFor(ctx.activeTab); const p = t && t.page; if (!p) continue;
        if (e.t !== 'handback') { lastInputAt = Date.now(); ctx.pausedUntil = Date.now() + 20000; wantHandback = true; }
        try {
          const vp = p.viewport() || { width: 1280, height: 900 };
          if (e.t === 'tap') { await p.mouse.click(Math.round(e.x * vp.width), Math.round(e.y * vp.height)); await sleep(120); focus = { tab: t.id, ...(await p.evaluate(FOCUS_JS).catch(() => null) || { editable: false }) }; }
          else if (e.t === 'type' && e.s) { const f = await p.evaluate(FOCUS_JS).catch(() => null); if (f && f.pw) continue; await p.keyboard.type(e.s, { delay: 0 }); }
          else if (e.t === 'key' && /^(Enter|Backspace|Tab|Escape|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Delete|Home|End)$/.test(e.k || '')) await p.keyboard.press(e.k);
          else if (e.t === 'scroll') await p.mouse.wheel({ deltaY: Math.max(-4000, Math.min(4000, e.dy || 0)), deltaX: Math.max(-4000, Math.min(4000, e.dx || 0)) });
          else if (e.t === 'back') await p.goBack({ timeout: 8000 }).catch(() => { });
          else if (e.t === 'selall') { await p.keyboard.down('Control'); await p.keyboard.press('KeyA'); await p.keyboard.up('Control'); }
          else if (e.t === 'copy') clip = String(await p.evaluate(() => { const a = document.activeElement; if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== 'password') { const s = a.value.slice(a.selectionStart || 0, a.selectionEnd || 0); return s || a.value; } return String(getSelection() || ''); }).catch(() => '') || '');
          else if (e.t === 'handback') { ctx.pausedUntil = 0; }
          ctx.view = t.id;
        } catch { }
      }
      if (!ctx.session && (evs.some(e => e.t === 'handback') || (wantHandback && Date.now() - lastInputAt > 20000))) { if (wantHandback) { wantHandback = false; ctx.pausedUntil = 0; ctx.inbox.push('(I used the browser myself for a moment. Look at the current page again before you continue; it may have changed.)'); } }
      forceNow = true; return { focus, clip };
    };
    const liveTick = async () => {
      const io = await applyInputs();
      const focusId = (ctx.view && tabFor(ctx.view)) ? ctx.view : ctx.activeTab;
      const shots = []; const ft = tabFor(focusId);
      const due = ctx.watching || forceNow || tick % 4 === 0;
      if (ft && due) { const s = ft.page ? await snap(ft, 0.5) : ft.last; if (s && (ft.page || sentAt[ft.id] !== 'last')) { shots.push({ tab: ft.id, ...s }); if (!ft.page) sentAt[ft.id] = 'last'; } }
      if (tick % 3 === 1) { const others = (ctx.tabs || []).filter(t => t.page && t.id !== focusId); if (others.length) { const o = others[rr++ % others.length]; const s = await snap(o, 0.32); if (s) shots.push({ tab: o.id, ...s }); } }
      forceNow = false; tick++;
      const body = { diag: (globalThis.__diag || []).slice(-24), run: job.run, job: jobId, session: !!ctx.session, tabs: (ctx.tabs || []).map(t => ({ id: t.id, t: t.t, u: t.u, s: t.closed && t.s === 'run' ? 'done' : t.s, o: t.owner, ts: t.ts })), active: ctx.activeTab || null, shots };
      if (io && io.focus) body.focus = io.focus; if (io && typeof io.clip === 'string') body.clip = io.clip;
      try { handle(await post('/runner/live', body)); } catch { }
    };
    ctx.snapNow = async () => { forceNow = true; await liveTick(); };
    if (chat) liveP = (async () => { while (!liveStop && !(ctx.session && ctx.session.stop)) { const t0 = Date.now(); try { await liveTick(); } catch { } const iv = ctx.interactive || ctx.inputs.length ? 250 : ctx.watching ? 800 : 2500; const w = iv - (Date.now() - t0); if (w > 0) await Promise.race([sleep(w), new Promise(r => { ctx._wake = r; })]); } })();
    const budgetMs = pay.budgetMs || 320 * 60000; // GitHub job limit is 340 min: hand over to a fresh runner before it
    // v5.3: MCP servers the user connected → extra tools (mcp_<server>_<tool>)
    if ((pay.mcp || []).length) {
      const conns = {}; const map = {};
      await Promise.all(pay.mcp.slice(0, 8).map(async (sv) => { try { const c = new MCP(sv.url, sv.headers || {}); const tl = await Promise.race([c.tools(), sleep(8000).then(() => { throw new Error('timeout'); })]); conns[sv.name] = c; for (const t of tl.slice(0, 40)) { const n = toolName(sv.name, t.name); map[n] = { sv: sv.name, tool: t.name }; ctx.mcpTools.push({ name: n, description: ('[MCP ' + sv.name + '] ' + String(t.description || t.name)).slice(0, 900), parameters: cleanSchema(t.inputSchema || { type: 'object', properties: {} }) }); } } catch { } }));
      ctx.mcpCall = async (n, args) => { const m = map[n]; if (!m) return 'unknown MCP tool'; try { return mcpText(await conns[m.sv].call(m.tool, args)); } catch (e) { return 'MCP error: ' + String(e.message || e).slice(0, 300); } };
    }
    const agentP = runAgent(ctx, pay.text || pay.prompt, { maxSteps: pay.maxSteps || 60, job: !!pay.long, chat: chat ? { history: pay.history || [], images: pay.images || [] } : null, budgetMs: chat ? budgetMs : 0, state: pay.state || null, keepBrowser: WARM && !chromeX });
    res = await Promise.race([agentP, cancelWait.then(() => ({ success: false, result: 'Stopped by you.', steps: [], images: [], cancelled: true }))]);
    if (res.cancelled) { const settled = await Promise.race([agentP.then(() => true, () => true), sleep(3000).then(() => false)]); if (!settled) res.zombie = true; } // a zombie agent (stuck in a model call) has ctx.cancelled and exits before touching any tab; the runner stays warm
  } catch (e) { res = { success: false, result: 'Error: ' + (e && e.message || e), steps: [], images: [] }; }
  // final frames; the pages stay open (warm runner): the user can keep tapping/typing in them and the next message
  // continues in the same browser. They close when the runner goes idle-exit or the job was stopped.
  let finalTabs = null; const keepTabs = WARM && !chromeXUsed(pay) && ctx && !ctx.cancelled;
  if (ctx && chat) {
    if (!keepTabs) { liveStop = true; if (ctx._wake) ctx._wake(); try { await liveP; } catch { } }
    try { const ft = (ctx.tabs || []).find(t => t.id === ((ctx.view && ctx.tabs.find(x => x.id === ctx.view)) ? ctx.view : ctx.activeTab)); const shots = []; if (ft) { const s = ft.page ? await snap(ft, 0.5) : ft.last; if (s) shots.push({ tab: ft.id, ...s }); }
      finalTabs = { tabs: (ctx.tabs || []).map(t => ({ id: t.id, t: t.t, u: t.u, s: t.s === 'run' ? (res.success ? 'done' : 'fail') : t.s, o: t.owner, ts: t.ts })), active: ft ? ft.id : null, shots }; } catch { }
    if (!keepTabs) { try { await closeAllTabs(ctx); } catch { } }
    else ctx.session = { stop: false, end: async () => { ctx.session.stop = true; if (ctx._wake) ctx._wake(); try { await liveP; } catch { } } };
  }
  const fileUrl = base + '/runner/file';
  const saveHome = async () => { // v5.3: keep the workspace for the next chat (only when it changed)
    try { const pk = await packHome(globalThis.__homeHash); if (!pk || pk.unchanged || pk.hash === globalThis.__homeHash) return; const id = await upload({ bytes: readFileSync(pk.path), mime: 'application/gzip' }, 'home.tgz'); const o = await post('/runner/blob', { run: job.run, op: 'put-home', id, hash: pk.hash, files: pk.files }, true); if (o.ok) { globalThis.__homeHash = pk.hash; globalThis.__homeTs = Date.now(); } } catch { }
  };
  const upload = async (f, name) => { const q = new URLSearchParams({ run: job.run, t: job.ft, name: name || f.name || 'file', mime: f.mime || 'application/octet-stream' }); const r = await fetch(fileUrl + '?' + q, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: f.bytes }); if (!r.ok) throw new Error('upload ' + r.status); return (await r.json()).id; };
  if (res.cont) { // pack the work folder for the next runner (≤ 24 MB)
    try { const t = await sh('tar', ['--exclude=./.gradle', '--exclude=./.npm', '--exclude=./node_modules', '--exclude=*/node_modules', '--exclude=./.cache', '--exclude=./.android', '-czf', '/tmp/out-ws.tgz', '-C', WD, '.']); const st = statSync('/tmp/out-ws.tgz'); if (t.code === 0 && st.size < 24e6) res.cont.ws = await upload({ bytes: readFileSync('/tmp/out-ws.tgz'), mime: 'application/gzip' }, 'workspace.tgz'); } catch { }
    let s = JSON.stringify(res.cont.contents); while (s.length > 1200000 && res.cont.contents.length > 16) { res.cont.contents.splice(1, 4); s = JSON.stringify(res.cont.contents); }
  }
  const imgs = (res.images || []).map(id => images.get(id) && { id, mime: images.get(id).mime, b64: b64(images.get(id).bytes) }).filter(Boolean);
  const outFiles = [];
  const seenNames = new Set(); for (const id of (res.files || []).slice().reverse()) { const f = images.get(id); const nm = f && f.name; if (!nm || seenNames.has(nm) || seenNames.size >= 8 || !job.ft) continue; seenNames.add(nm);
    try { outFiles.push({ id: await upload(f), name: nm, mime: f.mime, bytes: f.bytes.length }); } catch { } }
  res.files = outFiles;
  // v6.0: the workspace is saved AFTER the reply is posted (packing + uploading home.tgz used to delay every reply by seconds)
  const steps = (res.steps || []).slice(-60);
  const stay = WARM && !chromeXUsed(pay);
  const body = await seal({ run: job.run, job: jobId, stay, ...res, steps, result: String(res.result || '').slice(0, 12000), images: imgs.slice(0, 6), cookies: outCookies, started, finished: Date.now(), ...(finalTabs || {}) });
  let last = '';
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(job.cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: body }) }); if (r.ok) { say(res.cont ? 'ok: continue' : res.success ? 'ok' : 'fail'); if (chat && !res.cont) { const th = Date.now(); await saveHome(); say('home saved in ' + (Date.now() - th) + ' ms'); } return stay ? (ctx && ctx.session ? ctx : true) : false; } last = 'http ' + r.status; } catch (e) { last = String(e && e.message || e).slice(0, 80); }
    await sleep(3000 * (i + 1));
  }
  try { // tell the app why, with a tiny body
    const small = await seal({ run: job.run, job: jobId, stay, success: !!res.success, result: String(res.result || '').slice(0, 3000) + '\n\n(Report upload failed: ' + last + ')', files: outFiles, steps: [], images: [], started, finished: Date.now() });
    const r = await fetch(job.cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: small }) }); if (r.ok) { say('fail: big report'); return stay ? (ctx && ctx.session ? ctx : true) : false; }
  } catch { }
  say('fail: callback'); return false;
}
async function aptInstall(names) {
  const run = (args, t) => sh('sudo', ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'timeout', String(t), ...args]);
  if (!globalThis.__aptUpdated) { await run(['apt-get', 'update', '-qq'], 300); globalThis.__aptUpdated = true; }
  return run(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', ...names], 900);
}
function chromeXUsed(pay) { return !!(pay.chromeExts || []).length; }

if (!WARM) { // scheduled task / long job: everything is in the blob; run once
  const wait = (job.at || 0) - Date.now(); if (wait > 0) await sleep(Math.min(wait, 10 * 60000));
  const ok = await runJob(job, null); process.exit(0);
}
// warm loop: claim → run → stay warm → claim … → exit when idle too long (the Worker decides)
let fails = 0; const t0 = Date.now(); let session = null; // session = ctx of the last job whose tabs are still open + live
while (Date.now() - t0 < 330 * 60000) {
  let o = null;
  try { o = await post('/runner/claim', { run: job.run }); fails = 0; } catch { if (++fails > 20) break; await sleep(2000); continue; }
  if (o.exit) break;
  if (o.job && o.pay) {
    images.clear && images.clear();
    let carry = null;
    if (session) { await session.session.end(); const open = (session.tabs || []).filter(t => t.page); carry = open.length ? { tabs: open, n: session._tabN || 0, active: open.some(t => t.id === session.activeTab) ? session.activeTab : open[open.length - 1].id } : null; session = null; }
    const stay = await runJob({ ...o.pay, kind: 'chat' }, o.job, carry);
    if (!stay) { try { const b = await warmBrowser; if (b) await b.close(); } catch { } process.exit(0); }
    if (stay && stay.session) session = stay;
    continue;
  }
  await sleep(o.busy ? 2000 : 900);
}
if (session) { try { await session.session.end(); await closeAllTabs(session); } catch { } }
try { await post('/runner/bye', { run: job.run }); } catch { }
try { const b = await warmBrowser; if (b) await b.close(); } catch { }
say('ok: idle exit'); process.exit(0);
