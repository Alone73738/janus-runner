// JANUS Cloud runner (GitHub Actions). Job arrives AES-256-GCM encrypted; result goes back encrypted.
// Prints nothing but ok/fail, because logs of a public repo are public.
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { runAgent, makeLLM } from './agent.js';

const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const quiet = () => {}; console.log = console.info = console.warn = console.debug = quiet; // nothing leaks to logs
const say = (s) => process.stdout.write(s + '\n');

async function key() { return crypto.subtle.importKey('raw', unb64(process.env.RUNNER_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(obj) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), enc.encode(JSON.stringify(obj)))); return b64(iv) + '.' + b64(ct); }
async function open(s) { const [iv, ct] = s.split('.'); return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(), unb64(ct)))); }

const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(p => p && existsSync(p));

// run_code: separate low-privilege user (nobody), empty env (no secrets), own folder, time limit.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, chmodSync } from 'node:fs';
const WD = '/tmp/janus-work'; const MIME = { apk: 'application/vnd.android.package-archive', aab: 'application/octet-stream', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', py: 'text/x-python', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html' };
async function runCode(lang, code, secs, ids, images) {
  mkdirSync(WD + '/inputs', { recursive: true }); chmodSync(WD, 0o777); chmodSync(WD + '/inputs', 0o777);
  for (const [id, im] of images) { const ext = (Object.entries(MIME).find(([, m]) => m === im.mime) || ['bin'])[0]; const f = `${WD}/inputs/${id}.${ext}`; try { statSync(f); } catch { writeFileSync(f, im.bytes); chmodSync(f, 0o644); } }
  const before = new Map(readdirSync(WD).map(n => [n, statSync(WD + '/' + n).mtimeMs]));
  const file = WD + '/_main.' + (lang === 'python' ? 'py' : lang === 'node' ? 'mjs' : 'sh'); writeFileSync(file, code); chmodSync(file, 0o644);
  const cmd = lang === 'python' ? ['python3', file] : lang === 'node' ? ['node', file] : ['bash', file];
  const pe = process.env; const extraPath = [pe.JAVA_HOME && pe.JAVA_HOME + '/bin', pe.ANDROID_HOME && pe.ANDROID_HOME + '/cmdline-tools/latest/bin', pe.ANDROID_HOME && pe.ANDROID_HOME + '/platform-tools', ...(String(pe.PATH || '').split(':'))].filter(Boolean).join(':');
  const env = ['HOME=' + WD, 'PATH=' + WD + '/.local/bin:' + extraPath, 'LANG=C.UTF-8', 'PYTHONUSERBASE=' + WD + '/.local', 'npm_config_cache=' + WD + '/.npm', 'MPLBACKEND=Agg'];
  for (const k of ['JAVA_HOME', 'JAVA_HOME_17_X64', 'JAVA_HOME_21_X64', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME', 'GRADLE_HOME']) if (pe[k]) env.push(k + '=' + pe[k]);
  env.push('GRADLE_USER_HOME=' + WD + '/.gradle', 'ANDROID_USER_HOME=' + WD + '/.android');
  const out = await new Promise((res) => {
    const pr = spawn('sudo', ['-n', '-u', 'nobody', 'env', '-i', ...env, 'timeout', String(secs), ...cmd], { cwd: WD, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; const add = (d) => { if (o.length < 200000) o += d.toString(); };
    pr.stdout.on('data', add); pr.stderr.on('data', add); pr.on('close', (c) => res({ code: c, out: o })); pr.on('error', (e) => res({ code: -1, out: String(e.message) }));
  });
  const files = [];
  for (const n of readdirSync(WD)) {
    if (n.startsWith('_main.') || n === 'inputs' || n.startsWith('.')) continue;
    let st; try { st = statSync(WD + '/' + n); } catch { continue; } if (!st.isFile() || before.get(n) === st.mtimeMs || st.size > 24e6) continue;
    const ext = n.split('.').pop().toLowerCase(); const mime = MIME[ext]; if (!mime) continue;
    const id = 'img_' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
    images.set(id, { bytes: new Uint8Array(readFileSync(WD + '/' + n)), mime, name: n }); files.push({ id, name: n, mime, bytes: st.size });
  }
  return { code: out.code, out: out.out, files };
}

let job;
try { job = await open(process.env.JOB || ''); } catch { say('fail: bad job'); process.exit(1); }
const wait = job.at - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 10 * 60000)));
const started = Date.now();
const images = new Map();
let res, outCookies = null;
try {
  const ai = { run: async (model, input) => { // Workers AI fallback through the JANUS worker (encrypted)
    const r = await fetch(job.cb.replace(/\/result$/, '/ai'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: await seal({ run: job.run, model, input }) }) });
    const j = await r.json(); if (!j.blob) throw new Error('ai ' + r.status); const o = await open(j.blob); if (!o.ok) throw new Error(o.err); return o.out; } };
  const llm = makeLLM({ geminiKey: job.gemini || null, ai, oai: job.oai || {} });
  const sites = Object.keys(job.logins || {});
  const keep = (c) => sites.some(s => String(c.domain || '').replace(/^\./, '').endsWith(s));
  let cookies = [];
  try { const r = await fetch(job.cb.replace(/\/result$/, '/state'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: await seal({ run: job.run }) }) }); const j = await r.json(); if (j.blob) cookies = ((await open(j.blob)).cookies || []).filter(keep); } catch { }
  const ctx = {
    now: () => Date.now(), llm, lastModel: llm.lastModel,
    browser: () => puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
    logins: { get: async (site) => (job.logins || {})[site] || null, list: async () => sites },
    cookies, saveCookies: async (all) => { outCookies = (all || []).filter(keep).map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, expires, httpOnly, secure, sameSite })); },
    genImage: job.gemini ? async (prompt) => {
      for (const m of ['gemini-3.1-flash-image', 'gemini-2.5-flash-image']) {
        try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': job.gemini }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }) });
          if (!r.ok) continue; const j = await r.json(); const im = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData); if (im) return { bytes: unb64(im.inlineData.data), mime: im.inlineData.mimeType || 'image/png' }; } catch { }
      }
      return null; } : undefined,
    genImage2: async (prompt) => { const o = await ai.run('@cf/black-forest-labs/flux-1-schnell', { prompt: prompt.slice(0, 2000), steps: 8 }); return o && o.image ? { bytes: unb64(o.image), mime: 'image/jpeg' } : null; },
    runCode: async (lang, code, secs, ids) => runCode(lang, code, secs, ids, images),
    maxCodeSecs: job.long ? 3000 : 600,
    install: async (names) => {
      const sh = (args, t) => new Promise((res) => { const pr = spawn('sudo', ['-n', 'env', 'DEBIAN_FRONTEND=noninteractive', 'timeout', String(t), ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; const add = d => { if (o.length < 20000) o += d; }; pr.stdout.on('data', add); pr.stderr.on('data', add); pr.on('close', c => res({ c, o })); pr.on('error', e => res({ c: -1, o: String(e.message) })); });
      if (!globalThis.__aptUpdated) { await sh(['apt-get', 'update', '-qq'], 300); globalThis.__aptUpdated = true; }
      const r = await sh(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', ...names], 900);
      return (r.c === 0 ? 'Installed: ' + names.join(', ') : 'apt exit ' + r.c + '\n' + r.o.slice(-3000));
    },
    images: { put: async (bytes, mime) => { const id = 'img_' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join(''); images.set(id, { bytes, mime }); return id; }, get: async (id) => images.get(id) || null },
  };
  res = await runAgent(ctx, job.prompt, { maxSteps: job.maxSteps || 60, job: !!job.long });
} catch (e) { res = { success: false, result: 'Error: ' + (e && e.message || e), steps: [], images: [] }; }
const imgs = (res.images || []).map(id => images.get(id) && { id, mime: images.get(id).mime, b64: b64(images.get(id).bytes) }).filter(Boolean);
let budget = 60e6; const outFiles = [];
for (const id of (res.files || []).slice(-8).reverse()) { const f = images.get(id); if (!f || f.bytes.length > budget) continue; budget -= f.bytes.length; outFiles.push({ id, name: f.name || id, mime: f.mime, b64: b64(f.bytes) }); }
res.files = outFiles;
const body = await seal({ run: job.run, ...res, images: imgs, cookies: outCookies, started, finished: Date.now() });
for (let i = 0; i < 4; i++) {
  try { const r = await fetch(job.cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: body }) }); if (r.ok) { say(res.success ? 'ok' : 'fail'); process.exit(0); } } catch { }
  await new Promise(r => setTimeout(r, 3000 * (i + 1)));
}
say('fail: callback'); process.exit(1);
