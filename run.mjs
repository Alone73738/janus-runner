// JANUS Cloud runner (GitHub Actions). Job arrives AES-256-GCM encrypted; everything goes back encrypted.
// Prints nothing but ok/fail, because logs of a public repo are public.
import puppeteer from 'puppeteer-core';
import { writeFileSync, statSync, readFileSync } from 'node:fs';
import { runAgent, makeRouter } from './agent.js';
import { CHROME, WD, images, sh, runCode, fs, testWebApp, setLLM } from './tools.mjs';

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
const base = job.cb.replace(/\/runner\/result$/, '');
const post = async (path, obj, raw) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: await seal(obj) }), signal: AbortSignal.timeout(60000) }); if (raw) return r; const j = await r.json(); if (!j.blob) throw new Error(path + ' ' + r.status); return open(j.blob); };
let pay = job; // tasks carry everything in the blob; chat jobs fetch their (bigger) payload
if (job.kind === 'chat') { try { pay = { ...job, ...(await post('/runner/job', { run: job.run })) }; } catch (e) { say('fail: payload'); process.exit(1); } }
const wait = (job.at || 0) - Date.now(); if (wait > 0) await sleep(Math.min(wait, 10 * 60000));
const started = Date.now();
let res, outCookies = null;
if (pay.ws) { // continuation: restore the work folder from the previous part
  try { const r = await post('/runner/ws', { run: job.run, id: pay.ws }, true); if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); writeFileSync('/tmp/ws.tgz', buf); await sh('tar', ['-xzf', '/tmp/ws.tgz', '-C', WD]); await sh('chmod', ['-R', 'a+rwX', WD]); } } catch { }
}
try {
  const ai = { run: async (model, input) => { const o = await post('/runner/ai', { run: job.run, model, input }); if (!o.ok) throw new Error(o.err); return o.out; } };
  const keys = { gemini: pay.gemini || null, ...(pay.oai || {}), ...(pay.keys || {}) };
  const llm = makeRouter({ keys, ai }); setLLM(llm);
  const sites = Object.keys(pay.logins || {});
  const keep = (c) => sites.some(s => { const d = String(c.domain || '').replace(/^\./, ''); return d === s || d.endsWith('.' + s); });
  let cookies = [];
  try { cookies = ((await post('/runner/state', { run: job.run })).cookies || []).filter(keep); } catch { }
  let lastP = 0;
  const ctx = {
    now: () => Date.now(), llm,
    browser: () => puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
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
    maxCodeSecs: pay.long || pay.kind === 'chat' ? 3000 : 600,
    fs, testWebApp,
    install: async (names) => {
      const run = (args, t) => sh('sudo', ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'timeout', String(t), ...args]);
      if (!globalThis.__aptUpdated) { await run(['apt-get', 'update', '-qq'], 300); globalThis.__aptUpdated = true; }
      const r = await run(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', ...names], 900);
      return (r.code === 0 ? 'Installed: ' + names.join(', ') : 'apt exit ' + r.code + '\n' + r.out.slice(-3000));
    },
    images: { put: async (bytes, mime) => { const id = 'img_' + rid(); images.set(id, { bytes, mime }); return id; }, get: async (id) => images.get(id) || null },
    progress: pay.kind === 'chat' ? async (info) => { // live status for the phone (+ cancel / new messages back)
      if (!info.shot && Date.now() - lastP < 1500) return null; lastP = Date.now();
      return await post('/runner/progress', { run: job.run, label: String(info.label || '').slice(0, 80), step: info.step | 0, shot: info.shot || null });
    } : undefined,
  };
  const budgetMs = pay.budgetMs || 320 * 60000; // GitHub job limit is 340 min: hand over to a fresh runner before it
  res = await runAgent(ctx, pay.text || pay.prompt, { maxSteps: pay.maxSteps || 60, job: !!pay.long, chat: pay.kind === 'chat' ? { history: pay.history || [], images: pay.images || [] } : null, budgetMs: pay.kind === 'chat' ? budgetMs : 0, state: pay.state || null });
} catch (e) { res = { success: false, result: 'Error: ' + (e && e.message || e), steps: [], images: [] }; }
const fileUrl = base + '/runner/file';
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
const steps = (res.steps || []).slice(-60);
const body = await seal({ run: job.run, ...res, steps, result: String(res.result || '').slice(0, 12000), images: imgs.slice(0, 6), cookies: outCookies, started, finished: Date.now() });
let last = '';
for (let i = 0; i < 4; i++) {
  try { const r = await fetch(job.cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: body }) }); if (r.ok) { say(res.cont ? 'ok: continue' : res.success ? 'ok' : 'fail'); process.exit(0); } last = 'http ' + r.status; } catch (e) { last = String(e && e.message || e).slice(0, 80); }
  await sleep(3000 * (i + 1));
}
try { // tell the app why, with a tiny body
  const small = await seal({ run: job.run, success: !!res.success, result: String(res.result || '').slice(0, 3000) + '\n\n(Report upload failed: ' + last + ')', files: outFiles, steps: [], images: [], started, finished: Date.now() });
  const r = await fetch(job.cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: small }) }); if (r.ok) { say('fail: big report'); process.exit(0); }
} catch { }
say('fail: callback'); process.exit(1);
