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

let job;
try { job = await open(process.env.JOB || ''); } catch { say('fail: bad job'); process.exit(1); }
const wait = job.at - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 10 * 60000)));
const started = Date.now();
const images = new Map();
let res;
try {
  const ai = { run: async (model, input) => { // Workers AI fallback through the JANUS worker (encrypted)
    const r = await fetch(job.cb.replace(/\/result$/, '/ai'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: await seal({ run: job.run, model, input }) }) });
    const j = await r.json(); if (!j.blob) throw new Error('ai ' + r.status); const o = await open(j.blob); if (!o.ok) throw new Error(o.err); return o.out; } };
  const llm = makeLLM({ geminiKey: job.gemini || null, ai });
  const ctx = {
    now: () => Date.now(), llm, lastModel: llm.lastModel,
    browser: () => puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] }),
    logins: { get: async (site) => (job.logins || {})[site] || null },
    images: { put: async (bytes, mime) => { const id = 'img_' + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join(''); images.set(id, { bytes, mime }); return id; }, get: async (id) => images.get(id) || null },
  };
  res = await runAgent(ctx, job.prompt, { maxSteps: job.maxSteps || 40 });
} catch (e) { res = { success: false, result: 'Error: ' + (e && e.message || e), steps: [], images: [] }; }
const imgs = (res.images || []).map(id => images.get(id) && { id, mime: images.get(id).mime, b64: b64(images.get(id).bytes) }).filter(Boolean);
const body = await seal({ run: job.run, ...res, images: imgs, started, finished: Date.now() });
for (let i = 0; i < 4; i++) {
  try { const r = await fetch(job.cb, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: body }) }); if (r.ok) { say(res.success ? 'ok' : 'fail'); process.exit(0); } } catch { }
  await new Promise(r => setTimeout(r, 3000 * (i + 1)));
}
say('fail: callback'); process.exit(1);
